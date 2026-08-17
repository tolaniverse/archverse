import { cors } from "@elysiajs/cors";
import {
  PlanRequestSchema,
  PlanResponseSchema,
} from "@archverse/architecture-model";
import { Elysia, t } from "elysia";
import { createPlan } from "./planner";

const allowedOrigin = Bun.env.CORS_ORIGIN ?? "http://localhost:5173";

export const app = new Elysia()
  .use(cors({ origin: allowedOrigin }))
  .get("/health", () => ({
    status: "ok",
    service: "archverse-server" as const,
  }))
  .post(
    "/api/plan",
    async ({ body, set }) => {
      const request = PlanRequestSchema.safeParse(body);
      if (!request.success) {
        set.status = 422;
        return {
          error: "The plan request was invalid.",
          details: request.error.issues.map((issue) => issue.message),
        };
      }

      try {
        const result = await createPlan(request.data);
        return PlanResponseSchema.parse(result);
      } catch (error) {
        console.error("Plan generation failed", error);
        set.status = 500;
        return {
          error: "The diagram plan could not be generated.",
          details: [
            "Retry the request. If it continues to fail, check the server logs.",
          ],
        };
      }
    },
    {
      body: t.Object({
        prompt: t.String({ minLength: 3, maxLength: 4_000 }),
        document: t.Optional(t.Any()),
        selectedNodeIds: t.Optional(t.Array(t.String(), { maxItems: 20 })),
      }),
    },
  );
