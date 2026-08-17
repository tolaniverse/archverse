import { z } from "zod";

export const ArchitectureIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "Use a stable machine-readable id");

export const PointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const NodeKindSchema = z.enum([
  "service",
  "database",
  "queue",
  "external",
  "user",
  "group",
]);

export const ArchitectureNodeSchema = z.object({
  id: ArchitectureIdSchema,
  label: z.string().trim().min(1).max(120),
  kind: NodeKindSchema,
  description: z.string().trim().max(500).optional(),
  position: PointSchema.optional(),
});

export const ArchitectureEdgeSchema = z.object({
  id: ArchitectureIdSchema,
  from: ArchitectureIdSchema,
  to: ArchitectureIdSchema,
  label: z.string().trim().max(120).optional(),
  protocol: z.string().trim().max(80).optional(),
});

export const ArchitectureDocumentSchema = z
  .object({
    version: z.literal(1),
    title: z.string().trim().min(1).max(120),
    nodes: z.array(ArchitectureNodeSchema).max(100),
    edges: z.array(ArchitectureEdgeSchema).max(200),
  })
  .superRefine((document, context) => {
    const nodeIds = new Set<string>();
    document.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate node id “${node.id}”.`,
          path: ["nodes", index, "id"],
        });
      }
      nodeIds.add(node.id);
    });

    const edgeIds = new Set<string>();
    document.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate edge id “${edge.id}”.`,
          path: ["edges", index, "id"],
        });
      }
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.from)) {
        context.addIssue({
          code: "custom",
          message: `Edge source “${edge.from}” does not exist.`,
          path: ["edges", index, "from"],
        });
      }
      if (!nodeIds.has(edge.to)) {
        context.addIssue({
          code: "custom",
          message: `Edge target “${edge.to}” does not exist.`,
          path: ["edges", index, "to"],
        });
      }
    });
  });

const NodeChangesSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    kind: NodeKindSchema.optional(),
    description: z.string().trim().max(500).optional(),
    position: PointSchema.optional(),
  })
  .refine(
    (changes) => Object.keys(changes).length > 0,
    "Provide at least one node change",
  );

const EdgeChangesSchema = z
  .object({
    from: ArchitectureIdSchema.optional(),
    to: ArchitectureIdSchema.optional(),
    label: z.string().trim().max(120).optional(),
    protocol: z.string().trim().max(80).optional(),
  })
  .refine(
    (changes) => Object.keys(changes).length > 0,
    "Provide at least one edge change",
  );

export const DiagramCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("node.create"), node: ArchitectureNodeSchema }),
  z.object({
    type: z.literal("node.update"),
    id: ArchitectureIdSchema,
    changes: NodeChangesSchema,
  }),
  z.object({ type: z.literal("node.delete"), id: ArchitectureIdSchema }),
  z.object({ type: z.literal("edge.create"), edge: ArchitectureEdgeSchema }),
  z.object({
    type: z.literal("edge.update"),
    id: ArchitectureIdSchema,
    changes: EdgeChangesSchema,
  }),
  z.object({ type: z.literal("edge.delete"), id: ArchitectureIdSchema }),
]);

export const DiagramCommandListSchema = z
  .array(DiagramCommandSchema)
  .min(1)
  .max(50);

export const PlanRequestSchema = z.object({
  prompt: z.string().trim().min(3).max(4_000),
  document: ArchitectureDocumentSchema.optional(),
  selectedNodeIds: z.array(ArchitectureIdSchema).max(20).optional(),
});

export const PlanResponseSchema = z.object({
  source: z.enum(["demo", "openai"]),
  summary: z.string().trim().min(1).max(500),
  commands: DiagramCommandListSchema,
});

export type ArchitectureNode = z.infer<typeof ArchitectureNodeSchema>;
export type ArchitectureEdge = z.infer<typeof ArchitectureEdgeSchema>;
export type ArchitectureDocument = z.infer<typeof ArchitectureDocumentSchema>;
export type DiagramCommand = z.infer<typeof DiagramCommandSchema>;
export type PlanRequest = z.infer<typeof PlanRequestSchema>;
export type PlanResponse = z.infer<typeof PlanResponseSchema>;

export const emptyArchitectureDocument = (
  title = "Untitled architecture",
): ArchitectureDocument => ({
  version: 1,
  title,
  nodes: [],
  edges: [],
});

export class DiagramCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagramCommandError";
  }
}

function requireNode(
  document: ArchitectureDocument,
  id: string,
): ArchitectureNode {
  const node = document.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new DiagramCommandError(`Node “${id}” does not exist.`);
  return node;
}

function requireEdge(
  document: ArchitectureDocument,
  id: string,
): ArchitectureEdge {
  const edge = document.edges.find((candidate) => candidate.id === id);
  if (!edge) throw new DiagramCommandError(`Edge “${id}” does not exist.`);
  return edge;
}

export function applyDiagramCommand(
  input: ArchitectureDocument,
  commandInput: DiagramCommand,
): ArchitectureDocument {
  const document = ArchitectureDocumentSchema.parse(input);
  const command = DiagramCommandSchema.parse(commandInput);

  switch (command.type) {
    case "node.create": {
      if (document.nodes.some((node) => node.id === command.node.id)) {
        throw new DiagramCommandError(
          `Node “${command.node.id}” already exists.`,
        );
      }
      return { ...document, nodes: [...document.nodes, command.node] };
    }
    case "node.update": {
      requireNode(document, command.id);
      return {
        ...document,
        nodes: document.nodes.map((node) =>
          node.id === command.id
            ? ArchitectureNodeSchema.parse({ ...node, ...command.changes })
            : node,
        ),
      };
    }
    case "node.delete": {
      requireNode(document, command.id);
      return {
        ...document,
        nodes: document.nodes.filter((node) => node.id !== command.id),
        edges: document.edges.filter(
          (edge) => edge.from !== command.id && edge.to !== command.id,
        ),
      };
    }
    case "edge.create": {
      if (document.edges.some((edge) => edge.id === command.edge.id)) {
        throw new DiagramCommandError(
          `Edge “${command.edge.id}” already exists.`,
        );
      }
      requireNode(document, command.edge.from);
      requireNode(document, command.edge.to);
      return { ...document, edges: [...document.edges, command.edge] };
    }
    case "edge.update": {
      const edge = requireEdge(document, command.id);
      const next = ArchitectureEdgeSchema.parse({
        ...edge,
        ...command.changes,
      });
      requireNode(document, next.from);
      requireNode(document, next.to);
      return {
        ...document,
        edges: document.edges.map((candidate) =>
          candidate.id === command.id ? next : candidate,
        ),
      };
    }
    case "edge.delete": {
      requireEdge(document, command.id);
      return {
        ...document,
        edges: document.edges.filter((edge) => edge.id !== command.id),
      };
    }
  }
}

export function applyDiagramCommands(
  document: ArchitectureDocument,
  commands: DiagramCommand[],
): ArchitectureDocument {
  const result = DiagramCommandListSchema.parse(commands).reduce(
    applyDiagramCommand,
    document,
  );
  return ArchitectureDocumentSchema.parse(result);
}

export function architectureToMarkdown(
  documentInput: ArchitectureDocument,
): string {
  const document = ArchitectureDocumentSchema.parse(documentInput);
  const lines = [`# ${document.title}`, "", "## Components", ""];

  if (document.nodes.length === 0) lines.push("No components yet.");
  for (const node of document.nodes) {
    const detail = node.description ? ` — ${node.description}` : "";
    lines.push(`- **${node.label}** (${node.kind})${detail}`);
  }

  lines.push("", "## Connections", "");
  if (document.edges.length === 0) lines.push("No connections yet.");
  for (const edge of document.edges) {
    const from =
      document.nodes.find((node) => node.id === edge.from)?.label ?? edge.from;
    const to =
      document.nodes.find((node) => node.id === edge.to)?.label ?? edge.to;
    const detail = [edge.label, edge.protocol].filter(Boolean).join(" · ");
    lines.push(`- ${from} → ${to}${detail ? ` — ${detail}` : ""}`);
  }

  return `${lines.join("\n")}\n`;
}
