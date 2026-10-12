# Notes2Flow — Development Plan (rev 2)

> Revised after an external Opus 5.5 review. Key changes: React Flow as the editing
> surface (Excalidraw/draw.io become render/export targets), canonical graph as the
> only source of truth, provenance verification instead of LLM self-reported
> confidence, a "Step 0" CLI evaluation before any UI, and a slimmer v0.

## 1. Vision

Notes2Flow turns plain Markdown notes into an idea map — an editable diagram the user
would otherwise draw by hand in draw.io or Excalidraw — and reviews the map for logical
problems. The user thinks in text; Notes2Flow makes the structure visible, critiques it,
and lets the user's edits flow back into the text.

Target users: first, people developing a proposal or designing a solution to a problem;
later, engineers writing design docs. General knowledge workers eventually.

## 2. Core workflow

1. User pastes or uploads Markdown notes.
2. User selects the **map type** (product goal: mind-map, flowchart, plan — v0 ships
   **plan/argument structure only**, see §9).
3. Notes2Flow extracts a structured graph from the notes.
4. The graph is laid out and rendered on an editable canvas with a hand-drawn aesthetic
   (rough, Excalidraw/draw.io-like styling on React Flow nodes/edges).
5. A logic-review pass annotates the map (and a side panel) with flagged issues.
6. The user edits the diagram; edits are **back-translated into text** so the agent
   (and the user) understands the refined idea in words.
7. The user exports the artifact — Excalidraw JSON, Mermaid, draw.io XML — and/or
   static images (PNG, PDF, JPEG).

## 3. Product principles

- **Quality of result over cleverness.** A wrong or spaghetti graph is worse than none.
- **User owns the artifact.** Output is open-format, editable outside the app forever.
- **Cost-aware, quality-first.** Start on a strong model to establish a quality
  baseline; move to cheaper models only when fixtures prove it is safe.
- **Privacy option.** A local-only mode where nothing leaves the machine (P3).
- **Coaching, not gatekeeping.** The tool guides note-taking; it never blocks the user.

## 4. System architecture

Web app. **All TypeScript**, one shared Zod schema for the canonical graph across
client, proxy, and eval tooling. The browser does layout and export; the server does
nothing but proxy LLM calls.

### 4.1 Components

```
Browser (React + TypeScript + Vite)
  ├─ Note editor (Markdown in/out)
  ├─ Map canvas (React Flow) — nodes/edges map 1:1 to the canonical graph
  │    └─ hand-drawn styling: rough.js borders, hand-writing font, curved edges
  ├─ Inspector (rename, merge, delete, retype nodes; confirm/reject edges)
  ├─ Logic panel (issues list, click-to-highlight targets)
  ├─ Export bar (Excalidraw JSON, Mermaid, draw.io XML, PNG/PDF/JPEG)
  └─ Local layout (elkjs for plan/flow graphs) — never an LLM call

Thin LLM proxy (TypeScript; serverless function or small Node server)
  ├─ /extract — notes + map type → graph JSON (schema-constrained)
  ├─ /review  — graph → issues JSON (schema-constrained)
  └─ Key handling: user's own OpenRouter key (BYO) by default; local mode calls
     Ollama directly from the browser (OLLAMA_ORIGINS), no server involved
```

### 4.2 Canonical data model — the single source of truth

```jsonc
{
  "graph_id": "…",
  "map_type": "plan",            // "mindmap" | "flowchart" arrive post-v0
  "nodes": [{ "id", "label", "kind": "claim|assumption|option|decision|action|prereq|question|note",
               "provenance": [{ "source_range", "quote" }],   // required on nodes, verified
               "created_by": "extraction|user" }],
  "edges": [{ "id", "from", "to",
               "relation": "causes|requires|supports|contradicts|part_of|next",
               "label", "quote",           // required, verified against source notes
               "status": "confirmed|rejected|unverified",
               "created_by": "extraction|user" }],
  "issues": [{ "id", "kind": "contradiction|cycle|unsupported_leap|missing_prereq|gap|dangling",
               "targets": [ids], "message", "severity": "info|warn" }],
  "meta": { "model_used", "created", "revision" }
}
```

- **One source of truth.** React Flow state IS the canonical graph (1:1 mapping).
  There is no second editing format to sync, and no LLM in the edit loop.
- **Provenance instead of confidence.** Every extracted edge and node carries a quote
  from the source notes. Code verifies each quote actually appears in the source
  (fuzzy substring match). Missing or unverifiable quote → `unverified` → shown as a
  low-trust element the user confirms or rejects. No LLM self-graded confidence.
- **Stable IDs.** Re-extraction reconciles new extractions against the existing graph
  (match by label similarity + provenance overlap) so confirmed edges, manual
  positions, and dismissed issues survive a re-run. Ships by P1.
- **Long notes.** Chunked extraction by Markdown section with a merge pass; capped at
  a practical page limit in v0 with an honest error beyond it.

### 4.3 Rendering & export (all client-side)

- **Editing canvas:** React Flow. Nodes/edges are typed objects — the canonical graph
  and the canvas are the same data.
- **Hand-drawn look:** rough.js-style node borders, hand-writing font, curved edges —
  the draw.io/Excalidraw *feel* without Excalidraw's freeform sync problem.
- **Layout:** deterministic, elkjs. Re-layout is explicit (button) and never overrides
  user-dragged positions silently.
- **Mermaid:** generated text export. Export-only — not parsed back.
- **Excalidraw JSON:** generated export from the canonical graph; opens in Excalidraw.
- **draw.io XML:** writer deferred (draw.io imports Mermaid natively: Arrange →
  Insert → Advanced → Mermaid). Native draw.io round-trip is a later phase.
- **Static export:** PNG/PDF/JPEG client-side from the canvas.

## 5. LLM strategy

| Pass | Task | Model | Notes |
|------|------|-------|-------|
| Extract (P2) | notes → graph JSON | **strong model first** (Opus/Sonnet-class via OpenRouter) | extraction quality IS the product; costs cents per run |
| Review (P3) | graph → issues JSON | same strong model initially | move down-model only when fixtures prove parity |
| Backtranslate | edited graph → markdown patch | deterministic templates first (§7) | no LLM in v1 round-trip |

- **Schema-constrained output everywhere** (OpenRouter `response_format` JSON schema /
  Ollama `format=<schema>`). Invalid JSON becomes an edge case, not a subsystem — the
  escalation/repair machinery is cut.
- **Cost guardrails (minimal):** cache extractions by content hash; one log line per
  call with token counts. No pre-run estimates or dashboards until users ask.
- **Local mode (P3):** Ollama; status bar (model load, progress) arrives with it.

## 6. Logic review (P3 layer)

Two tiers, ordered:

1. **Rule-based (free, deterministic, always on):**
   - cycles in directed relations, dangling nodes, decision nodes without both
     branches, actions with unsatisfied prerequisites, duplicate/alias nodes —
     **rules only apply where they make sense for the active map type** (no "dangling
     node" warnings in mind-maps; kind-dependent checks only fire on verified kinds).
   - **provenance check:** edges/quotes that fail source verification are flagged
     `unverified` (this catches most "unsupported leaps" without an LLM call).
2. **LLM-based (flag, never auto-fix):** contradictions between nodes/edges; gaps
   (plan steps implying unstated prerequisites).

- **Precision is tested, not just recall.** Fixtures include "clean" note sets whose
  target is ~zero warnings — false positives are what destroy trust in a coaching tool.
- Severity levels: `info`, `warn` only. The tool never blocks the user.
- Every issue carries node/edge targets (click-to-highlight) and a one-line suggested
  resolution phrased as a question.
- **Socratic critique mode (later phase):** conversational assumption-probing for
  research ideation.

## 7. Round-trip: edits → text

1. User edits the canvas (or inspector).
2. Deterministic diff of the canonical graph (before/after).
3. Template-generated "map state" Markdown patch appended to the notes:
   `Added: X requires Y. Removed: … Retyped: …`
4. Prose drafting (proposal/paper paragraphs from the graph) is a **separate, opt-in
   generative feature** — not part of the round-trip mechanism.
5. User accepts/edits; text and map stay reconciled.

## 8. Note-taking guidance

- In-app (later phase): starter templates per map type ("Problem → Constraints →
  Options → Decision"), a pre-extraction checklist.
- Docs: a short methodology page ("notes that become good plans") — also used to seed
  the extraction prompts. No real-time inline LLM suggestions while typing (cut for now).

## 9. Build sequence

| Phase | Scope | Exit criteria (measurable) |
|-------|-------|---------------------------|
| **Step 0 — CLI eval, before any UI** | Build 5–10 golden fixtures from the owner's real proposal notes with hand-built expected graphs. `extract(notes) → graph → mermaid` from a CLI/notebook. Eval script scoring node recall, edge precision/recall (label-fuzzy match), and provenance-verified rate. | Extraction on the owner's own notes is good enough that they would actually use the map. If not, iterate prompts/model — no UI until it is. |
| **P0 — thin vertical slice** | One map type (plan/argument). Paste Markdown → extract (strong model, schema-constrained, verified quotes) → elkjs layout → read-only React Flow render → export Mermaid + Excalidraw JSON. Rules-based review + provenance flags in a simple issue list. BYO OpenRouter key. | Fixture scores meet targets; exports open cleanly in Excalidraw and draw.io. |
| **P1 — review + structure edits** | LLM review checks (contradictions, gaps) held to the clean-fixture precision target. Confirm/reject UI for unverified elements. Inspector-based structural edits (rename, merge, delete, retype). Stable IDs across re-extraction. | Round-trip: re-extract after edits preserves confirmed work. |
| **P2 — canvas editing + backtranslation** | Full canvas editing in React Flow; deterministic diff → "map state" markdown; opt-in prose drafting. | Edits survive a full round-trip with meaning intact. |
| **P3 — local mode + breadth** | Ollama backend + status/progress bar; local-only mode; draw.io XML writer; mind-map & flowchart map types; templates/coaching; Socratic mode. | Full pipeline runs offline. |

## 10. Tech stack

- Frontend: React + TypeScript + Vite; React Flow (@xyflow/react); elkjs; rough.js;
  Zod; remark for Markdown parsing (no named "parse pass" — it's just preprocessing).
- Proxy: TypeScript (serverless function or small Node server), OpenRouter SDK.
- Storage (v0): download/upload a `.n2f.json` project file + localStorage. IndexedDB /
  File System Access later if needed.
- Testing: golden-note fixtures with hand-built expected graphs; eval script scoring
  extraction and review precision/recall; property tests for graph↔export writers.

## 11. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Extraction quality on messy notes | Strong model first; schema-constrained output; verified quotes; Step-0 fixtures gate all progress |
| Re-extraction losing user work | Stable-ID reconciliation (P1) |
| Review false positives destroy trust | Clean-notes fixture with ~zero-warning target; rules before LLM |
| LLM cost creep | Cache by content hash; strong-model-only-where-needed; log-line accounting |
| Local model too weak for extraction | Degrade to rules-assisted mode; message the user honestly (P3) |
| Scope creep (Socratic mode, plugins, coaching) | Phased plan; each phase gated by measurable exit criteria |

## 12. Open decisions

1. Serverless proxy vs small Node server for the LLM proxy (affects deployment story).
2. Which proposal note set(s) become the first golden fixtures (owner input needed).
3. Exact hand-drawn styling approach (rough.js vs styled SVG) — cosmetic, decide in P0.

## 13. Implementation status (updated 2026-10-11, night session)

Step 0 is complete and exceeded its exit criteria. See NIGHT_SUMMARY.md for details.

- **Working:** extraction (single + chunked), provenance verification (window-based
  fuzzy), rule-based logic review (SCC-based), stable-ID reconciliation, eval harness
  with embedding matcher, 4 fixtures, 39 tests green.
- **Model findings:** GLM 5.3 Flash is ~10x cheaper, honors strict schema enforcement,
  and matches Sonnet recall on completed fixtures — but needs reasoning-effort limits
  and chunking on long docs. Policy: Flash-first, escalate on failure/low verification.
- **Open medium items from the Opus round-3 review:** dual (strict 1:1) edge metric,
  macro-average NaN handling, held-out threshold calibration, chunk-resume +
  per-chunk output files, cross-section edge linking, timeout double-bill (no retry on
  TimeoutError), `missing_prereq` rule, keyring `py -3` fallback, realpath in isMain.
