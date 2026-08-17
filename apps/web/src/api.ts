import {
  PlanResponseSchema,
  type ArchitectureDocument,
  type PlanResponse,
} from "@archverse/architecture-model";

const apiBase =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ??
  "";

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
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `The server returned ${response.status}.`;
    throw new Error(`${message} Check the server and try again.`);
  }

  const parsed = PlanResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      "The server returned an invalid diagram plan. Retry the request.",
    );
  }
  return parsed.data;
}
