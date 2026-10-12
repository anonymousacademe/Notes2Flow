import { describe, expect, it } from "vitest";
import { reviewGraph } from "./review.js";
import type { GraphWithStatus } from "./schema.js";

function graph(partial: Partial<GraphWithStatus>): GraphWithStatus {
  return {
    graph_id: "g",
    map_type: "plan",
    nodes: [],
    edges: [],
    ...partial,
  };
}

function n(id: string, label: string, kind: string = "claim"): any {
  return { id, label, kind, provenance: [{ source_range: "s", quote: "q" }], provenance_status: "verified" };
}

function e(from: string, to: string, relation: string): any {
  return { from, to, relation, grounding: "explicit", label: null, quote: "q", source_range: "s", status: "verified" };
}

describe("logic review", () => {
  it("detects a requires/next cycle", () => {
    const g = graph({
      nodes: [n("a", "Design"), n("b", "Permit"), n("c", "Build")],
      edges: [e("a", "b", "requires"), e("b", "c", "requires"), e("c", "a", "requires")],
    });
    const issues = reviewGraph(g);
    const cycles = issues.filter((i) => i.kind === "cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.targets).toContain("a");
    expect(cycles[0]!.severity).toBe("warn");
  });

  it("does not flag two-node support cycles (debate is not a dependency loop)", () => {
    const g = graph({
      nodes: [n("a", "Claim A"), n("b", "Claim B")],
      edges: [e("a", "b", "supports"), e("b", "a", "supports")],
    });
    expect(reviewGraph(g).filter((i) => i.kind === "cycle")).toHaveLength(0);
  });

  it("flags dangling nodes as info", () => {
    const g = graph({
      nodes: [n("a", "Connected"), n("lonely", "Loose thought")],
      edges: [e("a", "a2", "next")].filter(() => false),
    });
    const issues = reviewGraph(g);
    const d = issues.filter((i) => i.kind === "dangling");
    expect(d).toHaveLength(2); // both unconnected
    expect(d[0]!.severity).toBe("info");
  });

  it("flags duplicate labels", () => {
    const g = graph({
      nodes: [n("a", "Budget approval"), n("b", "budget  approval!")],
      edges: [],
    });
    const issues = reviewGraph(g);
    expect(issues.filter((i) => i.kind === "duplicate_label")).toHaveLength(1);
  });

  it("flags unverified provenance on nodes and edges", () => {
    const g = graph({
      nodes: [{ ...n("a", "Node"), provenance_status: "unverified" }, n("b", "Other")],
      edges: [{ ...e("b", "a", "causes"), status: "unverified" }],
    });
    const issues = reviewGraph(g);
    const unv = issues.filter((i) => i.kind === "unverified_provenance");
    expect(unv).toHaveLength(2);
    expect(unv.every((i) => i.severity === "info")).toBe(true);
  });

  it("flags decisions with zero or one option", () => {
    const g = graph({
      nodes: [n("d1", "Choose approach", "decision"), n("o1", "Only option", "option"), n("x", "Filler")],
      edges: [e("o1", "d1", "part_of")],
    });
    const msgs = reviewGraph(g).filter((i) => i.kind === "decision_without_options");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.message).toContain("only one option");
  });

  it("is quiet on a clean, well-formed graph", () => {
    const g = graph({
      nodes: [
        n("d", "Choose approach", "decision"),
        n("o1", "Option one", "option"),
        n("o2", "Option two", "option"),
        n("p", "Prereq", "prereq"),
        n("act", "Do the work", "action"),
      ],
      edges: [e("o1", "d", "part_of"), e("o2", "d", "part_of"), e("act", "p", "requires")],
    });
    const issues = reviewGraph(g);
    expect(issues.filter((i) => i.severity === "warn")).toHaveLength(0);
  });

  it("does not flag a consistent requires+next pair as a cycle (review finding #4)", () => {
    // "Write report requires Collect data" + "Collect data next Write report"
    // is consistent: collect happens first. Both normalize to collect < write.
    const g = graph({
      nodes: [n("collect", "Collect data"), n("write", "Write report")],
      edges: [e("write", "collect", "requires"), e("collect", "write", "next")],
    });
    expect(reviewGraph(g).filter((i) => i.kind === "cycle")).toHaveLength(0);
  });

  it("flags a real ordering contradiction (review finding #4b)", () => {
    // "A requires B" (B first) + "A next B" (A first) is contradictory.
    const g = graph({
      nodes: [n("a", "Design"), n("b", "Permit")],
      edges: [e("a", "b", "requires"), e("a", "b", "next")],
    });
    const cycles = reviewGraph(g).filter((i) => i.kind === "cycle");
    expect(cycles).toHaveLength(1);
  });

  it("reports each cycle SCC once (review finding #5)", () => {
    const g = graph({
      nodes: [n("a", "A"), n("b", "B"), n("c", "C")],
      edges: [e("a", "b", "next"), e("b", "a", "next"), e("c", "a", "next")],
    });
    const cycles = reviewGraph(g).filter((i) => i.kind === "cycle");
    expect(cycles).toHaveLength(1);
  });

  it("flags a part_of containment loop separately", () => {
    const g = graph({
      nodes: [n("a", "Team A"), n("b", "Team B")],
      edges: [e("a", "b", "part_of"), e("b", "a", "part_of")],
    });
    const cycles = reviewGraph(g).filter((i) => i.kind === "cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.message).toContain("Containment loop");
  });

  it("does not flag two different CJK labels as duplicates (review finding #13)", () => {
    const g = graph({ nodes: [n("a", "防洪规划"), n("b", "预算审批")], edges: [] });
    expect(reviewGraph(g).filter((i) => i.kind === "duplicate_label")).toHaveLength(0);
  });

  it("ignores edges pointing at dropped nodes when detecting cycles", () => {
    const g = graph({
      nodes: [n("a", "A")],
      edges: [e("a", "ghost", "requires"), e("ghost", "a", "requires")],
    });
    expect(reviewGraph(g).filter((i) => i.kind === "cycle")).toHaveLength(0);
  });
});
