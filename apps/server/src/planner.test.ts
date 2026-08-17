import { describe, expect, test } from "bun:test";
import {
  applyDiagramCommands,
  emptyArchitectureDocument,
} from "@archverse/architecture-model";
import { createDemoPlan } from "./planner";

describe("deterministic demo planner", () => {
  test("derives different components from prompt keywords", () => {
    const queuePlan = createDemoPlan({
      prompt: "A web app with Kafka and a background worker",
    });
    const paymentPlan = createDemoPlan({
      prompt: "A checkout API using Stripe and Postgres",
    });

    const queueIds = queuePlan.commands.flatMap((command) =>
      command.type === "node.create" ? [command.node.id] : [],
    );
    const paymentIds = paymentPlan.commands.flatMap((command) =>
      command.type === "node.create" ? [command.node.id] : [],
    );

    expect(queueIds).toContain("queue");
    expect(queueIds).toContain("worker");
    expect(paymentIds).toContain("payments");
    expect(paymentIds).toContain("database");
    expect(queueIds).not.toContain("payments");
  });

  test("creates commands that apply to a document", () => {
    const document = emptyArchitectureDocument("Webhook service");
    const plan = createDemoPlan({
      prompt: "Users call a webhook API backed by Postgres",
      document,
    });
    const result = applyDiagramCommands(document, plan.commands);

    expect(result.nodes.length).toBeGreaterThanOrEqual(3);
    expect(result.edges.length).toBeGreaterThanOrEqual(2);
  });

  test("adds a component to an existing architecture", () => {
    const base = applyDiagramCommands(emptyArchitectureDocument(), [
      {
        type: "node.create",
        node: { id: "api", label: "API", kind: "service" },
      },
    ]);
    const plan = createDemoPlan({
      prompt: "Add a Redis cache",
      document: base,
    });
    const result = applyDiagramCommands(base, plan.commands);

    expect(result.nodes.some((node) => node.id === "cache")).toBe(true);
    expect(result.edges).toHaveLength(1);
  });

  test("avoids node and edge id collisions in follow-up plans", () => {
    const base = applyDiagramCommands(emptyArchitectureDocument(), [
      {
        type: "node.create",
        node: { id: "api", label: "API", kind: "service" },
      },
      {
        type: "node.create",
        node: { id: "cache", label: "Cache", kind: "service" },
      },
      {
        type: "edge.create",
        edge: { id: "api-cache", from: "api", to: "cache" },
      },
    ]);
    const plan = createDemoPlan({
      prompt: "Add another Redis cache",
      document: base,
    });
    const result = applyDiagramCommands(base, plan.commands);

    expect(result.nodes.some((node) => node.id === "cache-2")).toBe(true);
    expect(new Set(result.edges.map((edge) => edge.id)).size).toBe(
      result.edges.length,
    );
  });
});
