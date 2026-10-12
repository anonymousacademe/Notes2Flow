# AgenticNodes: Recipe Idea List

Status: living list (started 2026-10-04). Each entry is a candidate **recipe**: a reusable, parameterized
workflow (a `subgraph` with an `interface`, see spec 03 §6) built from the engine's nodes.
Feasibility is judged against the code as of commit `a8aa284` (M2.9) and the roadmap in `spec/09_roadmap.md`.

## Feasibility scale

| Rating | Meaning |
|---|---|
| **A** | Buildable today with existing node types |
| **B** | Needs one or two small new nodes or features that are already on the roadmap |
| **C** | Needs new capability not yet designed, or a roadmap block (M4) |
| **D** | Research risk: the engine is not the hard part |

## Verified facts used below

- Today's nodes: `io.*`, `transform.format`, `llm.chat`, `check.*`, `judge.binary/choice/score/cascade`, `human.task`, `control.if/router/merge/loop/while/map`, `subgraph`, `tool.python`.
- `Message.content` is a plain string: **model requests cannot carry images yet**. The model registry has a `vision` capability flag, but nothing sends images (`models/types.py`).
- `tool.python` receives one JSON value and has no artifact access, so it cannot read or write image or PDF files by reference (`nodes/tool_python.py`).
- There is no persistent cross-run repository. Run state is SQLite and artifacts are content-addressed, per run.
- Not built yet: HTTP and MCP tool nodes (M3.4, M3.7), batched human tasks and drop folders (M3.3), `pdf.extract` (M3.8), agent nodes (M3.5+), external-tool fittings (M4), local models (M4-LOCAL).
- Judge questions are static params, and calibration is keyed to the question's template hash.
- Unverified: whether a `human.task` inside a `control.loop` body works end to end.

## Shared missing pieces (build once, many recipes use them)

| ID | Piece | Needed by | Roadmap |
|---|---|---|---|
| P1 | **Repository node**: persistent dataset, upsert by key (e.g. DOI), idempotent, queryable across runs | L1, L3, S1 | not in roadmap |
| P2 | **HTTP / MCP tool nodes** (`tool.http`, `tool.mcp`) | L1 | M3.4, M3.7 |
| P3 | **Batched human tasks + drop folder** (`items[]`, partial completion) | L1 | M3.3 |
| P4 | **`pdf.extract`** (text layer, optional OCR for tables and equations) | L1 | M3.8 |
| P5 | **Image generation node** (`image.generate`; cloud API or local runtime) | all A-series | not in roadmap |
| P6 | **Multimodal messages** (image parts in `Message`, provider adapters, vision judge) | all A-series | not in roadmap |
| P7 | **Judge with rubric as an input port** (plus calibration keyed to a rubric version) | A1, A3 | not in roadmap |
| P8 | **Contact-sheet node** (batch of images + scores into one `figure` for human review) | A1, A3 | not in roadmap |
| P9 | **Artifact-aware tools** (tool nodes that read and write refs: files, images, meshes) | A2, A4 | partly M4 fittings |
| P10 | **External-tool fittings** (Inkscape, GIMP, Blender, vtracer, ComfyUI) | A2, A4 | M4 (D17) |
| P11 | **Gated write to a versioned guide** (staged diff, approver task; same shape as audition `promote`) | A3 | similar to M4.9 |
| P12 | **Recipe catalog** (folder, listing, instantiate-with-args, version pin) | all | packaging only |

---

## Literature repository series

### L1. Literature repository builder: **B** (needs P1, P2, P3, P4)

Build a repository of literature on a topic, end to end.

1. **Query builder.** Conversation with an LLM that produces a boolean query. Modeled as a `control.loop`: `llm.chat` proposes, a reviewer `human.task` returns `{approved, feedback}`, `done = approved`. Feasibility: **A**, subject to verifying `human.task` inside a loop body.
2. **Search and metadata.** Query to a table of titles, authors, abstracts, links. Use OpenAlex, Crossref, Semantic Scholar or arXiv; Google Scholar has no API and scraping is brittle and against its terms. An LLM translates the boolean query per backend, validated with `check.schema`. Needs P2.
3. **PDF availability.** `control.map` over rows, open-access lookup, `control.if` to split downloadable from not. Downloadable PDFs are fetched. The rest go to one batched contributor `human.task` (the paywall list), then `control.merge`. Needs P2, P3.
4. **Extraction.** Text, figures, equations, tables from each PDF into the repository. Needs P4 and P1. Equations and tables depend on the OCR backend (see the PaddleOCR-VL eval).
5. **The repository.** Upsert by DOI so re-runs are incremental. The map is cached per item by content, so new papers are the only work. Needs P1.

Risks: equation and table extraction quality (judge with `check.*` on extraction, audition the extractor); the human step is a batch, not one task per paper.
Natural first recipe: it is the M3 pilot, so most of its pieces are already planned.

### L2. Repository ingestion tools (summarize, annotate, index): **B** (needs P1)

Separate recipes that read from the repository: summarize each paper, extract claims or methods, tag by topic.

- Map over repository rows into `llm.chat` into a grounded `judge.binary` for faithfulness (the judge requires non-empty context, which suits this).
- Audition the summarizer model to pick the cheapest adequate one; this uses machinery that already exists.
- Only the repository read and write is missing (P1).

### L3. Suitability analysis over metadata: **A**

Rate each paper's fit for a purpose (relevance, study type, data availability) from title and abstract.

- Map over table rows into `judge.score` or `judge.choice`, escalating uncertain items through `judge.cascade` to the owner.
- Calibrate against labeled examples; owner reviews become new labels (`collect_labels`).
- Buildable today on an input table. A repository (P1) only makes it persistent and incremental.

---

## Asset generation series (A-series)

All of these need **P5 and P6** before the model-in-the-loop parts work. Without them only the deterministic steps are possible.

### A1. Prompt generator with rubric and human trend review: **C** today, **B** once P5-P8 exist

1. An LLM turns an asset brief into a prompt **and** a rubric (criteria and weights).
2. An image model generates a batch (cloud or local).
3. A vision judge scores each image against the rubric (needs P6, P7).
4. A contact sheet of the batch and scores goes to a human who reviews the **trend** and gives feedback (needs P8).
5. Feedback flows back into the prompt generator (`control.loop` carry).

Notes:
- A rubric that changes every run is automatically uncalibrated, because calibration is keyed to the question template. Prefer a rubric that is revised on purpose and versioned (P7).
- Auditioning image generators is possible later: replay prompts across candidate generators and score with the vision judge.

### A2. Generate, then improve with external tools (vectorize, clean up, rescale, restyle, pixel art): **B** for deterministic steps, **C** for tool-driven ones

Take a calibrated generator's output and increase its value.

- **Pixel art** (downscale plus palette quantization) and **rescale or clean up** are deterministic. A pure, cacheable node is enough, but it needs P9, since `tool.python` cannot read image refs today.
- **Vectorizing** via `vtracer` or `potrace` as a CLI fitting (P10, M4).
- **Quality check:** a vision judge comparing before and after, plus a calibrated human sample (P6).
- Inkscape, GIMP, Blender driven by an agent are M4 fittings and need sandboxing (D10, D17).

### A3. Style rubric and asset-guide learning loop: **C**

Generate a long list of assets under one style. Judge good or not. Humans label, adjust and save, and successes are added to the asset guide.

- The label-to-calibration part is the existing design: reviewer labels become calibration data (`collect_labels`).
- The guide is a persistent, versioned file that changes across runs, so it cannot be loop state. Changes to it should be staged diffs approved by the owner (P11, the same shape as audition `promote`).
- Needs P5, P6, P7, P8.

### A4. 2D image to 3D model with Blender: **D**

Image to 3D reconstruction model to headless Blender cleanup and renders to vision judge on the renders to human review.

- The engine side is plausible: the `mesh` port type already exists, and fittings plus judges cover the orchestration.
- The hard part is producing a usable mesh, which the engine cannot improve. It also needs P5, P6, P9, P10 and a GPU or API for the reconstruction model.
- Suggest a spike outside the engine first, to see whether any current image-to-3D model gives acceptable results.

---

## Suggested order

1. **L3** (A: works today) as a first recipe to exercise the recipe catalog (P12) and the calibration loop.
2. **L1** following the M3 roadmap (P1 added to it, since it is the main missing piece).
3. **A1** after a minimal P5 + P6 spike (one image API plus image parts in messages).
4. **A2** deterministic steps next (pixel art, rescale), then fittings.
5. **A3**, then **A4** only after a feasibility spike.

## Open questions

- Should P1 (repository) be a core node, a plugin, or a convention over the artifact store plus SQLite?
- Should P5/P6 be added to M2/M3 or wait for M4? They have no roadmap slot today.
- Does a `human.task` work inside a loop body? (Write a small test before relying on it.)
- Which image generators to target first (cloud API, local ComfyUI, or both)?
