import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { GraphWithStatus } from "./schema.js";
import { tokenSimilarity, tokenJaccard, tokenContainment, hasNegation } from "./textmatch.js";
import { embed, cosine, flushCache } from "./embeddings.js";

// Token matcher calibrated by hand-labeling observed pairs from real fixtures:
// true matches cluster at 0.56-0.9, clear decoys below ~0.5. The embedding
// matcher (default) resolves synonym rephrasings the token matcher misses.
const NODE_MATCH_THRESHOLD = 0.55;
// Calibrated against hand-inspected pairs across all fixtures: true matches
// cluster at 0.65-1.0 (tail to 0.54), decoys top out ~0.56.
const EMBED_MATCH_THRESHOLD = 0.62;

export type MatcherKind = "token" | "embedding";

export interface SimilarityFn {
  kind: MatcherKind;
  score(a: string, b: string): number;
}

/**
 * Embedding-based matcher: every label is embedded once (cached), similarity is
 * 0.75 * cosine + 0.25 * token blend. Falls back to token-only when the API is
 * unreachable. Negation parity: if exactly one side contains a negator, the
 * score is capped so opposing claims never match.
 */
export async function createMatcher(kind: MatcherKind, labels: string[]): Promise<SimilarityFn> {
  if (kind === "token") return { kind, score: (a, b) => tokenSimilarity(a, b) };
  const all = [...new Set(labels)];
  const vecs = new Map<string, number[]>();
  try {
    const vectors = await embed(all);
    for (let i = 0; i < all.length; i++) vecs.set(all[i]!, vectors[i]!);
    await flushCache();
  } catch (err) {
    console.error(
      `note: embedding API unavailable (${err instanceof Error ? err.message : err}); falling back to token matcher`,
    );
    return { kind: "token", score: (a, b) => tokenSimilarity(a, b) };
  }
  return {
    kind: "embedding",
    score: (a, b) => {
      const va = vecs.get(a);
      const vb = vecs.get(b);
      if (!va || !vb) return tokenSimilarity(a, b);
      if (hasNegation(a) !== hasNegation(b)) return 0;
      return 0.75 * cosine(va, vb) + 0.25 * tokenSimilarity(a, b);
    },
  };
}

// Fixtures are hand-written with labels, not ids, so expected.json has its own
// simple schema (decoupled from the extraction wire schema).
const ExpectedGraph = z.object({
  nodes: z.array(z.object({ label: z.string(), kind: z.string().optional() })),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      relation: z.string(),
    }),
  ),
});
type ExpectedGraph = z.infer<typeof ExpectedGraph>;

interface NodeMatching {
  /** expected node index -> extracted node index */
  expectedToExtracted: Map<number, number>;
  /** extracted node index -> expected node index */
  extractedToExpected: Map<number, number>;
}

/**
 * Bipartite matching by descending similarity with deterministic tie-breaking
 * (score desc, then index order). Greedy on the sorted candidate list —
 * deterministic, near-optimal in practice; a full Hungarian assignment is a
 * possible later upgrade.
 */
function matchNodes(
  expected: { label: string }[],
  extracted: { label: string }[],
  sim: SimilarityFn,
  threshold: number,
): NodeMatching {
  const candidates: { e: number; x: number; s: number }[] = [];
  for (const [e, en] of expected.entries()) {
    for (const [x, xn] of extracted.entries()) {
      const s = sim.score(en.label, xn.label);
      if (s >= threshold) {
        candidates.push({ e, x, s });
      }
    }
  }
  candidates.sort((a, b) => b.s - a.s || a.e - b.e || a.x - b.x);
  const expectedToExtracted = new Map<number, number>();
  const extractedToExpected = new Map<number, number>();
  for (const cand of candidates) {
    if (expectedToExtracted.has(cand.e) || extractedToExpected.has(cand.x)) continue;
    expectedToExtracted.set(cand.e, cand.x);
    extractedToExpected.set(cand.x, cand.e);
  }
  return { expectedToExtracted, extractedToExpected };
}

export interface FixtureScores {
  fixture: string;
  nodeRecall: number;
  nodePrecision: number;
  /** directed endpoint match, no relation requirement */
  edgeRecall: number;
  edgePrecision: number;
  /** undirected endpoint match (direction-agnostic) */
  edgeUndirectedRecall: number;
  /** directed match AND same relation */
  edgeDirectedRelMatched: number;
  relationAgreement: number;
  provenanceVerifiedRate: number;
  verificationTiers?: Record<string, number>;
  details: {
    expectedNodes: number;
    extractedNodes: number;
    matchedNodes: number;
    expectedEdges: number;
    extractedEdges: number;
    matchedEdges: number;
    matchedUndirected: number;
    matchedDirectedRel: number;
    verifiedElements: number;
    totalElements: number;
  };
}

function buildExpectedIndex(expected: ExpectedGraph): Map<string, number> {
  const index = new Map<string, number>();
  for (const [i, n] of expected.nodes.entries()) {
    const key = n.label.trim().toLowerCase();
    if (!index.has(key)) index.set(key, i);
  }
  return index;
}

export function scoreGraph(
  expected: ExpectedGraph,
  extracted: GraphWithStatus,
  sim: SimilarityFn = { kind: "token", score: (a, b) => tokenSimilarity(a, b) },
): FixtureScores {
  const threshold = sim.kind === "embedding" ? EMBED_MATCH_THRESHOLD : NODE_MATCH_THRESHOLD;
  const { expectedToExtracted, extractedToExpected } = matchNodes(
    expected.nodes,
    extracted.nodes,
    sim,
    threshold,
  );
  const extractedIndexById = new Map<string, number>();
  for (const [i, n] of extracted.nodes.entries()) {
    if (!extractedIndexById.has(n.id)) extractedIndexById.set(n.id, i);
  }
  const expectedIndex = buildExpectedIndex(expected);

  const matchedNodes = expectedToExtracted.size;
  const nodeRecall = expected.nodes.length ? matchedNodes / expected.nodes.length : 1;
  const nodePrecision = extracted.nodes.length ? matchedNodes / extracted.nodes.length : 1;

  // Resolve expected edge endpoints to indices; a label not present in
  // expected.nodes is a fixture-authoring error, not a scoring event.
  const expectedEdgesResolved = expected.edges.map((ee) => {
    const fromIdx = expectedIndex.get(ee.from.trim().toLowerCase());
    const toIdx = expectedIndex.get(ee.to.trim().toLowerCase());
    if (fromIdx === undefined || toIdx === undefined) {
      throw new Error(
        `expected.json edge endpoint not found in nodes: "${fromIdx === undefined ? ee.from : ee.to}"`,
      );
    }
    return { fromIdx, toIdx, relation: ee.relation };
  });

  // Edge matching compares endpoint labels directly (many-to-one): extraction
  // may represent an expected node with a different-granularity node than the
  // greedy 1:1 node assignment chose. Best level wins per expected edge:
  // 3 = directed + same relation, 2 = directed, 1 = undirected.
  const simToExpected = (expectedLabel: string, extractedNodeId: string): boolean => {
    const node = extracted.nodes.find((n) => n.id === extractedNodeId);
    return node !== undefined && sim.score(expectedLabel, node.label) >= threshold;
  };

  const used = new Set<number>();
  let matchedDirected = 0;
  let matchedDirectedRel = 0;
  let matchedUndirected = 0;
  for (const ee of expectedEdgesResolved) {
    const eFromLabel = expected.nodes[ee.fromIdx]!.label;
    const eToLabel = expected.nodes[ee.toIdx]!.label;
    let best = 0;
    let bestIdx = -1;
    for (const [xi, xe] of extracted.edges.entries()) {
      if (used.has(xi)) continue;
      const forward =
        simToExpected(eFromLabel, xe.from) && simToExpected(eToLabel, xe.to);
      const backward =
        simToExpected(eFromLabel, xe.to) && simToExpected(eToLabel, xe.from);
      const relMatch = forward && xe.relation === ee.relation;
      const level = relMatch ? 3 : forward ? 2 : backward ? 1 : 0;
      if (level > best) {
        best = level;
        bestIdx = xi;
      }
    }
    if (best > 0 && bestIdx >= 0) {
      used.add(bestIdx);
      matchedUndirected++;
      if (best >= 2) matchedDirected++;
      if (best === 3) matchedDirectedRel++;
    }
  }

  const expectedEdges = expectedEdgesResolved.length;
  const extractedEdges = extracted.edges.length;
  const edgeRecall = expectedEdges ? matchedDirected / expectedEdges : 1;
  const edgePrecision = extractedEdges ? matchedDirected / extractedEdges : 1;
  const edgeUndirectedRecall = expectedEdges ? matchedUndirected / expectedEdges : 1;
  const relationAgreement = matchedDirected ? matchedDirectedRel / matchedDirected : 1;

  const totalElements = extracted.nodes.length + extracted.edges.length;
  const verifiedElements =
    extracted.nodes.filter((n) => n.provenance_status === "verified").length +
    extracted.edges.filter((e) => e.status === "verified").length;

  return {
    fixture: "",
    nodeRecall,
    nodePrecision,
    edgeRecall,
    edgePrecision,
    edgeUndirectedRecall,
    edgeDirectedRelMatched: matchedDirectedRel,
    relationAgreement,
    provenanceVerifiedRate: totalElements ? verifiedElements / totalElements : 1,
    verificationTiers: extracted.meta?.verification,
    details: {
      expectedNodes: expected.nodes.length,
      extractedNodes: extracted.nodes.length,
      matchedNodes,
      expectedEdges,
      extractedEdges,
      matchedEdges: matchedDirected,
      matchedUndirected,
      matchedDirectedRel,
      verifiedElements,
      totalElements,
    },
  };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

function printScores(s: FixtureScores): void {
  console.log(`Fixture: ${s.fixture}`);
  console.log(
    `  node recall ${pct(s.nodeRecall)} (${s.details.matchedNodes}/${s.details.expectedNodes}), ` +
      `node precision ${pct(s.nodePrecision)} (${s.details.matchedNodes}/${s.details.extractedNodes})`,
  );
  console.log(
    `  edge recall (directed) ${pct(s.edgeRecall)} (${s.details.matchedEdges}/${s.details.expectedEdges}), ` +
      `edge precision ${pct(s.edgePrecision)} (${s.details.matchedEdges}/${s.details.extractedEdges})`,
  );
  console.log(
    `  edge recall (undirected) ${pct(s.edgeUndirectedRecall)}, ` +
      `relation agreement on directed matches: ${pct(s.relationAgreement)}`,
  );
  console.log(
    `  provenance verified: ${pct(s.provenanceVerifiedRate)} (${s.details.verifiedElements}/${s.details.totalElements})`,
  );
  if (s.verificationTiers) {
    const t = s.verificationTiers;
    console.log(`  quote tiers: exact ${t.exact ?? 0}, normalized ${t.normalized ?? 0}, fuzzy ${t.fuzzy ?? 0}, unverified ${t.unverified ?? 0}`);
  }
}

async function evalFixture(dir: string, extractedName: string, sim: SimilarityFn): Promise<FixtureScores> {
  const [expectedRaw, extractedRaw] = await Promise.all([
    readFile(join(dir, "expected.json"), "utf8"),
    readFile(join(dir, extractedName), "utf8"),
  ]);
  const scores = scoreGraph(
    ExpectedGraph.parse(JSON.parse(expectedRaw)),
    GraphWithStatus.parse(JSON.parse(extractedRaw)),
    sim,
  );
  scores.fixture = dir.split(/[\\/]/).at(-1) ?? dir;
  printScores(scores);
  return scores;
}

function average(scores: FixtureScores[], pick: (s: FixtureScores) => number): number {
  if (scores.length === 0) return 0;
  return scores.reduce((a, s) => a + pick(s), 0) / scores.length;
}

function microAverage(
  scores: FixtureScores[],
  num: (s: FixtureScores) => number,
  den: (s: FixtureScores) => number,
): number {
  const n = scores.reduce((a, s) => a + den(s), 0);
  return n === 0 ? 0 : scores.reduce((a, s) => a + num(s), 0) / n;
}

function summaryLine(scores: FixtureScores[]): string {
  const rel = (s: FixtureScores) => s.details.matchedDirectedRel;
  return (
    `macro: node recall ${pct(average(scores, (s) => s.nodeRecall))}, ` +
    `node precision ${pct(average(scores, (s) => s.nodePrecision))}, ` +
    `edge recall ${pct(average(scores, (s) => s.edgeRecall))}, ` +
    `edge precision ${pct(average(scores, (s) => s.edgePrecision))}, ` +
    `relation agreement ${pct(average(scores, (s) => s.relationAgreement))}, ` +
    `provenance verified ${pct(average(scores, (s) => s.provenanceVerifiedRate))}\n` +
    `micro: node recall ${pct(microAverage(scores, (s) => s.details.matchedNodes, (s) => s.details.expectedNodes))}, ` +
    `edge recall ${pct(microAverage(scores, (s) => s.details.matchedEdges, (s) => s.details.expectedEdges))}, ` +
    `edge precision ${pct(microAverage(scores, (s) => s.details.matchedEdges, (s) => s.details.extractedEdges))}, ` +
    `directed+relation matches ${scores.reduce((a, s) => a + rel(s), 0)}`
  );
}

function isMain(): boolean {
  try {
    const here = resolve(fileURLToPath(import.meta.url));
    const invoked = resolve(process.argv[1] ?? "");
    if (process.platform === "win32") return here.toLowerCase() === invoked.toLowerCase();
    return here === invoked;
  } catch {
    return false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const fixturesDirIdx = argv.indexOf("--fixtures");
  const dir = fixturesDirIdx >= 0 ? (argv[fixturesDirIdx + 1] ?? "fixtures") : "fixtures";
  const extractedIdx = argv.indexOf("--extracted");
  const extractedName = extractedIdx >= 0 ? (argv[extractedIdx + 1] ?? "notes.extracted.json") : "notes.extracted.json";
  const matcherIdx = argv.indexOf("--matcher");
  const matcherKind: MatcherKind = matcherIdx >= 0 && argv[matcherIdx + 1] === "token" ? "token" : "embedding";
  const entries = await readdir(dir, { withFileTypes: true });
  const fixtureDirs = entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));

  // Pre-read fixtures to collect all labels, then build the matcher once.
  const parsedFixtures: { dir: string; expected: ExpectedGraph; extracted: GraphWithStatus }[] = [];
  const skipped: string[] = [];
  for (const d of fixtureDirs) {
    try {
      const [expectedRaw, extractedRaw] = await Promise.all([
        readFile(join(d, "expected.json"), "utf8"),
        readFile(join(d, extractedName), "utf8"),
      ]);
      parsedFixtures.push({
        dir: d,
        expected: ExpectedGraph.parse(JSON.parse(expectedRaw)),
        extracted: GraphWithStatus.parse(JSON.parse(extractedRaw)),
      });
    } catch (err) {
      skipped.push(d);
      console.log(`Fixture: ${d}\n  SKIPPED (${err instanceof Error ? err.message : err})`);
    }
  }

  const allLabels = [
    ...parsedFixtures.flatMap((f) => f.expected.nodes.map((n) => n.label)),
    ...parsedFixtures.flatMap((f) => f.extracted.nodes.map((n) => n.label)),
  ];
  const sim = await createMatcher(matcherKind, allLabels);
  console.log(`matcher: ${sim.kind}`);

  const scores: FixtureScores[] = [];
  for (const f of parsedFixtures) {
    const scoresOne = scoreGraph(f.expected, f.extracted, sim);
    scoresOne.fixture = f.dir.split(/[\\/]/).at(-1) ?? f.dir;
    printScores(scoresOne);
    scores.push(scoresOne);
  }

  if (scores.length > 0) {
    console.log(`\n=== Summary over ${scores.length} fixture(s), matcher: ${sim.kind} ===`);
    console.log(summaryLine(scores));
  }
  if (skipped.length > 0) {
    console.error(`\nERROR: ${skipped.length} fixture(s) skipped — fix before trusting the averages`);
    process.exit(1);
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
