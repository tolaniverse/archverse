import { describe, expect, test } from "bun:test";
import { emptyArchitectureDocument } from "@archverse/architecture-model";
import { parseCloudProject } from "./api";

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Queue service",
  visibility: "public" as const,
  document: emptyArchitectureDocument("Queue service"),
  revision: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("cloud project responses", () => {
  test("parses a validated architecture document", () => {
    expect(parseCloudProject(project)).toEqual(project);
  });

  test("rejects malformed revisions and dangling edges", () => {
    expect(() => parseCloudProject({ ...project, revision: 0 })).toThrow(
      "invalid project",
    );
    expect(() =>
      parseCloudProject({
        ...project,
        document: {
          version: 1,
          title: "Broken",
          nodes: [],
          edges: [{ id: "edge", from: "missing", to: "missing" }],
        },
      }),
    ).toThrow();
  });
});
