# Notes2Flow — Agent Handoff (updated 2026-10-11, end of day)

Instructions for any AI agent (or person) picking this up. Read this fully; you need no
knowledge of earlier conversations. Owner: Tarek (research professor; first user).

## 1. What this project is

**Notes2Flow** turns Markdown notes into an idea map — an editable diagram (like
draw.io/Excalidraw output) with a logic-review layer that flags consistency problems.
The user thinks in text; the app makes the structure visible, critiques it, and
(back-translation phase, not built yet) lets edits flow back into words.

Plan of record: `PLAN.md` (rev 2, revised after an external Opus review).
Night-session detail: `NIGHT_SUMMARY.md`. Read both before coding.

## 2. Where things stand right now (exact state)

- **Step 0 (CLI eval harness) is DONE and exceeded its exit criteria.** 4 fixtures,
  42 unit tests green (`npm test`), eval harness with embedding-based matcher.
- **P0 web app LAUNCHES and is editable.** Verified in headless Edge via a scripted CDP
  test (stubbed LLM endpoints + saved fixture, so no API spend): render, themes, fonts,
  add/edit/delete nodes and arrows, drag-to-connect, shape/color, export, review re-run.
  **NOT yet verified:** a real "Make the map" run through the UI against OpenRouter, and
  any visual check of the Sketch theme (Clean and Dark were screenshotted).
- Start it with `npm run dev` → http://localhost:5173. The API server (:5175) does NOT
  hot-reload; restart it after any change under `src/`.

### What changed in the 2026-10-11 afternoon session

1. **Blank screen (real root cause):** `web/app.tsx` exported `App` but never mounted it.
   Added `createRoot(...).render(<App />)`.
2. **No connectors:** the custom node had no `<Handle>`s, so React Flow dropped every
   edge. Added a top target handle and bottom source handle.
3. **Design:** default theme is now **Clean**; **Sketch** (the old hand-drawn look) and
   **Dark** are options, plus a font picker. Both persist in localStorage. Themes are CSS
   variables on `<html data-theme>` in `web/app.css`. The Excalidraw export styling is
   unchanged.
4. **Canvas editing:** add node (toolbar), delete (Delete/Backspace or inspector),
   drag-to-connect (relation chosen via "New arrow"), edit label/kind, edit arrow
   relation/grounding, reverse arrow, per-node shape (rectangle/rounded/pill/diamond/
   ellipse) and color. Canvas state is now the source of truth for exports, re-layout,
   and the logic review (re-runs ~0.6s after structural edits).
5. **Schema (src/schema.ts):** `GraphWithStatus` nodes gained optional `style`
   (`shape`, `color`) and `provenance_status: "user_added"`. User arrows use the existing
   `user_confirmed` status. The LLM wire schema is untouched. `defaultShape(kind)` is
   mirrored in `web/app.tsx` (kept local so zod isn't bundled into the browser).
6. **Exports:** Excalidraw and Mermaid honor shape/color (tests added).

### Gotchas learned this session
- Never override `transform` on `.n2f-handle` (React Flow positions handles with it).
  A hover `transform` made handles jump out from under the cursor and broke arrow drawing.
- `labelClassName` is not in React Flow's edge type; use `labelStyle`.
- When driving the page with CDP, send `button: "none"` on mouseMoved, and `buttons: 1`
  only while a button is down, or RF drag/connect will not start.

### Owner feedback to act on next (not built)
The owner finds the generated maps **too complex to understand**, even for their own
project (fixture maps have ~20 nodes, ~20 labeled arrows, fit-to-view makes text tiny).
Candidate fixes were proposed but the owner has not picked any yet:
smaller default (Compact, ~8-12 nodes); readable canvas (bigger text, edge labels only on
hover/select, arrow type by line style + key); focus mode (highlight a node's neighbors,
fade the rest); filters by kind/implied links; plain-English summary panel; group by
section. Also: a full proposal will over-extract (see fixture-03 numbers in §9), so
advise running one section at a time or an agent-condensed outline. Ask before building.

### Missing/known limits in the editor
No undo/redo; edits are not saved to disk (use the JSON export; `/api/save` exists but has
no UI); "Make the map" replaces edits (confirm dialog shown first).

### The earlier blank-screen history (do not repeat)
1. First mistake: `web/index.html` — Vite only looks for `index.html` at project root.
   Fixed: file moved to root, paths rewritten to `/web/app.css` and `/web/app.tsx`.
2. Second mistake: `elkjs/lib/elk.bundled.js` (CJS, 1.6 MB) broke Vite's dep optimizer
   → 404 in `node_modules/.vite/deps/` → import failure → white screen. **Fixed
   differently:** layout moved server-side. `POST /api/layout` on 5175 runs elkjs in
   Node and returns `{positions: {nodeId: {x,y}}}`. The browser no longer imports
   elkjs at all. The endpoint was verified with curl: returns correct positions.
3. `Start-Process "http://..."` did not open a browser; use explicit Chrome path:
   `Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "--new-window","http://localhost:5173"`

## 3. Immediate next steps (in order)

1. **Real end-to-end run:** press "Make the map" with the starter notes (GLM 5.3 Flash,
   ~$0.01). Confirm extraction, canvas, review findings, and exports against a live model.
2. **Readability work** — ask the owner which of the simplification options in §2 they
   want, then build those (this is the owner's main stated concern).
3. Then pick from the roadmap in PLAN.md §9 (P0 exit criteria) and §13 (open items).
   If the app ever shows a blank page again, get console errors via CDP/headless Edge
   (see Gotchas) rather than guessing.

## 4. Architecture (what exists)

All TypeScript, one Zod schema (`src/schema.ts`) = canonical graph = single source of
truth. React Flow nodes/edges map 1:1 to it. No second editing format.

```
src/
  schema.ts       Zod graph model (nodes/edges/grounding/verification/statuses) + strict wire-schema sanitizer
  textmatch.ts    token similarity (stopwords, stemming, negation-parity cap), quote verification (exact→normalized→sliding-window fuzzy)
  transport.ts    OpenRouter chat client: schema 3-level fallback (strict→sent→none),
                  scoped retries, truncation detection, real cost via usage.include,
                  reasoning-effort control for glm-5.3-flash, key from env or Windows
                  Credential Manager (agentic-nodes/openrouter) — never logged/committed
  extract.ts      notes → graph: prompt (granularity low|medium|high), lenient repair,
                  provenance verification, chunked mode (multi-section docs)
  chunk.ts        markdown section splitting + cross-chunk merge (same-kind, cross-part,
                  complete-linkage union-find over embeddings) — ids namespaced per chunk
  review.ts       rule-based logic review: ordering/dependency cycles (Tarjan SCC over
                  happens-before-normalized edges), part_of containment loops, dangling
                  nodes, duplicate labels, unverified provenance, decisions without options
  reconcile.ts    stable-ID reconciliation across re-extractions (keeps ids, transfers
                  user_confirmed/user_rejected edge statuses, remaps all edge endpoints)
  embeddings.ts   OpenRouter text-embedding-3-small client, disk cache (model-keyed,
                  atomic writes, corrupt-file quarantine, dedupe, per-batch flush)
  eval.ts         scoring: greedy node matching (token 0.55 / embedding 0.62 thresholds),
                  directed/undirected edge metrics, micro+macro averages
  excalidraw.ts   graph → Excalidraw JSON (hand-drawn style, customData provenance)
  mermaid.ts      graph → Mermaid (export-only, escapes labels, reserved-id guard)
  server.ts       API on :5175 — /api/extract (async jobs), /api/job/:id, /api/layout,
                  /api/review, /api/export (mermaid|excalidraw|json), /api/save, static
  review-cli.ts   CLI: npm run review -- <graph.json>
  *.test.ts       42 vitest tests (all green)
web/
  app.tsx         React UI: notes panel | editable React Flow canvas | right panel
                  (Selection inspector + logic review + legend); model/granularity,
                  design/font selectors; export buttons. Layout via /api/layout.
                  Mounts itself (createRoot) at the bottom of the file.
  app.css         Theme variables (clean/sketch/dark) + layout + node shapes
index.html        Vite entry (MUST stay at project root)
fixtures/         4 fixtures: notes.md + expected.json (hand-built ground truth) +
                  extracted results. fixture-04 is the clean-notes precision fixture.
```

## 5. Commands

```powershell
npm test                    # 42 tests
npm run typecheck           # tsc strict
npm run eval -- --fixtures fixtures                        # Sonnet runs scored
npm run eval -- --fixtures fixtures --extracted notes.glmflash.extracted.json
npm run extract -- --input <notes.md> [--model z-ai/glm-5.3-flash] [--granularity low|medium|high] [--timeout 600] [--chunk-size 12000]
npm run review -- <graph.json>
npm run server              # API :5175
npm run dev                 # concurrently: API :5175 + Vite :5173 (proxies /api)
```

Kill stray background servers: `Get-NetTCPConnection -LocalPort 5175 -State Listen`
→ `Stop-Process -Id <OwningProcess> -Force`. Same for 5173.

## 6. Key facts and constraints

- **OS:** Windows, PowerShell 5.1. `npx` must be invoked as `npx.cmd` in Start-Process.
  Paths with spaces must be quoted. `$($x.ToUpper())` not `$($x.ToUpper)` (a real bug we hit).
- **Cost discipline:** owner's OpenRouter budget is limited (~$24 left on the account
  at last check via the dev-cost tracker). GLM 5.3 Flash costs ~$0.005–0.02/run;
  Sonnet 5.5 ~$0.04–0.45. Never run big eval sweeps without saying the cost first.
- **Model policy (decided):** GLM 5.3 Flash first (strict-schema honoring, cheap),
  escalate to Sonnet 5.5 on failure/low verification. GLM 5.3 (non-flash) is a poor
  fit (verbose, truncates). Sonnet on OpenRouter does NOT support enforced structured
  output (404 on require_parameters) — the 3-level fallback handles this honestly.
- **Quality gate:** provenance verification is the hallucination defense — every
  node/edge carries a verbatim quote checked against the source (exact/normalized/
  windowed-fuzzy tiers). Do not weaken it.
- **Map types:** only `plan` exists. Mind-map/flowchart are later phases.
- **Granularity:** default medium. "high" produces 100+ nodes on long docs (unreadable).
- **Eval honesty:** thresholds were calibrated in-sample; one fixture should be held
  out before trusting cross-prompt comparisons. Edge recall in eval is many-to-one
  (slightly optimistic); a strict 1:1 metric is on the wishlist (PLAN.md §13).

## 7. Known open items (from Opus round-3 review, PLAN.md §13)

Medium: dual strict-1:1 edge metric; macro-average NaN handling for empty denominators;
held-out threshold calibration; chunk-resume + per-chunk output files; cross-section
edge linking (biggest quality lever for fixture-03); no retry on TimeoutError (avoids
double-billing); `missing_prereq` rule never emitted; keyring `py -3` fallback;
realpath-based isMain check. Low: several minor items in the review text (in session
history, also summarized in NIGHT_SUMMARY.md).

## 8. Environment / integrations

- **OpenRouter key:** in Windows Credential Manager (`agentic-nodes`/`openrouter`),
  read via python keyring by `src/transport.ts` (cached per process). Never print it.
- **herdr** (terminal multiplexer, pane wH): the Opus reviewer agents were started via
  `herdr agent start <name> --kind claude --pane <id>`; reviewer panes are currently
  closed. The user may ask you to use herdr for reviews — load `herdr --skill` first,
  check `HERDR_ENV=1` before controlling panes.
- **opencode agents** (`.opencode/agents/`): planner (Sonnet 5.5), coder (GLM 5.3
  Flash), debugger (DeepSeek V4 Pro) are configured but NOT ACTIVE until opencode is
  restarted. The owner knows; remind them, don't nag.
- **Ollama:** DO NOT spend time on it. The owner said "build that later; use APIs."
  There is a WSL-side Ollama squatting on port 11434 without embeddings; a Windows
  Ollama may be running on 11435. Ignore both. Local models are a P3 phase.
- **Fixture sources:** fixture-02/03 are copies of real owner docs in
  `C:\Users\user\OneDrive - North Carolina State University\CoWork\PERSONAL\AgenticNodes Project\`
  (Recipe_Ideas.md, Node_Builder_Design_DRAFT.md). Don't modify the originals.

## 9. Numbers to beat (embedding matcher, GLM Flash runs)

| Fixture | node recall | node precision | edge recall | provenance |
|---|---|---|---|---|
| 01 stormwater | 79% | 71% | 35% | 100% |
| 02 recipes (real) | 84% | 67% | 66% | 98% |
| 03 node-builder (real, long) | 57% | 27% | 15% | 91% |
| 04 clean kickoff | 100% | 85% | 57% | 100% |

Fixture-03's low precision = chunked over-extraction (129 nodes vs 61 expected).
Cross-section edge linking + merge-threshold tuning are the levers.

## 10. Working rules

- Read PLAN.md principles before design changes: canonical graph is the ONLY source
  of truth; LLM never places pixels; user owns the artifact (open exports); coaching
  never blocks (severity = info|warn only); cost-aware, quality-first.
- Run `npm run typecheck` and `npm test` after every change.
- Commit only when the owner asks. The repo was initialized on 2026-10-11 at the owner's
  request (local only, no remote, nothing pushed). The owner's GitHub account is the
  pseudonymous `anonymousacademe`; global git config holds their real name/email, so do
  not push anything under it without asking which identity to use.
- Report honestly with real numbers; failures and misses included.
