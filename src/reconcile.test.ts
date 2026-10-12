import { describe, expect, it } from "vitest";
import { reconcile } from "./reconcile.js";
import type { GraphWithStatus } from "./schema.js";

function n(id: string, label: string): any {
  return { id, label, kind: "claim", provenance: [{ source_range: "s", quote: "q" }], provenance_status: "verified" };
}

function e(from: string, to: string, relation = "causes", status = "verified"): any {
  return { from, to, relation, grounding: "implied", label: null, quote: "q", source_range: "s", status };
}

function base(): GraphWithStatus {
  return {
    graph_id: "g1",
    map_type: "plan",
    nodes: [],
    edges: [],
    meta: { revision: 1 },
  };
}

describe("reconciliation", () => {
  it("keeps stable ids when labels match across re-extraction", () => {
    const prev = { ...base(), nodes: [n("old_1", "Stormwater flooding"), n("old_2", "Green infrastructure")], edges: [] };
    const freshNodes = [n("n17", "Stormwater flooding worsens"), n("n42", "Green infrastructure option")];
    const { graph, report } = reconcile(prev, { nodes: freshNodes, edges: [] });
    expect(graph.nodes[0]!.id).toBe("old_1");
    expect(graph.nodes[1]!.id).toBe("old_2");
    expect(report.keptIds).toBe(2);
    expect(report.newIds).toBe(0);
    expect(graph.meta?.revision).toBe(2);
  });

  it("transfers user-confirmed edge status across re-extraction", () => {
    const prev = {
      ...base(),
      nodes: [n("a", "Budget cap"), n("b", "Culvert cost")],
      edges: [e("a", "b", "contradicts", "user_confirmed")],
    };
    const fresh = {
      nodes: [n("x1", "Budget cap"), n("x2", "Culvert cost")],
      edges: [e("x1", "x2", "contradicts", "verified")],
    };
    const { graph, report } = reconcile(prev, fresh);
    expect(graph.edges[0]!.status).toBe("user_confirmed");
    expect(report.statusTransfers).toBe(1);
  });

  it("assigns new ids to genuinely new nodes", () => {
    const prev = { ...base(), nodes: [n("a", "Known concept")], edges: [] };
    const fresh = { nodes: [n("k1", "Known concept"), n("k2", "Brand new idea")], edges: [] };
    const { graph, report } = reconcile(prev, { nodes: fresh.nodes, edges: [] });
    expect(graph.nodes.find((x) => x.label.startsWith("Known"))!.id).toBe("a");
    expect(graph.nodes.find((x) => x.label.startsWith("Brand"))!.id).not.toBe("a");
    expect(report.newIds).toBe(1);
  });

  it("does not transfer status when the relation changed", () => {
    const prev = {
      ...base(),
      nodes: [n("a", "Alpha"), n("b", "Beta")],
      edges: [e("a", "b", "causes", "user_confirmed")],
    };
    const fresh = {
      nodes: [n("x1", "Alpha"), n("x2", "Beta")],
      edges: [e("x1", "x2", "contradicts", "verified")],
    };
    const { graph } = reconcile(prev, fresh);
    expect(graph.edges[0]!.status).toBe("verified");
  });

  it("remaps fresh edge ids so every edge endpoint exists (review finding #2)", () => {
    const prev = { ...base(), nodes: [n("a", "Alpha"), n("b", "Beta")], edges: [] };
    const fresh = {
      nodes: [n("x1", "Alpha"), n("x2", "Beta"), n("x3", "Gamma")],
      edges: [e("x1", "x2"), e("x2", "x3")],
    };
    const { graph } = reconcile(prev, fresh);
    const ids = new Set(graph.nodes.map((x) => x.id));
    for (const edge of graph.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
    // x2 -> x3 survives with remapped endpoints (x2 now has id "b").
    const second = graph.edges.find((x) => x.to === graph.nodes.find((nd) => nd.label === "Gamma")!.id);
    expect(second).toBeDefined();
    expect(second!.from).toBe("b");
  });
});
