# Notes2Flow

Notes2Flow turns plain Markdown notes into an **idea map**: an editable diagram of the
claims, assumptions, options, decisions, and actions in your writing, plus a logic review
that flags consistency problems in the structure.

You think in text. Notes2Flow makes the structure visible, checks it, and lets you edit
the diagram directly. Exports are open formats (Excalidraw JSON, Mermaid, JSON), so the
result stays usable outside the app.

> **Status: early development (v0.0.1).** The extraction pipeline and evaluation harness
> work and are tested. The web editor runs and is editable, but a full "Make the map" run
> against a live model through the UI has not been verified yet. Sending edits back into
> the text (back-translation) is planned, not built.

## How it works

1. **Extract.** An LLM reads your notes and produces a graph of nodes and edges. Every
   node and edge must carry a verbatim quote from the source.
2. **Verify.** Code checks each quote against the notes (exact, normalized, then fuzzy
   match). Elements with missing or unverifiable quotes are marked `unverified` so you can
   confirm or reject them. Quote verification is the main defense against hallucinated
   structure, so it should not be weakened.
3. **Lay out and edit.** The graph is laid out with ELK (run on the server) and shown on an
   editable React Flow canvas. You can add, delete, and retype nodes, draw and reverse
   arrows, and change shapes and colors.
4. **Review.** A rule-based check reports dependency cycles, containment loops, dangling
   nodes, duplicate labels, unverified provenance, and decisions without options. It
   re-runs after structural edits.
5. **Export.** Excalidraw JSON, Mermaid, or the raw graph JSON.

The canonical graph, defined by a Zod schema in `src/schema.ts`, is the single source of
truth. The canvas, exports, and review all read from it.

## Requirements

- Node.js 22 or later
- An [OpenRouter](https://openrouter.ai) API key, for extraction and embeddings

## Setup

```bash
npm install
```

Provide your OpenRouter key through an environment variable:

```bash
export OPENROUTER_API_KEY=sk-or-...    # PowerShell: $env:OPENROUTER_API_KEY = "sk-or-..."
```

On Windows you can instead store the key in Windows Credential Manager under the service
`agentic-nodes` and user `openrouter`. `src/transport.ts` checks the environment variable
first, then the credential store. The key is never logged or committed.

## Running the web app

```bash
npm run dev
```

This starts the API server on **http://localhost:5175** and the Vite dev server on
**http://localhost:5173**. Open the Vite address in a browser. Vite proxies `/api` to the
API server.

The API server does not hot-reload. Restart it after changing anything under `src/`.

Environment variables for the server:

| Variable | Default | Purpose |
|---|---|---|
| `N2F_PORT` | `5175` | API server port |
| `N2F_MODEL` | `z-ai/glm-5.3-flash` | Default extraction model (Thorough and Exhaustive) |
| `N2F_COMPACT_MODEL` | `google/gemini-4-argon` | Default model for Compact maps (`--granularity low`) |
| `OPENROUTER_API_KEY` | (from keychain) | OpenRouter API key |

## Command line

```bash
npm run extract -- --input notes.md [--model anthropic/claude-sonnet-5.5] [--granularity low|medium|high] [--timeout 600] [--chunk-size 12000]
npm run review  -- graph.json          # run the logic review on a saved graph
npm run eval    -- --fixtures fixtures  # score extraction against hand-built expected graphs
npm run server                         # API server only
npm run build                          # production build of the web app (vite build)
npm test                               # unit tests (vitest)
npm run typecheck                      # tsc --noEmit
```

`--map-type plan|process` picks the kind of map (default `plan`, the idea map). Use `process` for
procedures, protocols, and standard work: it produces a top-to-bottom flowchart with a start,
steps, yes/no decisions, and outcomes, and collapses "if yes to any of the above" lists into
one decision. The web app has the same choice in the header ("Idea map" / "Process map").
Automatic detection of the right type is planned, not built.

`--granularity` sets how many nodes extraction produces. `medium` is the default. `high`
can produce 100+ nodes on long documents, which is hard to read.

Without `--model`, the CLI uses Claude Sonnet 5.5, and the web app uses GLM 5.3 Flash.
Compact maps (`--granularity low`, or "Compact" in the web app) use Gemini 4 Argon
instead: compact maps depend on the model deciding what to leave out, and in a
comparison on a process document Gemini 4 Argon was the only model to hit the compact
size with every branch correct, while GLM 5.3 Flash left dead-end steps. In the web
app, picking a model yourself turns this switching off. Set `N2F_COMPACT_MODEL` to
change the compact default.

Long documents are split by Markdown section (`--chunk-size` sets the target size), then
merged. Merging matches nodes across sections using embeddings.

## Project layout

```
src/
  schema.ts       Zod graph model and wire-schema sanitizer
  textmatch.ts    token similarity and quote verification
  transport.ts    OpenRouter client, schema fallback, cost tracking, key lookup
  extract.ts      notes -> graph (prompting, repair, provenance verification)
  chunk.ts        section splitting and cross-chunk merge
  review.ts       rule-based logic review
  reconcile.ts    stable IDs across re-extractions
  embeddings.ts   embedding client with disk cache
  eval.ts         scoring of extracted graphs against expected graphs
  excalidraw.ts   graph -> Excalidraw JSON
  mermaid.ts      graph -> Mermaid (export only)
  server.ts       API server (extract jobs, layout, review, export, save)
  review-cli.ts   review CLI
  *.test.ts       unit tests
web/
  app.tsx         React UI: notes panel, editable canvas, inspector, review panel
  app.css         themes (clean, sketch, dark), layout, node shapes
index.html        Vite entry (must stay at the project root)
fixtures/         four test cases: notes.md, expected.json, extraction outputs
PLAN.md           development plan and design principles
HANDOFF.md        current state and open items for contributors
```

## Evaluation

`fixtures/` holds four note sets with hand-built expected graphs. `npm run eval` matches
extracted nodes to expected nodes by label similarity and embeddings, then reports node
and edge precision and recall plus provenance rate. See `fixtures/README.md` for the format.

The matching thresholds were tuned on these same fixtures, so the scores are optimistic
until a held-out fixture is added.

## Cost

A GLM 5.3 Flash extraction run costs roughly $0.005 to $0.02. Sonnet-class models cost
roughly $0.04 to $0.45 per run. Check the cost before running large evaluation sweeps.

## Contributing

Read `PLAN.md` before changing the design. The main principles are that the canonical
graph is the only source of truth, the LLM never places pixels, your exported output is
yours, and the tool coaches without blocking. Run `npm run typecheck` and `npm test`
after each change.

## License

Not yet specified.
