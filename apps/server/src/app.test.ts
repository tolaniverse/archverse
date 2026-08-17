import { describe, expect, test } from "bun:test";
import { emptyArchitectureDocument } from "@archverse/architecture-model";
import { assertProductionConfig, createApp } from "./app";
import {
  SESSION_COOKIE,
  securityCookieNames,
  type AppConfig,
  type GithubClient,
} from "./auth";
import type {
  Project,
  ProjectCreate,
  ProjectUpdate,
  Subscription,
  User,
} from "./domain";
import type { Store } from "./store";

const user: User = {
  id: "22222222-2222-4222-8222-222222222222",
  githubId: "12345",
  githubLogin: "architect",
  avatarUrl: null,
};
const otherUser: User = { ...user, id: "33333333-3333-4333-8333-333333333333" };
const config: AppConfig = {
  appUrl: "http://localhost:3000",
  webUrl: "http://localhost:5173",
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  secureCookies: false,
  openAiEnabled: false,
};

class FakeStore implements Store {
  currentUser: User | null = user;
  healthy = true;
  subscription: Subscription | null = null;
  projects: Project[] = [];
  sessionHash: string | null = null;
  githubInput: {
    githubId: string;
    githubLogin: string;
    avatarUrl: string | null;
  } | null = null;

  async ping() {
    if (!this.healthy) throw new Error("unavailable");
  }
  async upsertGithubUser(input: {
    githubId: string;
    githubLogin: string;
    avatarUrl: string | null;
  }) {
    this.githubInput = input;
    return user;
  }
  async createSession(input: {
    tokenHash: string;
    userId: string;
    expiresAt: Date;
  }) {
    this.sessionHash = input.tokenHash;
  }
  async getUserBySessionHash() {
    return this.currentUser;
  }
  async deleteSession() {
    this.sessionHash = null;
  }
  async getSubscription() {
    return this.subscription;
  }
  async createProject(ownerId: string, input: ProjectCreate) {
    const project: Project = {
      id: crypto.randomUUID(),
      ownerId,
      ...input,
      revision: 1,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };
    this.projects.push(project);
    return project;
  }
  async listProjects(ownerId: string) {
    return this.projects.filter((project) => project.ownerId === ownerId);
  }
  async getProject(id: string) {
    return this.projects.find((project) => project.id === id) ?? null;
  }
  async updateProject(id: string, ownerId: string, input: ProjectUpdate) {
    const index = this.projects.findIndex(
      (project) => project.id === id && project.ownerId === ownerId,
    );
    if (index < 0) return null;
    const current = this.projects[index]!;
    if (current.revision !== input.revision) return "conflict" as const;
    const next: Project = {
      ...current,
      title: input.title ?? current.title,
      visibility: input.visibility ?? current.visibility,
      document: input.document ?? current.document,
      revision: current.revision + 1,
      updatedAt: new Date("2026-01-02"),
    };
    this.projects[index] = next;
    return next;
  }
  async deleteProject(id: string, ownerId: string, revision: number) {
    const project = this.projects.find(
      (candidate) => candidate.id === id && candidate.ownerId === ownerId,
    );
    if (!project) return null;
    if (project.revision !== revision) return "conflict" as const;
    this.projects = this.projects.filter((candidate) => candidate.id !== id);
    return "deleted" as const;
  }
}

const github: GithubClient = {
  async exchangeCode() {
    return { id: "987654321", login: "octocat", avatarUrl: null };
  },
};

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", `${SESSION_COOKIE}=test-session`);
  if (init.method && !["GET", "HEAD"].includes(init.method)) {
    headers.set("origin", config.webUrl);
  }
  return new Request(`${config.appUrl}${path}`, { ...init, headers });
}

function projectBody(visibility: "public" | "private") {
  return {
    title: "Queue service",
    visibility,
    document: emptyArchitectureDocument("Queue service"),
  };
}

describe("server routes", () => {
  test("keeps health and anonymous demo planning available", async () => {
    const store = new FakeStore();
    const app = createApp({ store, config, github });
    const health = await app.handle(new Request(`${config.appUrl}/health`));
    expect(health.status).toBe(200);
    expect(
      (await app.handle(new Request(`${config.appUrl}/ready`))).status,
    ).toBe(200);
    store.healthy = false;
    expect(
      (await app.handle(new Request(`${config.appUrl}/ready`))).status,
    ).toBe(503);
    expect(
      (
        await createApp({ config, github }).handle(
          new Request(`${config.appUrl}/ready`),
        )
      ).status,
    ).toBe(503);
    const response = await app.handle(
      new Request(`${config.appUrl}/api/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "A user-facing API with a queue" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { source: string }).source).toBe("demo");
  });

  test("uses state and S256 PKCE, then stores only a hashed session", async () => {
    const store = new FakeStore();
    const app = createApp({ store, config, github });
    const start = await app.handle(
      new Request(`${config.appUrl}/api/auth/github`),
    );
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${config.appUrl}/api/auth/github/callback`,
    );
    const setCookies = start.headers.getSetCookie();
    const state = location.searchParams.get("state")!;
    const verifierCookie = setCookies.find((value) =>
      value.startsWith("archverse_oauth_verifier="),
    )!;
    const verifier = verifierCookie.split(";", 1)[0];
    const callback = await app.handle(
      new Request(
        `${config.appUrl}/api/auth/github/callback?code=code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `archverse_oauth_state=${state}; ${verifier}` } },
      ),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(config.webUrl);
    expect(store.githubInput?.githubId).toBe("987654321");
    expect(store.sessionHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      callback.headers
        .getSetCookie()
        .some((value) => value.startsWith(`${SESSION_COOKIE}=`)),
    ).toBe(true);
  });

  test("uses __Host Secure cookies and rejects HTTP APP_URL in production", async () => {
    const secureConfig = {
      ...config,
      appUrl: "https://api.example.com",
      webUrl: "https://app.example.com",
      secureCookies: true,
    };
    assertProductionConfig(secureConfig, true);
    expect(() => assertProductionConfig(config, true)).toThrow("HTTPS");
    const app = createApp({
      store: new FakeStore(),
      config: secureConfig,
      github,
    });
    const response = await app.handle(
      new Request(`${secureConfig.appUrl}/api/auth/github`),
    );
    const names = securityCookieNames(true);
    expect(
      response.headers
        .getSetCookie()
        .some(
          (value) =>
            value.startsWith(`${names.state}=`) &&
            value.includes("; Secure") &&
            value.includes("Path=/"),
        ),
    ).toBe(true);
    expect(
      response.headers
        .getSetCookie()
        .some(
          (value) =>
            value.startsWith(`${names.verifier}=`) &&
            value.includes("; Secure"),
        ),
    ).toBe(true);
    const location = new URL(response.headers.get("location")!);
    const state = location.searchParams.get("state")!;
    const verifier = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${names.verifier}=`))!
      .split(";", 1)[0];
    const callback = await app.handle(
      new Request(
        `${secureConfig.appUrl}/api/auth/github/callback?code=code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${names.state}=${state}; ${verifier}` } },
      ),
    );
    expect(
      callback.headers
        .getSetCookie()
        .some(
          (value) =>
            value.startsWith(`${names.session}=`) &&
            value.includes("; Secure") &&
            value.includes("Path=/"),
        ),
    ).toBe(true);
  });

  test("rejects an invalid OAuth state", async () => {
    const app = createApp({ store: new FakeStore(), config, github });
    const response = await app.handle(
      new Request(
        `${config.appUrl}/api/auth/github/callback?code=code&state=wrong`,
        {
          headers: {
            cookie:
              "archverse_oauth_state=expected; archverse_oauth_verifier=verifier",
          },
        },
      ),
    );
    expect(response.status).toBe(400);
  });

  test("returns stable OAuth provider errors and clears transient cookies", async () => {
    const failingGithub: GithubClient = {
      async exchangeCode() {
        throw new Error("provider secret detail");
      },
    };
    const app = createApp({
      store: new FakeStore(),
      config,
      github: failingGithub,
    });
    const response = await app.handle(
      new Request(
        `${config.appUrl}/api/auth/github/callback?code=code&state=state`,
        {
          headers: {
            cookie:
              "archverse_oauth_state=state; archverse_oauth_verifier=verifier",
          },
        },
      ),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "GitHub authentication is temporarily unavailable.",
    });
    expect(
      response.headers
        .getSetCookie()
        .filter((value) => value.includes("Max-Age=0")),
    ).toHaveLength(2);
  });

  test("reports and revokes the current opaque session", async () => {
    const store = new FakeStore();
    store.sessionHash = "stored-hash";
    const app = createApp({ store, config, github });
    const anonymous = await app.handle(
      new Request(`${config.appUrl}/api/auth/me`),
    );
    expect(await anonymous.json()).toEqual({ user: null });
    const me = await app.handle(request("/api/auth/me"));
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: User }).user.githubId).toBe("12345");
    const logout = await app.handle(
      request("/api/auth/logout", { method: "POST" }),
    );
    expect(logout.status).toBe(200);
    expect(store.sessionHash).toBeNull();
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(logout.headers.get("cache-control")).toBe("no-store");
  });

  test("ignores malformed and duplicate security cookies", async () => {
    const app = createApp({ store: new FakeStore(), config, github });
    for (const cookie of [
      `${SESSION_COOKIE}=%E0%A4%A`,
      `${SESSION_COOKIE}=first; ${SESSION_COOKIE}=second`,
    ]) {
      const response = await app.handle(
        new Request(`${config.appUrl}/api/auth/me`, { headers: { cookie } }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ user: null });
    }
  });

  test("sanitizes unhandled persistence errors", async () => {
    class ThrowingStore extends FakeStore {
      override async listProjects(): Promise<Project[]> {
        throw new Error("SECRET DB DSN");
      }
    }

    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const app = createApp({ store: new ThrowingStore(), config, github });
      const response = await app.handle(request("/api/projects"));
      const body = await response.text();
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toBe(
        JSON.stringify({ error: "The server could not complete the request." }),
      );
      expect(body).not.toContain("SECRET DB DSN");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("requires active Pro to create private projects", async () => {
    const store = new FakeStore();
    const app = createApp({ store, config, github });
    const denied = await app.handle(
      request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(projectBody("private")),
      }),
    );
    expect(denied.status).toBe(402);
    store.subscription = {
      plan: "pro",
      status: "active",
      currentPeriodEnd: null,
    };
    const created = await app.handle(
      request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(projectBody("private")),
      }),
    );
    expect(created.status).toBe(201);
  });

  test("validates stored documents and permits anonymous public reads", async () => {
    const store = new FakeStore();
    const publicProject = await store.createProject(
      user.id,
      projectBody("public"),
    );
    const app = createApp({ store, config, github });
    const read = await app.handle(
      new Request(`${config.appUrl}/api/projects/${publicProject.id}`),
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(
      ((await read.json()) as Record<string, unknown>).ownerId,
    ).toBeUndefined();
    const invalid = await app.handle(
      request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...projectBody("public"),
          document: {
            version: 1,
            title: "Broken",
            nodes: [],
            edges: [{ id: "e", from: "missing", to: "missing" }],
          },
        }),
      }),
    );
    expect(invalid.status).toBe(422);
  });

  test("hides private projects from non-owners but keeps expired projects readable by owner", async () => {
    const store = new FakeStore();
    const privateProject = await store.createProject(
      user.id,
      projectBody("private"),
    );
    const app = createApp({ store, config, github });
    store.currentUser = otherUser;
    expect(
      (await app.handle(request(`/api/projects/${privateProject.id}`))).status,
    ).toBe(404);
    store.currentUser = user;
    expect(
      (await app.handle(request(`/api/projects/${privateProject.id}`))).status,
    ).toBe(200);
    const update = await app.handle(
      request(`/api/projects/${privateProject.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Changed", revision: 1 }),
      }),
    );
    expect(update.status).toBe(402);
  });

  test("enforces revisions, ownership, and exact unsafe-method origins", async () => {
    const store = new FakeStore();
    const publicProject = await store.createProject(
      user.id,
      projectBody("public"),
    );
    const app = createApp({ store, config, github });
    const conflict = await app.handle(
      request(`/api/projects/${publicProject.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Changed", revision: 9 }),
      }),
    );
    expect(conflict.status).toBe(409);
    const badOrigin = await app.handle(
      new Request(`${config.appUrl}/api/projects/${publicProject.id}`, {
        method: "DELETE",
        headers: {
          cookie: `${SESSION_COOKIE}=test`,
          origin: "https://evil.example",
        },
      }),
    );
    expect(badOrigin.status).toBe(403);
    const deleteConflict = await app.handle(
      request(`/api/projects/${publicProject.id}?revision=9`, {
        method: "DELETE",
      }),
    );
    expect(deleteConflict.status).toBe(409);
    store.currentUser = otherUser;
    expect(
      (
        await app.handle(
          request(`/api/projects/${publicProject.id}?revision=1`, {
            method: "DELETE",
          }),
        )
      ).status,
    ).toBe(404);
    store.currentUser = user;
    expect(
      (
        await app.handle(
          request(`/api/projects/${publicProject.id}`, { method: "DELETE" }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app.handle(
          request(`/api/projects/${publicProject.id}?revision=1`, {
            method: "DELETE",
          }),
        )
      ).status,
    ).toBe(200);
  });

  test("gates OpenAI mode behind authentication and Pro", async () => {
    const store = new FakeStore();
    store.currentUser = null;
    const app = createApp({
      store,
      config: { ...config, openAiEnabled: true },
      github,
    });
    const response = await app.handle(
      new Request(`${config.appUrl}/api/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "A user-facing API" }),
      }),
    );
    expect(response.status).toBe(401);
    store.currentUser = user;
    const denied = await app.handle(
      request("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "A user-facing API" }),
      }),
    );
    expect(denied.status).toBe(402);
  });
});
