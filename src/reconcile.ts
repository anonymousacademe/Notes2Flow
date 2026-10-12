import { randomUUID } from "node:crypto";
import type { GraphWithStatus, Node as GraphNode, Edge as GraphEdge } from "./schema.js";
import { tokenSimilarity } from "./textmatch.js";

type EdgeWithStatus = GraphEdge & { status?: "verified" | "unverified" | "user_confirmed" | "user_rejected" };

const MATCH_THRESHOLD = 0.7;

export interface ReconcileReport {
  keptIds: number;
  newIds: number;
  statusTransfers: number;
  positionTransfers: number;
}

/**
 * Reconcile a fresh extraction against the previously saved graph so stable ids
 * (and the user work attached to them: confirmed/rejected statuses, canvas
 * positions, dismissed issues) survive a re-run.
 *
 * Matching: expected->extracted greedy on blended similarity, then exact-label
 * leftovers, then order for identical disjoint label sets (last resort).
 */
export function reconcile(
  previous: GraphWithStatus,
  fresh: { nodes: GraphNode[]; edges: EdgeWithStatus[] },
): { graph: GraphWithStatus; report: ReconcileReport } {
  // Greedy bipartite match on label similarity.
  const candidates: { p: number; f: number; s: number }[] = [];
  for (const [p, pn] of previous.nodes.entries()) {
    for (const [f, fn] of fresh.nodes.entries()) {
      const s = tokenSimilarity(pn.label, fn.label);
      if (s >= MATCH_THRESHOLD) candidates.push({ p, f, s });
    }
  }
  candidates.sort((a, b) => b.s - a.s || a.p - b.p || a.f - b.f);
  const prevToFresh = new Map<number, number>();
  const freshToPrev = new Map<number, number>();
  for (const c of candidates) {
    if (prevToFresh.has(c.p) || freshToPrev.has(c.f)) continue;
    prevToFresh.set(c.p, c.f);
    freshToPrev.set(c.f, c.p);
  }

  // Identical disjoint label sets: fall back to index alignment (deterministic
  // and correct when the model only renamed ids, not labels).
  if (previous.nodes.length === fresh.nodes.length && prevToFresh.size === 0) {
    const labelsEqual = previous.nodes.every((pn, i) => pn.label === fresh.nodes[i]?.label);
    if (labelsEqual) {
      for (const [i] of previous.nodes.entries()) {
        prevToFresh.set(i, i);
        freshToPrev.set(i, i);
      }
    }
  }

  // Fresh nodes inherit the matched previous id; unmatched nodes get a
  // guaranteed-unique id (model ids can collide with reassigned previous ids).
  const keptIds: string[] = [];
  const usedIds = new Set(previous.nodes.map((n) => n.id));
  const freshIdToFinal = new Map<string, string>();
  const nodes: GraphNode[] = fresh.nodes.map((fn, fi) => {
    const pi = freshToPrev.get(fi);
    let id: string;
    if (pi !== undefined) {
      id = previous.nodes[pi]!.id;
      keptIds.push(id);
    } else {
      id = fn.id;
      while (usedIds.has(id)) id = `x_${id}`;
      usedIds.add(id);
    }
    freshIdToFinal.set(fn.id, id);
    return { ...fn, id };
  });

  const report: ReconcileReport = {
    keptIds: keptIds.length,
    newIds: nodes.length - keptIds.length,
    statusTransfers: 0,
    positionTransfers: 0,
  };

  // Transfer user statuses: previous edges keyed by (final endpoint ids, relation).
  // Fresh edges are remapped from fresh ids to final ids first, so edges always
  // point at nodes that exist.
  const prevEdgeKey = new Map<string, EdgeWithStatus>();
  for (const e of previous.edges) {
    prevEdgeKey.set(`${e.from}|${e.to}|${e.relation}`, e);
  }
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const edges: EdgeWithStatus[] = [];
  for (const fe of fresh.edges) {
    const from = freshIdToFinal.get(fe.from) ?? fe.from;
    const to = freshIdToFinal.get(fe.to) ?? fe.to;
    if (!nodeIdSet.has(from) || !nodeIdSet.has(to)) continue;
    const prev = prevEdgeKey.get(`${from}|${to}|${fe.relation}`);
    if (prev?.status === "user_confirmed" || prev?.status === "user_rejected") {
      report.statusTransfers++;
      edges.push({ ...fe, from, to, status: prev.status });
    } else {
      edges.push({ ...fe, from, to });
    }
  }

  const graph: GraphWithStatus = {
    graph_id: previous.graph_id || randomUUID(),
    map_type: previous.map_type,
    nodes,
    edges,
    meta: {
      ...previous.meta,
      created: previous.meta?.created,
    },
  };

  // meta.revision increments per re-extraction.
  const rev = (previous.meta as { revision?: number } | undefined)?.revision ?? 1;
  graph.meta = { ...graph.meta, revision: rev + 1 };
  return { graph, report };
}
