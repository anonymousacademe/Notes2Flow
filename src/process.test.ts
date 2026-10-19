import { describe, expect, it } from "vitest";
import { reviewGraph } from "./review.js";
import { toMermaid } from "./mermaid.js";
import { repairGraph, systemPrompt } from "./extract.js";
import type { GraphWithStatus } from "./schema.js";

function graph(partial: Partial<GraphWithStatus>): GraphWithStatus {
  return { graph_id: "g", map_type: "process", nodes: [], edges: [], ...partial };
}

function n(id: string, label: string, kind: string, details?: string[]): any {
  return {
    id,
    label,
    kind,
    ...(details ? { details } : {}),
    provenance: [{ source_range: "s", quote: "q" }],
    provenance_status: "verified",
  };
}

function e(from: string, to: string, label: string | null = null): any {
  return { from, to, relation: "next", grounding: "explicit", label, quote: "q", source_range: "s", status: "verified" };
}

describe("process prompt", () => {
  it("is selected by map type and differs from the idea-map prompt", () => {
    expect(systemPrompt("medium", "process")).toContain("process flowchart");
    expect(systemPrompt("medium", "process")).toContain("outcome");
    expect(systemPrompt("medium")).toContain("argument/plan structure");
  });
});

describe("process review", () => {
  const good = graph({
    nodes: [n("s", "Begin", "start"), n("d", "Emergency?", "decision"), n("o1", "Call 911", "outcome"), n("o2", "Home care", "outcome")],
    edges: [e("s", "d"), e("d", "o1", "Yes"), e("d", "o2", "No")],
  });

  it("finds nothing wrong with a clean flow", () => {
    expect(reviewGraph(good)).toEqual([]);
  });

  it("allows loops (retry steps are legitimate)", () => {
    const g = graph({
      nodes: [n("s", "Begin", "start"), n("a", "Give treatment", "step"), n("d", "Better?", "decision"), n("o", "Done", "outcome")],
      edges: [e("s", "a"), e("a", "d"), e("d", "a", "No"), e("d", "o", "Yes")],
    });
    expect(reviewGraph(g)).toEqual([]);
  });

  it("accepts a single unreferenced node as the entry when there is no start node", () => {
    const g = graph({
      nodes: [n("a", "Step A", "step"), n("d", "Ok?", "decision"), n("o1", "A", "outcome"), n("o2", "B", "outcome")],
      edges: [e("a", "d"), e("d", "o1", "Yes"), e("d", "o2", "No")],
    });
    expect(reviewGraph(g)).toEqual([]);
  });

  it("flags several possible starts, dead ends and thin decisions", () => {
    const g = graph({
      nodes: [n("a", "Step A", "step"), n("d", "Ok?", "decision"), n("o", "End", "outcome"), n("x", "Orphan", "step")],
      edges: [e("a", "d"), e("d", "o", "Yes")],
    });
    const kinds = reviewGraph(g).map((i) => i.kind);
    expect(kinds).toContain("no_start");
    expect(kinds).toContain("decision_branches");
    expect(kinds).toContain("dead_end"); // orphan step has no exit
  });

  it("flags unreachable nodes once a start exists", () => {
    const g = graph({
      nodes: [n("s", "Begin", "start"), n("o", "End", "outcome"), n("x", "Orphan", "step")],
      edges: [e("s", "o"), e("x", "o")],
    });
    const issues = reviewGraph(g);
    expect(issues.some((i) => i.kind === "unreachable" && i.targets.includes("x"))).toBe(true);
  });

  it("notes decision branches without answer labels", () => {
    const g = graph({
      nodes: [n("s", "Begin", "start"), n("d", "Ok?", "decision"), n("o1", "A", "outcome"), n("o2", "B", "outcome")],
      edges: [e("s", "d"), e("d", "o1", "Yes"), e("d", "o2")],
    });
    expect(reviewGraph(g).map((i) => i.kind)).toContain("unlabeled_branch");
  });
});

describe("process export and repair", () => {
  it("renders branch labels, terminal shapes and details in Mermaid", () => {
    const g = graph({
      nodes: [n("s", "Begin", "start"), n("d", "Any red flag?", "decision", ["Blue lips", "Unresponsive"]), n("o", "Call 911", "outcome")],
      edges: [e("s", "d"), e("d", "o", "Yes")],
    });
    const m = toMermaid(g);
    expect(m).toContain('s(["Begin"])');
    expect(m).toContain('d{"Any red flag?<br/>- Blue lips<br/>- Unresponsive"}');
    expect(m).toContain('d -->|"Yes"| o');
    expect(m).toContain("s --> d");
    expect(m).not.toContain("then");
  });

  it("repairs unknown kinds to step and keeps details in process mode", () => {
    const { parsed } = repairGraph(
      {
        nodes: [
          { id: "a", label: "Do thing", kind: "bogus", details: [" one ", "", "two"], provenance: [{ source_range: "s", quote: "q" }] },
        ],
        edges: [],
      },
      "process",
    );
    expect(parsed.nodes[0]!.kind).toBe("step");
    expect(parsed.nodes[0]!.details).toEqual(["one", "two"]);
  });
});
