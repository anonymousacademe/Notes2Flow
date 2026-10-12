# Notes2Flow — Night Session Summary (Oct 10–11, 2026)

Owner was asleep; the following was built, reviewed (Opus, twice), and tested.
Total API spend for the night: **under $2.00**.

## What works now

```powershell
npm test                                   # 39 unit tests, all green
npm run extract -- --input notes.md        # notes -> verified graph (Sonnet 5.5)
npm run extract -- --input notes.md `      # cheap model (~10x less)
    --model z-ai/glm-5.3-flash
npm run review -- <graph.json>             # rule-based logic review
npm run eval -- --fixtures fixtures        # quality scorecard vs ground truth
```

## New capabilities (all tested, 39/39 green)

1. **Embedding-based eval matcher** (`src/embeddings.ts`, `src/eval.ts`) — OpenRouter
   `text-embedding-3-small`, persistent disk cache (model-keyed, atomic writes, corrupt-file
   quarantine). Thresholds hand-calibrated. Long-doc scores are no longer distorted by
   synonym rephrasings. Falls back to token matching if API is down.
2. **Chunked extraction for long documents** (`src/chunk.ts`) — splits at top-level
   headings, extracts per chunk, merges via same-kind/cross-chunk-only, complete-linkage
   union-find. Fixed a critical id-collision bug (Opus review #1) that had silently
   corrupted cross-chunk graphs.
3. **Reasoning-effort control** (`src/transport.ts`) — GLM 5.3 Flash burned its entire
   32K output budget on hidden reasoning and returned nothing; `reasoning: {effort: low,
   exclude: true}` fixed it (verified 9 tokens vs 30K+). Long-doc extraction on Flash now
   works: fixture-03 (358 lines) completes for **$0.005**.
4. **Rule-based logic review** (`src/review.ts` + CLI) — ordering contradictions and
   dependency loops via Tarjan SCC over *happens-before-normalized* edges (a consistent
   `requires`+`next` pair no longer false-positives), containment loops, dangling nodes,
   duplicate labels (Unicode-safe), unverified provenance, decisions without options.
   Severity: info/warn only. Never blocks.
5. **Stable-ID reconciliation** (`src/reconcile.ts`) — re-extraction keeps node ids and
   transfers `user_confirmed`/`user_rejected` edge statuses; fresh edges are remapped so
   no edge ever dangles. Revision counter in meta.
6. **Clean-notes precision fixture** (`fixture-04-clean-kickoff`) — 100% node recall,
   0 warnings, 1 defensible info finding. The review layer stays quiet on good notes.

## Quality scorecard (embedding matcher, GLM 5.3 Flash runs)

| Fixture | Node recall | Node precision | Edge recall | Provenance |
|---|---|---|---|---|
| 01 stormwater (synthetic) | 79% | 71% | 35% | 100% |
| 02 recipe ideas (real) | 84% | 67% | 66% | 98% |
| 03 node builder (real, 358 lines) | 57% | 27% | 15% | 91% |
| 04 clean kickoff | 100% | 85% | 57% | 100% |

Model comparison: **GLM 5.3 Flash** is ~10x cheaper than Sonnet 5.5, honors strict schema
enforcement (Sonnet's OpenRouter route does not), and on completed fixtures matches or
beats Sonnet on recall — but needs chunking + reasoning-effort limits on long docs.
Recommended policy: Flash-first, escalate to Sonnet on failure/low verification.

## Opus reviews — findings fixed

Round 2 (Step 0 code): fabricated-quote window matching, edge matching through wrong
nodes, strict wire schema, scoped retries, real cost reporting, truncation detection,
lenient repair — all fixed in the previous session and regression-tested.

Round 3 (new modules): 3 critical + 4 high + 4 medium findings, of which **all critical
and high are fixed** (chunk id collisions, reconcile dangling edges, negation-as-stopword
merges, happens-before cycle normalization, duplicate SCC reporting, embedding cache
correctness/durability, cross-part same-kind complete-linkage merge). Remaining medium
items are recorded in PLAN.md §13.

## Known limits (documented, not hidden)

- Fixture-03 precision (27%) reflects chunked over-extraction (129 nodes vs 61 expected);
  a cross-section link pass and merge-threshold tuning are the next levers.
- Embedding threshold (0.62) was tuned in-sample; one fixture should be held out.
- Edge recall is capped by single-section extraction (no cross-section edges yet).
- Fixture-04's single remaining info finding is the model mislabeling an option as a
  decision — a known kind-classification noise source.

## Next steps (in order)

1. Cross-section edge-linking pass in chunked mode (biggest score lever left).
2. Hold out fixture-03 from threshold calibration; report in-sample vs held-out.
3. Round-trip: reconcile() is ready to wire into an `extract --merge-previous` flag.
4. P0 web app: React Flow canvas, hand-drawn styling, export to Mermaid/Excalidraw.
5. Opencode restart to activate planner/coder/debugger agents (user action).
