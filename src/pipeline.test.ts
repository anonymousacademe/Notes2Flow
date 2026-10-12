import { describe, expect, it } from "vitest";
import { normalizeText, tokenSimilarity, tokenContainment, tokenJaccard, verifyQuote } from "./textmatch.js";

import { toMermaid } from "./mermaid.js";
import { toExcalidraw } from "./excalidraw.js";
import { scoreGraph } from "./eval.js";
import { jsonSchemaFor, Node, Graph, GraphWithStatus } from "./schema.js";
import { extractJson } from "./transport.js";
import { repairGraph } from "./extract.js";

describe("quote verification", () => {
  const source =
    "## Problem\nUrban flooding is worsening due to impervious surfaces. We propose green infrastructure as a solution.";

  it("verifies exact quotes", () => {
    expect(verifyQuote("Urban flooding is worsening", source)).toMatchObject({ verified: true, method: "exact" });
  });

  it("verifies normalized quotes (case/punctuation/whitespace slips)", () => {
    expect(verifyQuote("urban  flooding is WORSENING", source)).toMatchObject({ verified: true, method: "normalized" });
    expect(verifyQuote("we propose green infrastructure as a SOLUTION", source)).toMatchObject({
      verified: true,
      method: "normalized",
    });
  });

  it("verifies fuzzy quotes via ordered sliding window", () => {
    expect(verifyQuote("Urban flooding is worsening due impervious surfaces", source)).toMatchObject({
      verified: true,
      method: "fuzzy",
    });
  });

  it("rejects fabricated quotes even when all their words appear somewhere in a long source", () => {
    // Regression for review finding #1: whole-vocabulary containment used to
    // pass invented sentences on long documents.
    const longSource = [
      "The steering committee meets quarterly to review the program budget and the staffing plan.",
      "Budget approval authority rests with the finance office, and the staffing plan is revised each spring.",
      "Node approval is handled by the review board. The approval office keeps records of every plan revision.",
      "The office also tracks which plan documents were returned for revision, and which were approved.",
    ].join(" ");
    const r1 = verifyQuote("the plan requires a new budget approval", longSource);
    const r2 = verifyQuote("the owner approves the node without a check", longSource);
    expect(r1.verified).toBe(false);
    expect(r2.verified).toBe(false);
  });

  it("rejects fabricated quotes outright", () => {
    expect(verifyQuote("Coastal erosion is caused by wind", source).verified).toBe(false);
  });

  it("rejects quotes that are too short or too long", () => {
    expect(verifyQuote("green infrastructure", source).reason).toBe("too_short");
    expect(verifyQuote("word ".repeat(50), source).reason).toBe("too_long");
  });

  it("normalizes punctuation and unicode", () => {
    expect(normalizeText("Hello, world!  It's fine.")).toBe("hello world it s fine");
  });
});

describe("label similarity", () => {
  it("containment is subset-fraction of content words", () => {
    expect(tokenContainment("urban flooding", "urban flooding is worsening")).toBe(1);
    expect(tokenContainment("urban flooding", "rural drainage")).toBe(0);
  });

  it("blend matches true paraphrases and rejects subset decoys", () => {
    // true paraphrase-ish matches
    expect(tokenSimilarity("Urban flooding problem", "Urban flooding")).toBeGreaterThanOrEqual(0.7);
    expect(tokenSimilarity("Green infrastructure option", "Green infrastructure")).toBeGreaterThanOrEqual(0.7);
    // decoys from review finding #3
    expect(tokenSimilarity("Funding", "Funding gap blocks the entire pilot")).toBeLessThan(0.7);
    expect(tokenSimilarity("Hallucinated node", "Missing node")).toBeLessThan(0.7);
  });

  it("negation parity: a claim and its negation never match (review finding #3)", () => {
    expect(tokenSimilarity("Use green roofs", "Do not use green roofs")).toBeLessThanOrEqual(0.5);
    expect(tokenSimilarity("Use green roofs", "Use green roofs")).toBe(1);
  });

  it("jaccard is union-normalized (stopwords excluded)", () => {
    expect(tokenJaccard("urban flooding", "urban flooding")).toBe(1);
    expect(tokenJaccard("urban flooding", "urban flooding is worsening")).toBeCloseTo(2 / 3);
  });
});

describe("mermaid export", () => {
  const graph = {
    graph_id: "g1",
    map_type: "plan" as const,
    nodes: [
      { id: "problem", label: "Urban flooding", kind: "claim" as const, provenance: [{ source_range: "x", quote: "q" }] },
      {
        id: "choose_gi",
        label: 'Adopt #green <infrastructure>',
        kind: "decision" as const,
        provenance: [{ source_range: "x", quote: "q" }],
      },
    ],
    edges: [
      {
        id: "e1",
        from: "problem",
        to: "choose_gi",
        relation: "causes" as const,
        grounding: "explicit" as const,
        label: null,
        quote: "q",
        source_range: "x",
      },
    ],
  };

  it("renders decisions as diamonds, labels edges, escapes unsafe characters", () => {
    const m = toMermaid(graph);
    expect(m).toContain('problem["Urban flooding"]');
    expect(m).toContain('choose_gi{"Adopt #35;green &lt;infrastructure&gt;"}');
    expect(m).toContain('problem -->|"causes"| choose_gi');
  });

  it("honors user shape/color overrides and leaves other nodes alone", () => {
    const m = toMermaid({
      ...graph,
      nodes: [
        { ...graph.nodes[0]!, style: { shape: "pill" as const, color: "#ffcc00" } } as unknown as (typeof graph.nodes)[number],
        graph.nodes[1]!,
      ],
    });
    expect(m).toContain('problem(["Urban flooding"])');
    expect(m).toContain("style problem fill:#ffcc00");
    expect(m).toContain('choose_gi{"Adopt #35;green &lt;infrastructure&gt;"}');
    expect(toMermaid(graph)).not.toContain("style ");
  });

  it("rejects reserved mermaid ids", () => {
    expect(() =>
      toMermaid({
        ...graph,
        nodes: [{ ...graph.nodes[0]!, id: "end" }],
        edges: [],
      }),
    ).toThrow(/reserved/);
  });
});

describe("excalidraw export of user edits", () => {
  const base = {
    graph_id: "g1",
    map_type: "plan" as const,
    nodes: [
      { id: "a", label: "Plain claim", kind: "claim" as const, provenance: [{ source_range: "x", quote: "q" }] },
      {
        id: "b",
        label: "Styled claim",
        kind: "claim" as const,
        provenance: [{ source_range: "x", quote: "q" }],
        style: { shape: "ellipse" as const, color: "#2563eb" },
      },
      { id: "c", label: "A decision", kind: "decision" as const, provenance: [{ source_range: "x", quote: "q" }] },
    ],
    edges: [],
  };

  it("uses per-kind defaults, and user shape/color when set", () => {
    const els = toExcalidraw(base).elements;
    const byId = (id: string) => els.find((e) => e.id === id)!;
    expect(byId("a").type).toBe("rectangle");
    expect(byId("a").roundness).not.toBeNull();
    expect(byId("c").type).toBe("diamond");
    expect(byId("b").type).toBe("ellipse");
    expect(byId("b").backgroundColor).toBe("#2563eb");
    // dark custom fill gets light text
    expect(byId("b_label").strokeColor).toBe("#ffffff");
  });
});

describe("user-added graph content", () => {
  it("GraphWithStatus accepts user_added nodes with a style and user_confirmed edges", () => {
    const parsed = GraphWithStatus.parse({
      graph_id: "u",
      map_type: "plan",
      nodes: [
        {
          id: "u1",
          label: "My idea",
          kind: "note",
          provenance: [{ source_range: "user-added", quote: "(added by user)" }],
          provenance_status: "user_added",
          style: { shape: "pill", color: "#a1b2c3" },
        },
      ],
      edges: [],
    });
    expect(parsed.nodes[0]!.style?.shape).toBe("pill");
    expect(() =>
      GraphWithStatus.parse({
        graph_id: "u",
        map_type: "plan",
        nodes: [
          {
            id: "u1",
            label: "x",
            kind: "note",
            provenance: [{ source_range: "s", quote: "q" }],
            style: { color: "red" },
          },
        ],
        edges: [],
      }),
    ).toThrow();
  });
});

describe("wire schema", () => {
  it("is strict-mode safe: no pattern/length rules, additionalProperties false, all required", () => {
    const s = jsonSchemaFor(Node) as any;
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(Object.keys(s.properties));
    const flat = JSON.stringify(s);
    expect(flat).not.toContain('"pattern"');
    expect(flat).not.toContain("minLength");
    expect(flat).not.toContain("$schema");
  });
});

describe("json extraction", () => {
  it("parses direct JSON", () => {
    expect(extractJson('{"a": 1}')).toBe('{"a": 1}');
  });

  it("uses balanced-brace scanning, so quotes containing code fences survive", () => {
    const content =
      'Here is the graph:\n```json\n{"quote": "text with ``` fence inside", "n": 1}\n```\nDone.';
    expect(JSON.parse(extractJson(content))).toEqual({ quote: "text with ``` fence inside", n: 1 });
  });

  it("finds the outermost JSON object when prose precedes it", () => {
    const content = 'Sure! {"nodes": [], "edges": [{"quote": "has } brace"}]} hope that helps';
    expect(JSON.parse(extractJson(content))).toHaveProperty("nodes");
  });
});

describe("lenient graph repair", () => {
  const raw = {
    nodes: [
      { id: "Bad-Id!", label: "Valid label here", kind: "claim", provenance: [{ source_range: "s", quote: "quoted text here" }] },
      { id: "dup", label: "First node", kind: "claim", provenance: [{ source_range: "s", quote: "first quote text" }] },
      { id: "dup", label: "Second node", kind: "weird", provenance: [] },
      { id: "ok2", label: "Third node", kind: "option", provenance: [{ source_range: "s", quote: "third quote text" }] },
      { id: "ok3", label: "Unknown kind node", kind: "weird", provenance: [] },
    ],
    edges: [
      { from: "Bad-Id!", to: "ok2", relation: "requires", grounding: "explicit", label: null, quote: "edge quote here", source_range: "s" },
      { from: "dup", to: "dup", relation: "causes", grounding: "implied", label: null, quote: "self loop quote", source_range: "s" },
      { from: "ghost", to: "ok2", relation: "causes", grounding: "implied", label: null, quote: "dangling quote", source_range: "s" },
      { from: "dup", to: "ok2", relation: "supports", grounding: "implied", label: null, quote: "dup edge quote", source_range: "s" },
    ],
  };

  const { parsed, repairs, droppedEdges, duplicateNodeIds, selfLoops } = repairGraph(raw);

  it("repairs invalid ids, merges duplicates, drops unusable edges, counts everything", () => {
    expect(parsed.nodes).toHaveLength(4);
    expect(parsed.nodes[0]!.id).toBe("valid_label_here");
    expect(parsed.edges).toHaveLength(2); // bad->ok2 and dup->ok2; self-loop + dangling dropped
    expect(droppedEdges).toBe(1);
    expect(duplicateNodeIds).toBe(1);
    expect(selfLoops).toBe(1);
    expect(repairs.length).toBeGreaterThan(0);
    // unknown kind coerced to note; empty provenance got a placeholder
    expect(parsed.nodes[3]!.kind).toBe("note");
    expect(parsed.nodes[3]!.provenance).toHaveLength(1);
  });

  it("output still passes strict zod validation", () => {
    expect(() =>
      Graph.parse({
        graph_id: "x",
        map_type: "plan",
        ...parsed,
      }),
    ).not.toThrow();
  });
});

describe("eval scoring", () => {
  const extracted: GraphWithStatus = {
    graph_id: "g",
    map_type: "plan",
    nodes: [
      { id: "a", label: "Urban flooding problem", kind: "claim", provenance: [{ source_range: "s", quote: "q" }], provenance_status: "verified" },
      { id: "b", label: "Green infrastructure option", kind: "option", provenance: [{ source_range: "s", quote: "q" }], provenance_status: "unverified" },
      { id: "c", label: "Hallucinated node", kind: "note", provenance: [{ source_range: "s", quote: "q" }], provenance_status: "verified" },
    ],
    edges: [
      { from: "a", to: "b", relation: "requires", grounding: "implied", label: null, quote: "q", source_range: "s", status: "verified" },
      { from: "b", to: "c", relation: "supports", grounding: "implied", label: null, quote: "q", source_range: "s", status: "unverified" },
    ],
    meta: { verification: { exact: 3, normalized: 1, fuzzy: 0, unverified: 1 } },
  };

  it("scores recall, precision, direction and provenance honestly", () => {
    const s = scoreGraph(
      {
        nodes: [
          { label: "Urban flooding" },
          { label: "Green infrastructure" },
          { label: "Missing node" },
        ],
        edges: [
          { from: "Urban flooding", to: "Green infrastructure", relation: "requires" },
          { from: "Green infrastructure", to: "Missing node", relation: "requires" },
        ],
      },
      extracted,
    );
    // nodes: a matches "Urban flooding", b matches "Green infrastructure";
    // "Missing node" does not match "Hallucinated node" (similarity 0.6 < 0.7)
    expect(s.nodeRecall).toBeCloseTo(2 / 3);
    expect(s.nodePrecision).toBeCloseTo(2 / 3);
    // edge 1 matches directed+relation; edge 2 has no counterpart
    expect(s.edgeRecall).toBeCloseTo(0.5);
    expect(s.edgePrecision).toBeCloseTo(0.5);
    expect(s.relationAgreement).toBe(1);
    expect(s.edgeDirectedRelMatched).toBe(1);
    // 3 verified of 5 elements (b node + e2 edge unverified)
    expect(s.provenanceVerifiedRate).toBeCloseTo(3 / 5);
    expect(s.verificationTiers).toEqual({ exact: 3, normalized: 1, fuzzy: 0, unverified: 1 });
  });

  it("edge matching compares endpoint labels directly and rejects unrelated endpoints", () => {
    // Regression for review finding #2: edge endpoints must correspond to the
    // expected edge's endpoints. Matching is now label-based (many-to-one), so
    // the failure mode is a similarity false positive, controlled by threshold.
    const expected = {
      nodes: [{ label: "Budget approval board" }, { label: "City permit approval office" }, { label: "Site survey" }],
      edges: [{ from: "Site survey", to: "Budget approval board", relation: "requires" }],
    };
    const onlyOffice: GraphWithStatus = {
      graph_id: "g",
      map_type: "plan",
      nodes: [
        { id: "n1", label: "City permit approval office", kind: "action", provenance: [{ source_range: "s", quote: "q" }], provenance_status: "verified" },
        { id: "n2", label: "Site survey", kind: "action", provenance: [{ source_range: "s", quote: "q" }], provenance_status: "verified" },
      ],
      edges: [
        { from: "n2", to: "n1", relation: "requires", grounding: "implied", label: null, quote: "q", source_range: "s", status: "verified" },
      ],
    };
    const s = scoreGraph(expected, onlyOffice);
    // "Budget approval board" has no label-similar extracted node, so the edge
    // must not match even though "Site survey" matches its endpoint exactly.
    expect(s.edgeRecall).toBe(0);
  });
});
