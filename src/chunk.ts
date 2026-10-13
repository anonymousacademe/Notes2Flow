import { embed, cosine } from "./embeddings.js";
import { tokenSimilarity } from "./textmatch.js";

/** Split Markdown into chunks at top-level headings, respecting a size budget. */
export function splitIntoChunks(markdown: string, maxChunkChars = 12000): string[] {
  if (markdown.length <= maxChunkChars) return [markdown];
  const lines = markdown.split(/\r?\n/);
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    // Top-level heading (# or ##, but not deeper) starts a new section.
    if (/^#{1,2}\s/.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));

  // Oversized single sections are kept whole (splitting mid-section would
  // break quote grounding); merged output would exceed budget only rarely.
  const chunks: string[] = [];
  let buffer = "";
  for (const section of sections) {
    if (buffer.length > 0 && buffer.length + section.length > maxChunkChars) {
      chunks.push(buffer);
      buffer = section;
    } else {
      buffer = buffer.length === 0 ? section : buffer + "\n" + section;
    }
  }
  if (buffer.length > 0) chunks.push(buffer);
  return chunks;
}

export interface GraphPart {
  nodes: { id: string; label: string; kind: string; provenance: unknown[] }[];
  edges: { from: string; to: string; relation: string; [k: string]: unknown }[];
}

export interface MergeResult {
  nodes: GraphPart["nodes"];
  edges: GraphPart["edges"];
  merges: string[];
}

const MERGE_SIM_THRESHOLD = 0.86;

/** Part index of a namespaced node id ("c2_n7" -> 2); -1 for unprefixed ids. */
function partOf(nsId: string): number {
  const m = nsId.match(/^c(\d+)_/);
  return m ? Number(m[1]) : -1;
}

/**
 * Deterministically merge section graphs: namespace ids per part (chunks reuse
 * n1, n2...), embed all labels, union-find nodes whose similarity exceeds the
 * threshold (same kind, different parts, complete-linkage against the group's
 * first member), then remap edges through per-part id maps.
 */
export async function mergeSectionGraphs(parts: GraphPart[]): Promise<MergeResult> {
  const merges: string[] = [];
  // Namespace ids per part and build per-part id -> global index maps.
  const allNodes: GraphPart["nodes"] = [];
  const idToIndex = new Map<string, number>(); // namespaced id -> global index
  parts.forEach((p, pi) => {
    const localToGlobal = new Map<string, number>();
    for (const n of p.nodes) {
      const nsId = `c${pi}_${n.id}`;
      const idx = allNodes.length;
      allNodes.push({ ...n, id: nsId });
      idToIndex.set(nsId, idx);
      localToGlobal.set(n.id, idx);
    }
    void localToGlobal;
  });

  // Union-find over label similarity.
  const parent = allNodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  if (allNodes.length > 1) {
    let vectors: number[][] = [];
    try {
      vectors = await embed(allNodes.map((n) => n.label));
    } catch (err) {
      console.error(
        `note: embedding merge unavailable (${err instanceof Error ? err.message : err}); using token similarity only`,
      );
    }
    for (let i = 0; i < allNodes.length; i++) {
      for (let j = i + 1; j < allNodes.length; j++) {
        // Only merge across different chunks, and only same-kind nodes
        // (a decision must never merge into its own option).
        if (partOf(allNodes[i]!.id) === partOf(allNodes[j]!.id)) continue;
        if (allNodes[i]!.kind !== allNodes[j]!.kind) continue;
        let sim = tokenSimilarity(allNodes[i]!.label, allNodes[j]!.label);
        if (vectors.length > 0) {
          sim = Math.max(sim, 0.75 * cosine(vectors[i]!, vectors[j]!) + 0.25 * sim);
        }
        // Complete linkage against the group representative: candidate must
        // clear the threshold against every current member.
        const members = allNodes
          .map((_, k) => k)
          .filter((k) => find(k) === find(i));
        let ok = true;
        for (const k of members) {
          let mSim = tokenSimilarity(allNodes[j]!.label, allNodes[k]!.label);
          if (vectors.length > 0 && k !== i) {
            mSim = Math.max(mSim, 0.75 * cosine(vectors[j]!, vectors[k]!) + 0.25 * mSim);
          }
          if (mSim < MERGE_SIM_THRESHOLD) {
            ok = false;
            break;
          }
        }
        if (ok && sim >= MERGE_SIM_THRESHOLD) {
          union(i, j);
          merges.push(`"${allNodes[i]!.label}" ~ "${allNodes[j]!.label}" (sim ${sim.toFixed(2)})`);
        }
      }
    }
  }

  // Canonical representative per group = lowest index (first occurrence).
  const repIndex = new Map<number, number>();
  for (let i = 0; i < allNodes.length; i++) {
    const r = find(i);
    const cur = repIndex.get(r);
    if (cur === undefined || i < cur) repIndex.set(r, i);
  }
  const nodeToRep = new Map<number, number>();
  for (let i = 0; i < allNodes.length; i++) nodeToRep.set(i, repIndex.get(find(i))!);

  const kept = [...new Set(nodeToRep.values())].sort((a, b) => a - b);
  const newId = new Map<number, string>();
  const nodes = kept.map((ki, k) => {
    newId.set(ki, allNodes[ki]!.id);
    return allNodes[ki]!;
  });

  const seenEdges = new Set<string>();
  const edges: GraphPart["edges"] = [];
  // Namespace edge ids here rather than rewriting parts[i].edges, so the caller's input is left as it was.
  parts.forEach((p, pi) => {
    for (const e of p.edges) {
      const fi = idToIndex.get(`c${pi}_${e.from}`);
      const ti = idToIndex.get(`c${pi}_${e.to}`);
      if (fi === undefined || ti === undefined) continue;
      const rf = nodeToRep.get(fi)!;
      const rt = nodeToRep.get(ti)!;
      const from = newId.get(rf)!;
      const to = newId.get(rt)!;
      if (from === to) continue;
      const key = `${from}|${to}|${e.relation}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ ...e, from, to });
    }
  });
  // Final ids: strip the chunk namespace, keeping the representative's suffix.
  const finalNodes = nodes.map((n) => ({ ...n, id: n.id.replace(/^c\d+_/, "") }));
  const finalEdges = edges.map((e) => ({
    ...e,
    from: e.from.replace(/^c\d+_/, ""),
    to: e.to.replace(/^c\d+_/, ""),
  }));
  return { nodes: finalNodes, edges: finalEdges, merges };
}
