import type { GraphWithStatus, Node, Edge } from "./schema.js";
import { normalizeText } from "./textmatch.js";

export type IssueKind =
  | "cycle"
  | "dangling"
  | "duplicate_label"
  | "unverified_provenance"
  | "missing_prereq"
  | "decision_without_options"
  | "no_start"
  | "dead_end"
  | "unreachable"
  | "decision_branches"
  | "unlabeled_branch";

export type IssueSeverity = "info" | "warn";

export interface Issue {
  kind: IssueKind;
  severity: IssueSeverity;
  message: string;
  targets: string[];
}

/**
 * Rule-based logic review (deterministic, free). Only rules that make sense for
 * the plan/argument map type run here. Every issue carries click-to-highlight
 * targets and never blocks the user.
 */
export function reviewGraph(graph: GraphWithStatus): Issue[] {
  const issues: Issue[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

  if (graph.map_type === "process") return reviewProcess(graph, edges);

  issues.push(...findCycles(graph, edges));
  issues.push(...findDangling(graph, edges));
  issues.push(...findDuplicateLabels(graph));
  issues.push(...findUnverified(graph));
  issues.push(...findDecisionsWithoutOptions(graph, edges));
  return issues;
}

/**
 * Ordering contradictions and dependency cycles.
 *
 * requires and next point in opposite time directions ("A requires B" means B
 * happens first; "A next B" means A happens first), so both are normalized to
 * happens-before edges (A before B) before cycle analysis. part_of is checked
 * separately for containment cycles.
 */
function findCycles(graph: GraphWithStatus, edges: Edge[]): Issue[] {
  const issues: Issue[] = [];
  const happensBefore = (e: Edge): [string, string] | null => {
    if (e.relation === "requires") return [e.to, e.from]; // B before A
    if (e.relation === "next") return [e.from, e.to]; // A before B
    if (e.relation === "causes") return [e.from, e.to]; // A before/at B
    return null;
  };

  const buildAdj = (pairs: [string, string][]): Map<string, string[]> => {
    const adj = new Map<string, string[]>();
    for (const [a, b] of pairs) {
      const list = adj.get(a) ?? [];
      list.push(b);
      adj.set(a, list);
    }
    return adj;
  };

  // Tarjan SCC over happens-before edges.
  const hbPairs = edges.map(happensBefore).filter((p): p is [string, string] => p !== null);
  const sccs = tarjanSCC(graph.nodes.map((n) => n.id), buildAdj(hbPairs));
  for (const scc of sccs) {
    if (scc.length < 2) continue;
    issues.push({
      kind: "cycle",
      severity: "warn",
      message:
        `Ordering contradiction or dependency loop: ${scc.map((id) => labelOf(graph, id)).join(" -> ")}. ` +
        `Do these steps really form a loop, or is one link wrong?`,
      targets: scc,
    });
  }

  // part_of containment cycles (A part_of B part_of A).
  const poPairs: [string, string][] = edges
    .filter((e) => e.relation === "part_of")
    .map((e) => [e.from, e.to]);
  const poSccs = tarjanSCC(graph.nodes.map((n) => n.id), buildAdj(poPairs));
  for (const scc of poSccs) {
    if (scc.length < 2) continue;
    issues.push({
      kind: "cycle",
      severity: "warn",
      message: `Containment loop: ${scc.map((id) => labelOf(graph, id)).join(" -> ")}. Something cannot be a part of itself.`,
      targets: scc,
    });
  }
  return issues;
}

/** Tarjan's strongly connected components (iterative; deterministic order). */
function tarjanSCC(nodes: string[], adj: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    // Iterative Tarjan: frame = [node, childIteratorIndex]
    const callStack: { node: string; childIdx: number }[] = [{ node: start, childIdx: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const children = adj.get(frame.node) ?? [];
      if (frame.childIdx < children.length) {
        const child = children[frame.childIdx]!;
        frame.childIdx++;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter++;
          stack.push(child);
          onStack.add(child);
          callStack.push({ node: child, childIdx: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
      } else {
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1]!;
          low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        }
        if (low.get(frame.node) === index.get(frame.node)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
          } while (w !== frame.node);
          result.push(scc);
        }
      }
    }
  }
  return result;
}

/** Nodes with no edges at all (possible orphaned thoughts). */
function findDangling(graph: GraphWithStatus, edges: Edge[]): Issue[] {
  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.from);
    connected.add(e.to);
  }
  return graph.nodes
    .filter((n) => !connected.has(n.id))
    .map((n) => ({
      kind: "dangling" as const,
      severity: "info" as const,
      message: `"${n.label}" is not connected to anything. Should it link to part of the plan, or is it a loose thought?`,
      targets: [n.id],
    }));
}

/** Near-identical labels that likely represent the same concept. */
function findDuplicateLabels(graph: GraphWithStatus): Issue[] {
  const issues: Issue[] = [];
  const seen = new Map<string, Node>();
  for (const n of graph.nodes) {
    // Unicode-aware normalization (CJK labels keep their characters).
    const key = normalizeText(n.label);
    if (key === "") continue;
    const first = seen.get(key);
    if (first) {
      issues.push({
        kind: "duplicate_label",
        severity: "warn",
        message: `"${first.label}" and "${n.label}" look like the same concept. Should they be merged?`,
        targets: [first.id, n.id],
      });
    } else {
      seen.set(key, n);
    }
  }
  return issues;
}

/** Elements whose quotes failed source verification (from extraction). */
function findUnverified(graph: GraphWithStatus): Issue[] {
  const issues: Issue[] = [];
  for (const n of graph.nodes) {
    if (n.provenance_status === "unverified") {
      issues.push({
        kind: "unverified_provenance",
        severity: "info",
        message: `Node "${n.label}" has no verifiable quote in the notes. Confirm it or remove it.`,
        targets: [n.id],
      });
    }
  }
  for (const e of graph.edges) {
    if (e.status === "unverified") {
      issues.push({
        kind: "unverified_provenance",
        severity: "info",
        message: `The "${e.relation}" link from "${labelOf(graph, e.from)}" lacks a verifiable quote. Confirm it or remove it.`,
        targets: [e.from, e.to],
      });
    }
  }
  return issues;
}

/** Decision nodes with fewer than two options attached via part_of. */
function findDecisionsWithoutOptions(graph: GraphWithStatus, edges: Edge[]): Issue[] {
  const optionsByDecision = new Map<string, number>();
  for (const e of edges) {
    if (e.relation === "part_of" && graph.nodes.find((n) => n.id === e.to)?.kind === "decision") {
      optionsByDecision.set(e.to, (optionsByDecision.get(e.to) ?? 0) + 1);
    }
  }
  const issues: Issue[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== "decision") continue;
    const count = optionsByDecision.get(n.id) ?? 0;
    if (count === 0) {
      issues.push({
        kind: "decision_without_options",
        severity: "info",
        message: `Decision "${n.label}" has no options linked to it. What are the alternatives?`,
        targets: [n.id],
      });
    } else if (count === 1) {
      issues.push({
        kind: "decision_without_options",
        severity: "info",
        message: `Decision "${n.label}" has only one option. A choice with a single alternative is not much of a choice — is another option missing?`,
        targets: [n.id],
      });
    }
  }
  return issues;
}

/**
 * Flowchart checks for process maps. Loops are legitimate here (retry/recheck steps),
 * so there is no cycle rule; instead every path must start somewhere, branch cleanly,
 * and end at an outcome.
 */
function reviewProcess(graph: GraphWithStatus, edges: Edge[]): Issue[] {
  const issues: Issue[] = [];
  const out = new Map<string, Edge[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);

  const explicitStarts = graph.nodes.filter((n) => n.kind === "start");
  const hasIncoming = new Set(edges.map((e) => e.to));
  // Models sometimes omit the start node; a single node nothing points at is an acceptable entry.
  const starts =
    explicitStarts.length > 0
      ? explicitStarts
      : graph.nodes.filter((n) => n.kind !== "note" && !hasIncoming.has(n.id));
  if (starts.length === 0) {
    issues.push({
      kind: "no_start",
      severity: "warn",
      message: "The flowchart has no start node. Where does the procedure begin?",
      targets: [],
    });
  } else if (starts.length > 1) {
    issues.push({
      kind: "no_start",
      severity: "warn",
      message: `The flowchart has ${starts.length} possible starting points (${starts.map((n) => `"${n.label}"`).join(", ")}). A procedure should have one.`,
      targets: starts.map((n) => n.id),
    });
  }

  for (const n of graph.nodes) {
    const leaving = out.get(n.id) ?? [];
    if (n.kind === "decision") {
      if (leaving.length < 2) {
        issues.push({
          kind: "decision_branches",
          severity: "warn",
          message: `Decision "${n.label}" has ${leaving.length === 0 ? "no" : "only one"} outgoing branch. Each answer needs its own path.`,
          targets: [n.id],
        });
      } else if (leaving.some((e) => !e.label)) {
        issues.push({
          kind: "unlabeled_branch",
          severity: "info",
          message: `Decision "${n.label}" has a branch with no answer label (Yes/No/...).`,
          targets: [n.id],
        });
      }
    } else if (n.kind !== "outcome" && n.kind !== "note" && leaving.length === 0) {
      issues.push({
        kind: "dead_end",
        severity: "warn",
        message: `"${n.label}" leads nowhere. Where does the flow go next, or should it be an outcome?`,
        targets: [n.id],
      });
    }
    if (n.kind === "outcome" && leaving.length > 0) {
      issues.push({
        kind: "dead_end",
        severity: "info",
        message: `Outcome "${n.label}" has arrows leaving it. Outcomes normally end the flow.`,
        targets: [n.id],
      });
    }
  }

  if (starts.length > 0) {
    const seen = new Set<string>(starts.map((n) => n.id));
    const queue = [...seen];
    while (queue.length > 0) {
      const id = queue.pop()!;
      for (const e of out.get(id) ?? []) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          queue.push(e.to);
        }
      }
    }
    for (const n of graph.nodes) {
      if (!seen.has(n.id) && n.kind !== "note") {
        issues.push({
          kind: "unreachable",
          severity: "warn",
          message: `"${n.label}" cannot be reached from the start. Is a link missing?`,
          targets: [n.id],
        });
      }
    }
  }

  issues.push(...findDuplicateLabels(graph));
  issues.push(...findUnverified(graph));
  return issues;
}

function labelOf(graph: GraphWithStatus, id: string): string {
  return graph.nodes.find((n) => n.id === id)?.label ?? id;
}
