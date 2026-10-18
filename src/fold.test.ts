import { describe, expect, it } from "vitest";
import { computeFold } from "./fold.js";

const ids = ["s", "a", "d", "o1", "o2"];
const edges: [string, string][] = [
  ["s", "a"],
  ["a", "d"],
  ["d", "o1"],
  ["d", "o2"],
];

describe("branch folding", () => {
  it("hides nothing when nothing is folded", () => {
    const f = computeFold(ids, edges, new Set());
    expect(f.hidden.size).toBe(0);
    expect([...f.hasChildren].sort()).toEqual(["a", "d", "s"]);
  });

  it("hides everything downstream of a folded node and counts it", () => {
    const f = computeFold(ids, edges, new Set(["a"]));
    expect([...f.hidden].sort()).toEqual(["d", "o1", "o2"]);
    expect(f.hiddenCounts.get("a")).toBe(3);
  });

  it("keeps a node visible while another path still reaches it", () => {
    // s -> a -> d, and s -> d directly: folding a must not hide d.
    const f = computeFold(["s", "a", "d"], [["s", "a"], ["a", "d"], ["s", "d"]], new Set(["a"]));
    expect(f.hidden.size).toBe(0);
  });

  it("collapse-all leaves only the roots visible, and unfolding the root reveals one layer", () => {
    const all = new Set(f0(ids, edges));
    expect([...computeFold(ids, edges, all).hidden].sort()).toEqual(["a", "d", "o1", "o2"]);
    all.delete("s");
    expect([...computeFold(ids, edges, all).hidden].sort()).toEqual(["d", "o1", "o2"]);
  });

  it("never hides nodes that no root reaches (cycle islands)", () => {
    const f = computeFold(["r", "x", "y"], [["x", "y"], ["y", "x"]], new Set(["r", "x"]));
    expect(f.hidden.size).toBe(0);
  });
});

function f0(i: string[], e: [string, string][]): string[] {
  return [...computeFold(i, e, new Set()).hasChildren];
}
