import { cors } from "@elysiajs/cors";
import {
  PlanRequestSchema,
  PlanResponseSchema,
} from "@archverse/architecture-model";
import { Elysia, t } from "elysia";
import {
  GithubOAuthClient,
  clearCookie,
  cookie,
  parseCookies,
  randomToken,
  securityCookieNames,
  sessionUser,
  sha256,
  type AppConfig,
  type GithubClient,
} from "./auth";
import {
  ProjectCreateSchema,
  ProjectIdSchema,
  ProjectUpdateSchema,
  canWriteProject,
  hasActivePro,
  type Project,
} from "./domain";
import { createPlan } from "./planner";
import { PostgresStore, type Store } from "./store";

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });

function requiredStore(store: Store | undefined): Store {
  if (!store) throw new Error("Persistence is not configured");
  return store;
}

function projectView(project: Project) {
  const { ownerId: _ownerId, ...publicFields } = project;
  return {
    ...publicFields,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export type AppDependencies = {
  store?: Store;
  github?: GithubClient;
  config?: AppConfig;
  now?: () => Date;
};

export function assertProductionConfig(
  config: AppConfig,
  production: boolean,
): void {
  if (production && new URL(config.appUrl).protocol !== "https:") {
    throw new Error("APP_URL must use HTTPS in production");
  }
}

function environmentConfig(): AppConfig {
  const appUrl = (Bun.env.APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  const webUrl = (
    Bun.env.WEB_URL ??
    Bun.env.CORS_ORIGIN ??
    "http://localhost:5173"
  ).replace(/\/$/, "");
  const config = {
    appUrl,
    webUrl,
    githubClientId: Bun.env.GITHUB_CLIENT_ID ?? "",
    githubClientSecret: Bun.env.GITHUB_CLIENT_SECRET ?? "",
    secureCookies: new URL(appUrl).protocol === "https:",
    openAiEnabled: Bun.env.ARCHVERSE_ENABLE_OPENAI === "true",
  };
  assertProductionConfig(config, Bun.env.NODE_ENV === "production");
  return config;
}

export function createApp(dependencies: AppDependencies = {}) {
  const config = dependencies.config ?? environmentConfig();
  const store =
    dependencies.store ??
    (Bun.env.DATABASE_URL
      ? new PostgresStore(Bun.env.DATABASE_URL)
      : undefined);
  const github =
    dependencies.github ??
    new GithubOAuthClient(config.githubClientId, config.githubClientSecret);
  const now = dependencies.now ?? (() => new Date());
  const callbackUrl = `${config.appUrl}/api/auth/github/callback`;
  const cookieNames = securityCookieNames(config.secureCookies);

  function oauthError(message: string, status: number) {
    const headers = new Headers({
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    headers.append(
      "set-cookie",
      clearCookie(cookieNames.state, config.secureCookies),
    );
    headers.append(
      "set-cookie",
      clearCookie(cookieNames.verifier, config.secureCookies),
    );
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers,
    });
  }

  async function auth(request: Request) {
    if (!store) return null;
    return sessionUser(request, store, cookieNames.session, now());
  }

  async function activePro(userId: string) {
    return hasActivePro(
      await requiredStore(store).getSubscription(userId),
      now(),
    );
  }

  return new Elysia()
    .use(cors({ origin: config.webUrl, credentials: true }))
    .onError(({ code, error }) => {
      if (code === "NOT_FOUND") return json({ error: "Not found." }, 404);
      if (code === "VALIDATION") {
        return json({ error: "The request was invalid." }, 422);
      }
      console.error("Unhandled API error", {
        code,
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return json({ error: "The server could not complete the request." }, 500);
    })
    .onBeforeHandle(({ request }) => {
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
      if (!parseCookies(request).has(cookieNames.session)) return;
      if (request.headers.get("origin") !== config.webUrl) {
        return json({ error: "Origin is not allowed." }, 403);
      }
    })
    .get("/health", () => ({
      status: "ok",
      service: "archverse-server" as const,
    }))
    .get("/ready", async () => {
      if (!store) return json({ status: "unavailable" }, 503);
      try {
        await store.ping();
        return json({ status: "ready" });
      } catch {
        return json({ status: "unavailable" }, 503);
      }
    })
    .get("/api/auth/github", async () => {
      if (!store || !config.githubClientId || !config.githubClientSecret) {
        return json({ error: "GitHub authentication is not configured." }, 503);
      }
      const state = randomToken();
      const verifier = randomToken(48);
      const challenge = await sha256(verifier);
      const target = new URL("https://github.com/login/oauth/authorize");
      target.searchParams.set("client_id", config.githubClientId);
      target.searchParams.set("redirect_uri", callbackUrl);
      target.searchParams.set("scope", "read:user");
      target.searchParams.set("state", state);
      target.searchParams.set("code_challenge", challenge);
      target.searchParams.set("code_challenge_method", "S256");
      const headers = new Headers({
        "cache-control": "no-store",
        location: target.toString(),
      });
      headers.append(
        "set-cookie",
        cookie(cookieNames.state, state, {
          maxAge: 600,
          secure: config.secureCookies,
        }),
      );
      headers.append(
        "set-cookie",
        cookie(cookieNames.verifier, verifier, {
          maxAge: 600,
          secure: config.secureCookies,
        }),
      );
      return new Response(null, { status: 302, headers });
    })
    .get("/api/auth/github/callback", async ({ query, request }) => {
      if (!store)
        return oauthError("Authentication persistence is unavailable.", 503);
      const cookies = parseCookies(request);
      const state = typeof query.state === "string" ? query.state : "";
      const code = typeof query.code === "string" ? query.code : "";
      const expectedState = cookies.get(cookieNames.state);
      const verifier = cookies.get(cookieNames.verifier);
      if (
        !code ||
        !state ||
        !expectedState ||
        state !== expectedState ||
        !verifier
      ) {
        return oauthError("The OAuth callback was invalid or expired.", 400);
      }

      let identity: Awaited<ReturnType<GithubClient["exchangeCode"]>>;
      try {
        identity = await github.exchangeCode({
          code,
          verifier,
          redirectUri: callbackUrl,
        });
      } catch {
        return oauthError(
          "GitHub authentication is temporarily unavailable.",
          502,
        );
      }

      const token = randomToken();
      try {
        const user = await store.upsertGithubUser({
          githubId: identity.id,
          githubLogin: identity.login,
          avatarUrl: identity.avatarUrl,
        });
        await store.createSession({
          tokenHash: await sha256(token),
          userId: user.id,
          expiresAt: new Date(now().getTime() + 30 * 24 * 60 * 60 * 1000),
        });
      } catch {
        return oauthError(
          "Authentication persistence is temporarily unavailable.",
          503,
        );
      }
      const headers = new Headers({
        "cache-control": "no-store",
        location: config.webUrl,
      });
      headers.append(
        "set-cookie",
        cookie(cookieNames.session, token, {
          maxAge: 30 * 24 * 60 * 60,
          secure: config.secureCookies,
        }),
      );
      headers.append(
        "set-cookie",
        clearCookie(cookieNames.state, config.secureCookies),
      );
      headers.append(
        "set-cookie",
        clearCookie(cookieNames.verifier, config.secureCookies),
      );
      return new Response(null, { status: 302, headers });
    })
    .get("/api/auth/me", async ({ request }) => {
      const user = await auth(request);
      if (!user) return json({ user: null });
      return json({ user, activePro: await activePro(user.id) });
    })
    .post("/api/auth/logout", async ({ request }) => {
      if (!store) return json({ error: "Persistence is not configured." }, 503);
      const token = parseCookies(request).get(cookieNames.session);
      if (token) await store.deleteSession(await sha256(token));
      return json({ ok: true }, 200, {
        "set-cookie": clearCookie(cookieNames.session, config.secureCookies),
      });
    })
    .post(
      "/api/plan",
      async ({ body, request, set }) => {
        const parsed = PlanRequestSchema.safeParse(body);
        if (!parsed.success) {
          set.status = 422;
          return {
            error: "The plan request was invalid.",
            details: parsed.error.issues.map((issue) => issue.message),
          };
        }
        if (config.openAiEnabled) {
          const user = await auth(request);
          if (!user) return json({ error: "Authentication is required." }, 401);
          if (!(await activePro(user.id))) {
            return json(
              { error: "An active Pro subscription is required." },
              402,
            );
          }
        }
        try {
          return PlanResponseSchema.parse(await createPlan(parsed.data));
        } catch (error) {
          console.error(
            "Plan generation failed",
            error instanceof Error ? error.message : error,
          );
          return json(
            { error: "The diagram plan could not be generated." },
            500,
          );
        }
      },
      {
        body: t.Object({
          prompt: t.String({ minLength: 3, maxLength: 4_000 }),
          document: t.Optional(t.Any()),
          selectedNodeIds: t.Optional(t.Array(t.String(), { maxItems: 20 })),
        }),
      },
    )
    .get("/api/projects", async ({ request }) => {
      if (!store) return json({ error: "Persistence is not configured." }, 503);
      const user = await auth(request);
      if (!user) return json({ error: "Authentication is required." }, 401);
      return json({
        projects: (await store.listProjects(user.id)).map(projectView),
      });
    })
    .post("/api/projects", async ({ request, body }) => {
      if (!store) return json({ error: "Persistence is not configured." }, 503);
      const user = await auth(request);
      if (!user) return json({ error: "Authentication is required." }, 401);
      const parsed = ProjectCreateSchema.safeParse(body);
      if (!parsed.success)
        return json({ error: "The project was invalid." }, 422);
      const pro = await activePro(user.id);
      if (!canWriteProject(null, parsed.data.visibility, pro)) {
        return json(
          {
            error:
              "An active Pro subscription is required for private projects.",
          },
          402,
        );
      }
      return json(
        projectView(await store.createProject(user.id, parsed.data)),
        201,
      );
    })
    .get("/api/projects/:id", async ({ params, request }) => {
      if (!store) return json({ error: "Persistence is not configured." }, 503);
      const id = ProjectIdSchema.safeParse(params.id);
      if (!id.success) return json({ error: "Project not found." }, 404);
      const project = await store.getProject(id.data);
      if (!project) return json({ error: "Project not found." }, 404);
      if (project.visibility === "private") {
        const user = await auth(request);
        if (!user || user.id !== project.ownerId) {
          return json({ error: "Project not found." }, 404);
        }
      }
      return json(projectView(project));
    })
    .patch("/api/projects/:id", async ({ params, request, body }) => {
      if (!store) return json({ error: "Persistence is not configured." }, 503);
      const user = await auth(request);
      if (!user) return json({ error: "Authentication is required." }, 401);
      const id = ProjectIdSchema.safeParse(params.id);
      if (!id.success) return json({ error: "Project not found." }, 404);
      const current = await store.getProject(id.data);
      if (!current || current.ownerId !== user.id) {
        return json({ error: "Project not found." }, 404);
      }
      const parsed = ProjectUpdateSchema.safeParse(body);
      if (!parsed.success)
        return json({ error: "The project update was invalid." }, 422);
      const pro = await activePro(user.id);
      if (
        !canWriteProject(
          current,
          parsed.data.visibility ?? current.visibility,
          pro,
        )
      ) {
        return json(
          {
            error:
              "An active Pro subscription is required to modify private projects.",
          },
          402,
        );
      }
      const result = await store.updateProject(id.data, user.id, parsed.data);
      if (result === "conflict")
        return json({ error: "Project revision conflict." }, 409);
      if (!result) return json({ error: "Project not found." }, 404);
      return json(projectView(result));
    })
    .delete("/api/projects/:id", async ({ params, query, request }) => {
      if (!store) return json({ error: "Persistence is not configured." }, 503);
      const user = await auth(request);
      if (!user) return json({ error: "Authentication is required." }, 401);
      const id = ProjectIdSchema.safeParse(params.id);
      if (!id.success) return json({ error: "Project not found." }, 404);
      const revision = Number(query.revision);
      if (!Number.isInteger(revision) || revision <= 0) {
        return json({ error: "A positive project revision is required." }, 422);
      }
      const result = await store.deleteProject(id.data, user.id, revision);
      if (result === "conflict") {
        return json({ error: "Project revision conflict." }, 409);
      }
      return result === "deleted"
        ? json({ ok: true })
        : json({ error: "Project not found." }, 404);
    });
}

export const app = createApp();
