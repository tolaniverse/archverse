import {
  ArchitectureDocumentSchema,
  PlanResponseSchema,
  type ArchitectureDocument,
  type PlanResponse,
} from "@archverse/architecture-model";

const apiBase =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ??
  "";

export type SessionUser = {
  id: string;
  githubId: string;
  githubLogin: string;
  avatarUrl: string | null;
};

export type Session = {
  user: SessionUser | null;
  activePro: boolean;
};

export type CloudProject = {
  id: string;
  title: string;
  visibility: "public" | "private";
  document: ArchitectureDocument;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(body: unknown, status: number): string {
  return isRecord(body) && typeof body.error === "string"
    ? body.error
    : `The server returned ${status}.`;
}

async function apiRequest(path: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      credentials: "include",
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("The cloud request timed out. Try again.");
    }
    throw error;
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(errorMessage(body, response.status), response.status);
  return body;
}

export function githubLoginUrl(): string {
  return `${apiBase}/api/auth/github`;
}

export async function getSession(): Promise<Session> {
  const body = await apiRequest("/api/auth/me");
  if (!isRecord(body) || !("user" in body)) {
    throw new Error("The server returned an invalid session.");
  }
  if (body.user === null) return { user: null, activePro: false };
  if (
    !isRecord(body.user) ||
    typeof body.user.id !== "string" ||
    typeof body.user.githubId !== "string" ||
    typeof body.user.githubLogin !== "string" ||
    !(body.user.avatarUrl === null || typeof body.user.avatarUrl === "string")
  ) {
    throw new Error("The server returned an invalid session.");
  }
  return {
    user: body.user as SessionUser,
    activePro: body.activePro === true,
  };
}

export async function logout(): Promise<void> {
  await apiRequest("/api/auth/logout", { method: "POST" });
}

export function parseCloudProject(value: unknown): CloudProject {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    !["public", "private"].includes(String(value.visibility)) ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("The server returned an invalid project.");
  }
  return {
    id: value.id,
    title: value.title,
    visibility: value.visibility as CloudProject["visibility"],
    document: ArchitectureDocumentSchema.parse(value.document),
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export async function listProjects(): Promise<CloudProject[]> {
  const body = await apiRequest("/api/projects");
  if (!isRecord(body) || !Array.isArray(body.projects)) {
    throw new Error("The server returned an invalid project list.");
  }
  return body.projects.map(parseCloudProject);
}

export async function createProject(input: {
  title: string;
  visibility: CloudProject["visibility"];
  document: ArchitectureDocument;
}): Promise<CloudProject> {
  return parseCloudProject(
    await apiRequest("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function updateProject(
  project: CloudProject,
  document: ArchitectureDocument,
): Promise<CloudProject> {
  return parseCloudProject(
    await apiRequest(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: document.title,
        document,
        revision: project.revision,
      }),
    }),
  );
}

export async function deleteProject(project: CloudProject): Promise<void> {
  await apiRequest(
    `/api/projects/${encodeURIComponent(project.id)}?revision=${project.revision}`,
    { method: "DELETE" },
  );
}

export async function requestPlan(input: {
  prompt: string;
  document: ArchitectureDocument;
  selectedNodeIds: string[];
}): Promise<PlanResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/plan`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        "Planning took longer than 30 seconds. Retry the request.",
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(errorMessage(body, response.status), response.status);
  }

  const parsed = PlanResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      "The server returned an invalid diagram plan. Retry the request.",
    );
  }
  return parsed.data;
}
