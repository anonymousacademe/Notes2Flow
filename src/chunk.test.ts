import { describe, expect, it, vi } from "vitest";

// Offline: the merge falls back to token similarity, which is all these cases need.
vi.mock("./embeddings.js", () => ({
  embed: async () => {
    throw new Error("offline");
  },
  cosine: () => 0,
}));

import { mergeSectionGraphs, type GraphPart } from "./chunk.js";

function part(nodeIds: string[], edges: [string, string][]): GraphPart {
  return {
    nodes: nodeIds.map((id) => ({ id, label: `step ${id}`, kind: "step", provenance: [] })),
    edges: edges.map(([from, to]) => ({ from, to, relation: "leads_to" })),
  };
}

describe("mergeSectionGraphs", () => {
  it("leaves the caller's parts unchanged", async () => {
    const parts = [part(["a", "b"], [["a", "b"]]), part(["a", "c"], [["a", "c"]])];
    const before = structuredClone(parts);

    await mergeSectionGraphs(parts);

    expect(parts).toEqual(before);
  });

  it("still namespaces and remaps the merged edges", async () => {
    const parts = [part(["a", "b"], [["a", "b"]]), part(["x", "y"], [["x", "y"]])];

    const merged = await mergeSectionGraphs(parts);

    expect(merged.edges.length).toBe(2);
    const nodeIds = new Set(merged.nodes.map((n) => n.id));
    for (const e of merged.edges) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }
  });
});
