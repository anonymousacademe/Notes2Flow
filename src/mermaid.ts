import { Graph, GraphWithStatus, type Graph as GraphT } from "./schema.js";

const SHAPE: Record<string, string> = {
  decision: "{%s}",
  question: "{{%s}}",
  start: "([%s])",
  outcome: "([%s])",
};

// Mermaid reserved words that cannot be used as node ids.
const RESERVED_IDS = new Set([
  "end", "graph", "subgraph", "class", "style", "click", "direction", "flowchart",
]);

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/#/g, "#35;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;")
    .replace(/"/g, "#quot;")
    .replace(/[\r\n]+/g, " ");
}

const RELATION_LABEL: Record<string, string> = {
  causes: "causes",
  requires: "requires",
  supports: "supports",
  contradicts: "contradicts",
  part_of: "part of",
  next: "then",
};

// Mermaid bracket syntax for user-chosen shapes (overrides the per-kind default).
const STYLE_SHAPE: Record<string, string> = {
  rectangle: "[%s]",
  rounded: "(%s)",
  pill: "([%s])",
  diamond: "{%s}",
  ellipse: "((%s))",
};

/** Export-only: canonical graph -> Mermaid flowchart TD. Never parsed back. */
export function toMermaid(graph: GraphT): string {
  const lines: string[] = ["flowchart TD"];
  const styleLines: string[] = [];
  for (const node of graph.nodes) {
    if (RESERVED_IDS.has(node.id)) {
      throw new Error(`node id "${node.id}" is a reserved Mermaid word`);
    }
    const userStyle = (node as { style?: { shape?: string; color?: string } }).style;
    const shape =
      (userStyle?.shape ? STYLE_SHAPE[userStyle.shape] : undefined) ?? SHAPE[node.kind] ?? "[%s]";
    const head = shape.slice(0, shape.indexOf("%s"));
    const tail = shape.slice(shape.indexOf("%s") + 2);
    const status =
      "provenance_status" in node && (node as any).provenance_status === "unverified" ? " [?]" : "";
    const details = (node as { details?: string[] }).details ?? [];
    const body = [esc(node.label) + status, ...details.map((d) => `- ${esc(d)}`)].join("<br/>");
    lines.push(`  ${node.id}${head}"${body}"${tail}`);
    if (userStyle?.color && /^#[0-9a-fA-F]{6}$/.test(userStyle.color)) {
      styleLines.push(`  style ${node.id} fill:${userStyle.color}`);
    }
  }
  for (const edge of graph.edges) {
    if (RESERVED_IDS.has(edge.from) || RESERVED_IDS.has(edge.to)) {
      throw new Error(`edge references reserved Mermaid id`);
    }
    const status = "status" in edge && (edge as any).status === "unverified" ? " -.->" : " -->";
    if (graph.map_type === "process") {
      lines.push(edge.label ? `  ${edge.from}${status}|"${esc(edge.label)}"| ${edge.to}` : `  ${edge.from}${status} ${edge.to}`);
      continue;
    }
    const rel = RELATION_LABEL[edge.relation] ?? edge.relation;
    const label = edge.label ? `${rel}: ${esc(edge.label)}` : rel;
    lines.push(`  ${edge.from}${status}|"${label}"| ${edge.to}`);
  }
  return [...lines, ...styleLines].join("\n");
}

/** Validate an unknown object as a canonical graph. Throws on failure. */
export function parseGraph(json: unknown): GraphT {
  return Graph.parse(json);
}

export function parseGraphWithStatus(json: unknown) {
  return GraphWithStatus.parse(json);
}
