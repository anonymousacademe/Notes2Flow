import {
  defaultShape,
  type Graph as GraphT,
  type Node as GraphNode,
  type Edge as GraphEdge,
  type NodeShape,
  type NodeStyle,
} from "./schema.js";

export interface ExcalidrawElement {
  id: string;
  type: "rectangle" | "diamond" | "ellipse" | "text" | "arrow";
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: "hachure";
  strokeWidth: number;
  strokeStyle: "solid" | "dashed";
  roughness: number;
  roundness: { type: number } | null;
  text?: string;
  fontSize?: number;
  textAlign?: string;
  verticalAlign?: string;
  containerId?: string | null;
  start?: string;
  end?: string;
  points?: number[][];
  startArrowhead?: null;
  endArrowhead?: "arrow" | "triangle";
  label?: { text: string; fontSize?: number };
  groupIds?: string[];
  boundElements?: { id: string; type: string }[] | null;
  customData?: Record<string, unknown>;
}

const NODE_W = 220;
const NODE_H = 70;
const TEXT_W = 200;
const TEXT_H = 50;
const STROKE = "#1e1e1e";
const BG = {
  claim: "#e8f0fe",
  assumption: "#f3e8fd",
  option: "#e6f4ea",
  decision: "#fef7e0",
  action: "#e0f2f1",
  prereq: "#fce8e6",
  question: "#fff8e1",
  note: "#f1f3f4",
  start: "#e6f4ea",
  step: "#e8f0fe",
  outcome: "#fce8e6",
};

function nodeText(label: string): string {
  // Wrap at ~28 chars per line, max 4 lines.
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > 28 && cur.length > 0) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
    if (lines.length === 4) break;
  }
  if (cur.length > 0 && lines.length < 4) lines.push(cur);
  return lines.join("\n");
}

function nodeShape(node: GraphNode & { style?: NodeStyle }): NodeShape {
  return node.style?.shape ?? defaultShape(node.kind);
}

/** Pick a readable text color for a user-chosen fill. */
function textColorFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.55 ? STROKE : "#ffffff";
}

export function toExcalidraw(
  graph: GraphT & {
    nodes: (GraphNode & { provenance_status?: string; style?: NodeStyle })[];
    edges: (GraphEdge & { status?: string })[];
  },
): { type: "excalidraw"; version: number; source: string; elements: ExcalidrawElement[]; appState: Record<string, unknown> } {
  const elements: ExcalidrawElement[] = [];

  for (const node of graph.nodes) {
    const shapeKind = nodeShape(node);
    const type = shapeKind === "diamond" ? "diamond" : shapeKind === "ellipse" ? "ellipse" : "rectangle";
    const id = node.id;
    const customFill = node.style?.color;
    const label: ExcalidrawElement = {
      id: `${id}_label`,
      type: "text",
      x: 0,
      y: 0,
      width: TEXT_W,
      height: TEXT_H,
      angle: 0,
      strokeColor: customFill ? textColorFor(customFill) : STROKE,
      backgroundColor: "transparent",
      fillStyle: "hachure",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 1,
      roundness: null,
      text: nodeText(node.label) + ((node as { details?: string[] }).details ?? []).map((d) => "\n- " + d.slice(0, 40)).join(""),
      fontSize: 14,
      textAlign: "center",
      verticalAlign: "middle",
      containerId: id,
    };
    const shape: ExcalidrawElement = {
      id,
      type,
      x: 0,
      y: 0,
      width: NODE_W,
      height: NODE_H,
      angle: 0,
      strokeColor: STROKE,
      backgroundColor: customFill ?? BG[node.kind] ?? "#f1f3f4",
      fillStyle: "hachure",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 2,
      roundness: shapeKind === "rounded" || shapeKind === "pill" ? { type: 3 } : null,
      boundElements: [{ id: `${id}_label`, type: "text" }],
      customData: {
        n2f_node_id: id,
        n2f_kind: node.kind,
        n2f_provenance_status: (node as any).provenance_status ?? "verified",
      },
    };
    elements.push(shape, label);
  }

  for (const edge of graph.edges) {
    const dashed = (edge as any).status === "unverified";
    const fromNode = graph.nodes.find((n) => n.id === edge.from);
    const toNode = graph.nodes.find((n) => n.id === edge.to);
    if (!fromNode || !toNode) continue;
    const arrow: ExcalidrawElement = {
      id: `edge_${edge.from}_${edge.to}`,
      type: "arrow",
      x: 0,
      y: 0,
      width: 100,
      height: 0,
      angle: 0,
      strokeColor: STROKE,
      backgroundColor: "transparent",
      fillStyle: "hachure",
      strokeWidth: 1,
      strokeStyle: dashed ? "dashed" : "solid",
      roughness: 2,
      roundness: { type: 2 },
      points: [
        [0, 0],
        [100, 0],
      ],
      startArrowhead: null,
      endArrowhead: "arrow",
      label: {
        text:
          graph.map_type === "process"
            ? edge.label ?? ""
            : edge.relation + (edge.grounding === "implied" ? " (implied)" : ""),
        fontSize: 11,
      },
      customData: { n2f_edge_from: edge.from, n2f_edge_to: edge.to, n2f_relation: edge.relation },
    };
    void fromNode;
    void toNode;
    elements.push(arrow);
  }

  return {
    type: "excalidraw",
    version: 2,
    source: "Notes2Flow",
    elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
  };
}
