import {
  createShapeId,
  toRichText,
  type Editor,
  type TLArrowBinding,
  type TLGeoShape,
  type TLShape,
  type TLShapeId,
} from "@tldraw/tldraw";
import {
  ArchitectureDocumentSchema,
  type ArchitectureDocument,
  type ArchitectureNode,
} from "@archverse/architecture-model";

const NODE_WIDTH = 210;
const NODE_HEIGHT = 112;

type ArchverseMeta = {
  archverseType?: "node" | "edge";
  domainId?: string;
};

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export const nodeShapeId = (id: string): TLShapeId =>
  createShapeId(`archverse-node-${safeId(id)}`);
export const edgeShapeId = (id: string): TLShapeId =>
  createShapeId(`archverse-edge-${safeId(id)}`);

function nodeColor(
  kind: ArchitectureNode["kind"],
): TLGeoShape["props"]["color"] {
  switch (kind) {
    case "database":
      return "green";
    case "queue":
      return "violet";
    case "external":
      return "orange";
    case "user":
      return "blue";
    default:
      return "black";
  }
}

function fallbackPosition(index: number): { x: number; y: number } {
  return {
    x: 100 + (index % 3) * 330,
    y: 100 + Math.floor(index / 3) * 220,
  };
}

function createNode(
  editor: Editor,
  node: ArchitectureNode,
  index: number,
): void {
  const position = node.position ?? fallbackPosition(index);
  editor.createShape({
    id: nodeShapeId(node.id),
    type: "geo",
    x: position.x,
    y: position.y,
    props: {
      geo: node.kind === "user" ? "ellipse" : "rectangle",
      w: NODE_WIDTH,
      h: NODE_HEIGHT,
      richText: toRichText(node.label),
      color: nodeColor(node.kind),
      fill: "semi",
      dash: "draw",
      font: "sans",
      align: "middle",
      verticalAlign: "middle",
      size: "m",
    },
    meta: { archverseType: "node", domainId: node.id },
  });
}

function bindArrow(
  editor: Editor,
  arrowId: TLShapeId,
  fromId: TLShapeId,
  toId: TLShapeId,
): void {
  editor.createBindings<TLArrowBinding>([
    {
      type: "arrow",
      fromId: arrowId,
      toId: fromId,
      props: {
        terminal: "start",
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
    },
    {
      type: "arrow",
      fromId: arrowId,
      toId,
      props: {
        terminal: "end",
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
    },
  ]);
}

export function reconcileCanvas(
  editor: Editor,
  previous: ArchitectureDocument,
  next: ArchitectureDocument,
): void {
  const nextNodeIds = new Set(next.nodes.map((node) => nodeShapeId(node.id)));
  const nextEdgeIds = new Set(next.edges.map((edge) => edgeShapeId(edge.id)));
  const stale = editor.getCurrentPageShapes().filter((shape) => {
    const meta = shape.meta as ArchverseMeta;
    return (
      (meta.archverseType === "node" && !nextNodeIds.has(shape.id)) ||
      (meta.archverseType === "edge" && !nextEdgeIds.has(shape.id))
    );
  });
  if (stale.length > 0) editor.deleteShapes(stale.map((shape) => shape.id));

  next.nodes.forEach((node, index) => {
    const id = nodeShapeId(node.id);
    const current = editor.getShape(id);
    if (!current) {
      createNode(editor, node, index);
      return;
    }

    const priorNode = previous.nodes.find(
      (candidate) => candidate.id === node.id,
    );
    const nextPosition = node.position;
    const positionChanged =
      nextPosition !== undefined &&
      (nextPosition.x !== priorNode?.position?.x ||
        nextPosition.y !== priorNode?.position?.y);
    editor.updateShape({
      id,
      type: "geo",
      ...(positionChanged ? { x: nextPosition.x, y: nextPosition.y } : {}),
      props: {
        richText: toRichText(node.label),
        color: nodeColor(node.kind),
        geo: node.kind === "user" ? "ellipse" : "rectangle",
      },
      meta: { ...current.meta, archverseType: "node", domainId: node.id },
    });
  });

  next.edges.forEach((edge) => {
    const id = edgeShapeId(edge.id);
    const fromId = nodeShapeId(edge.from);
    const toId = nodeShapeId(edge.to);
    const label = [edge.label, edge.protocol].filter(Boolean).join(" · ");
    const existing = editor.getShape(id);
    const prior = previous.edges.find((candidate) => candidate.id === edge.id);
    const endpointsChanged =
      prior && (prior.from !== edge.from || prior.to !== edge.to);

    if (!existing) {
      const from = editor.getShape(fromId);
      const to = editor.getShape(toId);
      if (!from || !to) return;
      editor.createShape({
        id,
        type: "arrow",
        x: from.x + NODE_WIDTH / 2,
        y: from.y + NODE_HEIGHT / 2,
        props: {
          start: { x: 0, y: 0 },
          end: { x: to.x - from.x, y: to.y - from.y },
          arrowheadEnd: "arrow",
          color: "blue",
          dash: "draw",
          richText: toRichText(label),
        },
        meta: { archverseType: "edge", domainId: edge.id },
      });
      bindArrow(editor, id, fromId, toId);
      return;
    }

    editor.updateShape({
      id,
      type: "arrow",
      props: { richText: toRichText(label) },
      meta: { ...existing.meta, archverseType: "edge", domainId: edge.id },
    });
    if (endpointsChanged) {
      const bindingIds = editor
        .getBindingsFromShape<TLArrowBinding>(id, "arrow")
        .map((binding) => binding.id);
      if (bindingIds.length > 0) editor.deleteBindings(bindingIds);
      bindArrow(editor, id, fromId, toId);
    }
  });
}

function readShapeLabel(editor: Editor, shape: TLShape): string | undefined {
  return editor.getShapeUtil(shape).getText(shape)?.trim() || undefined;
}

export function readDocumentFromCanvas(
  editor: Editor,
  document: ArchitectureDocument,
): ArchitectureDocument {
  const nodes = document.nodes.flatMap((node) => {
    const shape = editor.getShape(nodeShapeId(node.id));
    if (!shape) return [];
    const label = readShapeLabel(editor, shape)?.slice(0, 120);
    return [
      {
        ...node,
        ...(label ? { label } : {}),
        position: { x: shape.x, y: shape.y },
      },
    ];
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = document.edges.filter(
    (edge) =>
      nodeIds.has(edge.from) &&
      nodeIds.has(edge.to) &&
      editor.getShape(edgeShapeId(edge.id)) !== undefined,
  );

  const candidate = ArchitectureDocumentSchema.safeParse({
    ...document,
    nodes,
    edges,
  });
  return candidate.success ? candidate.data : document;
}

export function selectedDomainNodeIds(editor: Editor): string[] {
  return editor.getSelectedShapeIds().flatMap((id) => {
    const shape = editor.getShape(id);
    const meta = shape?.meta as ArchverseMeta | undefined;
    return meta?.archverseType === "node" && meta.domainId
      ? [meta.domainId]
      : [];
  });
}
