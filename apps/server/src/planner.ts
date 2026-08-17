import { createOpenAI } from "@ai-sdk/openai";
import {
  ArchitectureDocumentSchema,
  DiagramCommandListSchema,
  PlanResponseSchema,
  applyDiagramCommands,
  emptyArchitectureDocument,
  type ArchitectureDocument,
  type ArchitectureNode,
  type DiagramCommand,
  type PlanRequest,
  type PlanResponse,
} from "@archverse/architecture-model";
import { generateText, Output, zodSchema } from "ai";
import { z } from "zod";

const AiPlanSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  commands: DiagramCommandListSchema,
});

const componentRules: Array<{
  pattern: RegExp;
  id: string;
  label: string;
  kind: ArchitectureNode["kind"];
  description: string;
}> = [
  {
    pattern: /postgres|database|mysql|mongo|persist|storage|store\b/i,
    id: "database",
    label: "Database",
    kind: "database",
    description: "Persistent application data",
  },
  {
    pattern: /queue|kafka|rabbit|event bus|async|asynchronous/i,
    id: "queue",
    label: "Message queue",
    kind: "queue",
    description: "Buffers asynchronous work",
  },
  {
    pattern: /worker|background job|consumer/i,
    id: "worker",
    label: "Worker",
    kind: "service",
    description: "Processes background work",
  },
  {
    pattern: /redis|cache/i,
    id: "cache",
    label: "Cache",
    kind: "service",
    description: "Caches frequently accessed data",
  },
  {
    pattern: /stripe|payment|checkout/i,
    id: "payments",
    label: "Payment provider",
    kind: "external",
    description: "External payment processing",
  },
  {
    pattern: /whatsapp|sms|twilio|email|notification/i,
    id: "messaging",
    label: "Messaging provider",
    kind: "external",
    description: "Delivers outbound messages",
  },
  {
    pattern: /webhook|third.party|external api/i,
    id: "external-api",
    label: "External API",
    kind: "external",
    description: "External system integration",
  },
];

function uniqueId(
  base: string,
  document: ArchitectureDocument,
  pending: Set<string>,
): string {
  let candidate = base;
  let suffix = 2;
  while (
    document.nodes.some((node) => node.id === candidate) ||
    pending.has(candidate)
  ) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  pending.add(candidate);
  return candidate;
}

function uniqueEdgeId(base: string, document: ArchitectureDocument): string {
  let candidate = base;
  let suffix = 2;
  while (document.edges.some((edge) => edge.id === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function inferAddedComponent(prompt: string): {
  id: string;
  label: string;
  kind: ArchitectureNode["kind"];
} {
  const known = componentRules.find((rule) => rule.pattern.test(prompt));
  if (known) return { id: known.id, label: known.label, kind: known.kind };

  const match = prompt.match(/\badd\s+(?:an?\s+)?([a-z0-9][a-z0-9 -]{1,35})/i);
  const raw =
    match?.[1]
      ?.replace(/\b(to|between|for|that|which|with)\b.*$/i, "")
      .trim() || "service";
  return {
    id:
      raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "service",
    label: titleCase(raw),
    kind: /database|store|postgres/i.test(raw) ? "database" : "service",
  };
}

function finalizeDemoPlan(
  document: ArchitectureDocument,
  summary: string,
  commands: DiagramCommand[],
): PlanResponse {
  const plan = PlanResponseSchema.parse({ source: "demo", summary, commands });
  applyDiagramCommands(document, plan.commands);
  return plan;
}

export function createDemoPlan(request: PlanRequest): PlanResponse {
  const document = ArchitectureDocumentSchema.parse(
    request.document ?? emptyArchitectureDocument(),
  );
  const prompt = request.prompt.trim();
  const selected = request.selectedNodeIds ?? [];
  const commands: DiagramCommand[] = [];

  if (/\b(delete|remove)\b/i.test(prompt) && selected.length > 0) {
    for (const id of selected) {
      if (document.nodes.some((node) => node.id === id))
        commands.push({ type: "node.delete", id });
    }
    return finalizeDemoPlan(
      document,
      `Removed ${commands.length} selected component${commands.length === 1 ? "" : "s"}.`,
      commands,
    );
  }

  const rename = prompt.match(
    /\brename\b.*?\bto\s+[“\"]?([^”\"]{2,80})[”\"]?$/i,
  );
  if (
    rename?.[1] &&
    selected[0] &&
    document.nodes.some((node) => node.id === selected[0])
  ) {
    commands.push({
      type: "node.update",
      id: selected[0],
      changes: { label: rename[1].trim() },
    });
    return finalizeDemoPlan(
      document,
      `Renamed the selected component to ${rename[1].trim()}.`,
      commands,
    );
  }

  const pending = new Set<string>();
  if (document.nodes.length > 0) {
    const inferred = inferAddedComponent(prompt);
    const id = uniqueId(inferred.id, document, pending);
    const anchor =
      document.nodes.find((node) => selected.includes(node.id)) ??
      document.nodes.find((node) => node.kind === "service") ??
      document.nodes[0];
    const node: ArchitectureNode = {
      id,
      label: inferred.label,
      kind: inferred.kind,
      description: `Added from: ${prompt.slice(0, 120)}`,
      position: { x: 160 + document.nodes.length * 40, y: 280 },
    };
    commands.push({ type: "node.create", node });
    if (anchor) {
      commands.push({
        type: "edge.create",
        edge: {
          id: uniqueEdgeId(`${anchor.id}-${id}`, document),
          from: anchor.id,
          to: id,
          label: "connects to",
        },
      });
    }
    return finalizeDemoPlan(
      document,
      `Added ${inferred.label} and connected it to the existing architecture.`,
      commands,
    );
  }

  const includeUser = /user|client|customer|browser|web|mobile|app/i.test(
    prompt,
  );
  const baseNodes: ArchitectureNode[] = [
    ...(includeUser
      ? [
          {
            id: "user",
            label: "User",
            kind: "user" as const,
            description: "Starts the request flow",
            position: { x: 80, y: 120 },
          },
        ]
      : []),
    {
      id: "api",
      label: /webhook/i.test(prompt)
        ? "Webhook API"
        : /graphql/i.test(prompt)
          ? "GraphQL API"
          : "Application API",
      kind: "service" as const,
      description: "Handles application requests",
      position: { x: 360, y: 120 },
    },
  ];

  const matched = componentRules.filter((rule) => rule.pattern.test(prompt));
  if (
    /queue|kafka|rabbit|event bus/i.test(prompt) &&
    !matched.some((rule) => rule.id === "worker")
  ) {
    matched.push(componentRules.find((rule) => rule.id === "worker")!);
  }

  const nodes = [
    ...baseNodes,
    ...matched.map((rule, index) => ({
      id: rule.id,
      label: rule.label,
      kind: rule.kind,
      description: rule.description,
      position: { x: 680, y: 40 + index * 180 },
    })),
  ];

  for (const node of nodes) commands.push({ type: "node.create", node });
  if (includeUser) {
    commands.push({
      type: "edge.create",
      edge: { id: "user-api", from: "user", to: "api", label: "requests" },
    });
  }
  for (const node of nodes.filter(
    (candidate) => !["user", "api"].includes(candidate.id),
  )) {
    const from =
      node.id === "worker" &&
      nodes.some((candidate) => candidate.id === "queue")
        ? "queue"
        : "api";
    commands.push({
      type: "edge.create",
      edge: {
        id: `${from}-${node.id}`,
        from,
        to: node.id,
        label: node.kind === "database" ? "reads / writes" : "connects to",
      },
    });
  }

  return finalizeDemoPlan(
    document,
    `Mapped ${nodes.length} components from the prompt. Demo mode uses deterministic keyword planning.`,
    commands,
  );
}

async function createOpenAiPlan(request: PlanRequest): Promise<PlanResponse> {
  const apiKey = Bun.env.OPENAI_API_KEY;
  const openAiEnabled = Bun.env.ARCHVERSE_ENABLE_OPENAI === "true";
  if (!apiKey || !openAiEnabled) return createDemoPlan(request);

  const provider = createOpenAI({ apiKey });
  const result = await generateText({
    model: provider(Bun.env.OPENAI_MODEL ?? "gpt-4.1-mini"),
    output: Output.object({
      schema: zodSchema(AiPlanSchema),
      name: "diagram_command_plan",
      description:
        "A concise summary and valid commands that update an architecture diagram.",
    }),
    system: `You edit architecture diagrams. Return only schema-valid commands.
Create nodes before edges that reference them. Use existing ids for updates and deletes.
Never create duplicate ids. Deleting a node automatically deletes attached edges.
Keep labels concise and ids machine-readable. Prefer 2–8 components per request.`,
    prompt: `User request:\n${request.prompt}\n\nCurrent document:\n${JSON.stringify(request.document ?? emptyArchitectureDocument(), null, 2)}\n\nSelected node ids:\n${JSON.stringify(request.selectedNodeIds ?? [])}`,
    abortSignal: AbortSignal.timeout(30_000),
  });

  const parsed = AiPlanSchema.parse(result.output);
  const current = ArchitectureDocumentSchema.parse(
    request.document ?? emptyArchitectureDocument(),
  );
  applyDiagramCommands(current, parsed.commands);
  return PlanResponseSchema.parse({ source: "openai", ...parsed });
}

export async function createPlan(request: PlanRequest): Promise<PlanResponse> {
  return createOpenAiPlan(request);
}
