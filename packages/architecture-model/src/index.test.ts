import { describe, expect, test } from "bun:test";
import {
  ArchitectureDocumentSchema,
  DiagramCommandError,
  DiagramCommandSchema,
  applyDiagramCommands,
  architectureToMarkdown,
  emptyArchitectureDocument,
} from "./index";

const service = {
  id: "api",
  label: "API",
  kind: "service" as const,
};

const database = {
  id: "database",
  label: "PostgreSQL",
  kind: "database" as const,
};

describe("architecture command reducer", () => {
  test("creates, updates, and connects nodes deterministically", () => {
    const result = applyDiagramCommands(emptyArchitectureDocument("Payments"), [
      { type: "node.create", node: service },
      { type: "node.create", node: database },
      {
        type: "edge.create",
        edge: {
          id: "api-database",
          from: "api",
          to: "database",
          protocol: "SQL",
        },
      },
      { type: "node.update", id: "api", changes: { label: "Payments API" } },
      {
        type: "edge.update",
        id: "api-database",
        changes: { label: "stores payments" },
      },
    ]);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]?.label).toBe("Payments API");
    expect(result.edges[0]?.label).toBe("stores payments");
  });

  test("deleting a node removes its connected edges", () => {
    const result = applyDiagramCommands(emptyArchitectureDocument(), [
      { type: "node.create", node: service },
      { type: "node.create", node: database },
      {
        type: "edge.create",
        edge: { id: "api-db", from: "api", to: "database" },
      },
      { type: "node.delete", id: "database" },
    ]);

    expect(result.nodes.map((node) => node.id)).toEqual(["api"]);
    expect(result.edges).toEqual([]);
  });

  test("rejects dangling edges", () => {
    expect(() =>
      applyDiagramCommands(emptyArchitectureDocument(), [
        { type: "node.create", node: service },
        {
          type: "edge.create",
          edge: { id: "bad", from: "api", to: "missing" },
        },
      ]),
    ).toThrow(DiagramCommandError);
  });

  test("rejects commands that exceed document capacity", () => {
    const document = ArchitectureDocumentSchema.parse({
      ...emptyArchitectureDocument(),
      nodes: Array.from({ length: 100 }, (_, index) => ({
        id: `service-${index}`,
        label: `Service ${index}`,
        kind: "service",
      })),
    });

    expect(() =>
      applyDiagramCommands(document, [
        {
          type: "node.create",
          node: { id: "service-overflow", label: "Overflow", kind: "service" },
        },
      ]),
    ).toThrow();

    const edgeDocument = ArchitectureDocumentSchema.parse({
      ...emptyArchitectureDocument(),
      nodes: [service, database],
      edges: Array.from({ length: 200 }, (_, index) => ({
        id: `edge-${index}`,
        from: "api",
        to: "database",
      })),
    });
    expect(() =>
      applyDiagramCommands(edgeDocument, [
        {
          type: "edge.create",
          edge: { id: "edge-overflow", from: "api", to: "database" },
        },
      ]),
    ).toThrow();
  });
});

describe("schemas and exports", () => {
  test("rejects unsafe or canvas-colliding ids", () => {
    expect(
      DiagramCommandSchema.safeParse({
        type: "node.delete",
        id: "contains spaces",
      }).success,
    ).toBe(false);
    expect(
      DiagramCommandSchema.safeParse({ type: "node.delete", id: "service:api" })
        .success,
    ).toBe(false);
  });

  test("rejects duplicate ids and dangling document edges", () => {
    const result = ArchitectureDocumentSchema.safeParse({
      ...emptyArchitectureDocument(),
      nodes: [service, service],
      edges: [{ id: "bad-edge", from: "api", to: "missing" }],
    });
    expect(result.success).toBe(false);
  });

  test("exports readable markdown", () => {
    const document = applyDiagramCommands(
      emptyArchitectureDocument("Payments"),
      [
        { type: "node.create", node: service },
        { type: "node.create", node: database },
        {
          type: "edge.create",
          edge: { id: "api-db", from: "api", to: "database" },
        },
      ],
    );
    expect(architectureToMarkdown(document)).toContain("API → PostgreSQL");
  });
});
