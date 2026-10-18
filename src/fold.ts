export interface FoldInfo {
  /** Nodes currently hidden because an ancestor is folded. */
  hidden: Set<string>;
  /** For each folded node, how many nodes its fold hides. */
  hiddenCounts: Map<string, number>;
  /** Nodes with at least one outgoing edge (the ones that can be folded). */
  hasChildren: Set<string>;
}

/**
 * Branch folding for the canvas (view-only; the graph itself is never changed).
 *
 * Folding a node hides everything downstream of it that cannot be reached another way:
 * a node stays visible while any path from a root (a node nothing points at) reaches it
 * without passing through a folded node. Nodes unreachable from any root (cycle-only
 * islands) are never hidden.
 */
export function computeFold(ids: string[], edges: [string, string][], folded: ReadonlySet<string>): FoldInfo {
  const out = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const [from, to] of edges) {
    const list = out.get(from);
    if (list) list.push(to);
    else out.set(from, [to]);
    hasIncoming.add(to);
  }
  const hasChildren = new Set(out.keys());
  const roots = ids.filter((id) => !hasIncoming.has(id));

  const reach = (starts: string[], stopAtFolded: boolean): Set<string> => {
    const seen = new Set<string>(starts);
    const stack = [...starts];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (stopAtFolded && folded.has(id)) continue;
      for (const next of out.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return seen;
  };

  const hidden = new Set<string>();
  const hiddenCounts = new Map<string, number>();
  if (folded.size > 0 && roots.length > 0) {
    const everything = reach(roots, false);
    const visible = reach(roots, true);
    for (const id of everything) if (!visible.has(id)) hidden.add(id);
    for (const f of folded) {
      if (!hasChildren.has(f)) continue;
      let count = 0;
      for (const id of reach([f], false)) if (id !== f && hidden.has(id)) count++;
      hiddenCounts.set(f, count);
    }
  }
  return { hidden, hiddenCounts, hasChildren };
}
