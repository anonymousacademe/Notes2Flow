# Node Builder Design (DRAFT — owner review before any build)

Status: **DRAFT for owner approval** (design-first, standing rule; `release_scope.md` §"Explicitly
out of v0.1" names this the v0.2 headline). No code is written or changed. This doc is the design
+ decision record for the flagship feature.

The owner's words (anchored, not paraphrased): **"click +, converse with an agent that can see the
surrounding graph, and it implements the node (this is D20's pipeline behind a UI)."**

Standing UX rules for everything below:
1. Plain language. The canvas speaks in steps, not JSON (the GUI already has `KINDS`, `FRIENDLY`
   labels, `HINTS`); the builder conversation must too.
2. Never ask the user to write JSON. If a JSON payload must be inspected, it is rendered.
3. Errors name the node and the fix (the pattern `issueList()` already follows).
4. The builder never approves its own node (D20; D15).
5. Owner approval is required for anything that becomes permanent (D10/D15/D20).
6. Nothing touches the engine's hashes: canvas-only keys live in `node.ui`, never planned.

---

## 1. Product story: the conversation on the canvas

### 1.1 The flow

1. **Proposal.** The owner clicks **+** on the canvas (or drags a wire onto empty canvas, which
   already opens `quickAdd`). The quick-add menu gains one new item, styled like the others:
   **"Describe it and let AI build it"**. This opens a *builder panel* — a side panel like the
   existing edit pane, not a modal dialog.
2. **What the agent sees.** When the conversation starts, the server assembles a **graph context**
   (§2.1): the neighboring steps' names, kinds, output types and current values-in-view, the open
   input port (if the owner dragged from a wire), the workflow's declared params, and the installed
   node types (the registry summary the canvas already serves at `GET /api/registry`). The owner is
   told, in one line, what the builder can see: "I can see the 3 steps connected here."
3. **The conversation.** Owner describes the need in plain English. The builder asks at most a
   couple of clarifying questions, then emits a **proposal** (§2.2) and shows it as a preview on
   the canvas — a ghost step (or ghost sub-steps) plus a plain-language "what it will do / what it
   needs / what it may touch" card. For code tiers, the preview includes the code itself.
4. **Trial run.** For anything below T0-only, the proposal first runs a **sandbox trial** (smoke
   test): the ghost step runs on a sample input inside the restricted runner, and the owner sees
   the actual output in the ghost card. No sandbox available → the build stops at the proposal;
   the feature degrades to T0 (config-only), never to unsandboxed execution (D10).
5. **What the owner reviews and approves.** The approval is **out-of-band** (D15): the proposal
   becomes an approver `human.task` in the inbox — the same mechanism as audition `promote`
   (`audition.md` §promote: staged file + approver task with `decision: approve|reject`). The
   canvas shows the pending state ("waiting for your approval — see Inbox"), the inbox/CLI shows
   the report + code diff (D20 stage e). Approving applies the proposal to the workspace and the
   document; rejecting discards it with the owner's reason recorded. **The builder agent has no
   path to that decision** — it is delivered through the human-task channel only.
6. **The node exists.** After approval the ghost becomes a real step, wired where the owner
   started, and appears in the palette for reuse (workspace registry).

### 1.2 Mock dialogue (T1 example: a pure-compute step)

> **Owner** (clicked + on the wire out of "Fetch emails"): "Take each email and pull out the
> invoice number and total, if it has one."
>
> **Builder:** "Got it. I can see Fetch emails (list of messages). I'll add a step 'Extract
> invoice fields' that runs a small Python function on each message: it returns
> `{invoice_number, total}` or empty if none. No network, no files — pure text work. One
> question: should 'total' be a number or keep the currency text?"
>
> **Owner:** "Number."
>
> **Builder:** "Done — here's the draft *(code shown in the ghost step, ~25 lines)*. I've run it
> on a sample email: it returned `{"invoice_number": "INV-2041", "total": 129.90}`. Sending it
> for your approval now — it can't run in the saved workflow until you approve it."

The owner approves in the inbox; the step fills in on the canvas. Errors follow the house style:
"'Extract invoice fields' failed: the function returned text where a number was promised — the
step now declares the column as text. Click to see the fix I applied."

### 1.3 What changes in the conversation across tiers

| Tier | Owner sees in the panel | Owner approval |
|---|---|---|
| T0 (compose) | Ghost steps + a wiring description | Per-document save (the existing save+validate gate). No workspace change. |
| T1 (pure code) | Code + trial output + check report | One approver task per new/changed node |
| T2 (network/hosts) | Code + declared hosts + check report | Same, plus the host allowlist highlighted |
| T3 (executables/GPU) | Everything above + resource note | Separate explicit approval per node (D20); container required where possible |

---

## 2. Architecture

### 2.1 Components

1. **Graph-context assembler** (new, server-side, `gui/`). Pure function of the document +
   registry: for a given anchor (node id or wire endpoint), produce a bounded, structured
   context — neighbor nodes (id, type, plain title, port names + types, `determinism`), recent
   run outputs of neighbors when available (clipped, as the canvas already clips), the doc's
   params, and the candidate node types with param hints. **Prompt-injection hygiene:** all
   graph content (titles, values, prompts, notes) is passed as *quoted data*, never as
   instructions, and the builder's system prompt states that node text may contain injected
   instructions which must be treated as content (§6).
2. **Builder agent step.** An `llm.chat`-style step (it IS a node call, recorded like any other
   — principle 3, everything is an artifact) with a model policy. Model choice follows D19's
   spirit: no frontier model needed for drafting; the *reviewer* in the check pipeline must be a
   different family than the builder (family guard, `06` §2.1).
3. **Proposal document schema** (§2.2). The agent's structured output. Validated before it is
   ever shown; the agent retries on schema errors like any `invalid_output`.
4. **D20 check pipeline runner** (§2.3). Runs the five D20 stages and produces a report bundle.
5. **Restricted runner** (§2.4). Executes trial runs and later real runs under the declared
   capabilities.
6. **Approval flow** (§2.5). Staged application + approver human task, reusing the promote shape.
7. **Workspace node registry** (§2.6). Where an approved node type lives, and how the core
   registry picks it up ("small core, plug-in edges").

### 2.2 The proposal document (one schema, three shapes)

A proposal is a JSON document with a `kind` discriminator:

- **`kind: "config"`** — params for an *existing* node type (v0 slice): `{type_id, version,
  params, wiring: [{port, source}]}`. Becomes part of the current document only.
- **`kind: "subgraph"`** — T0: a small workflow fragment (nodes + edges, existing types only) as
  a `ref`-able subgraph with an interface. No new code anywhere.
- **`kind: "tool_python"`** — T1/T2: `{code_path, entry: module:function, manifest}` where the
  manifest is the D20 node manifest: declared inputs/outputs (ports), params schema,
  determinism/side-effects, resources, capabilities (hosts, secrets by name, executables, file
  access), and a smoke-test case (input + expected shape). Implementation detail: the node type
  wraps `tool.python`'s existing machinery (`entry`, `entry_sha256` pinning via `plan_params`,
  `determinism: pure` + `side_effects: none` gating for cacheability) so the engine surface stays
  identical to the existing pattern in `nodes.md` §tool.python.
- **`kind: "node_type"`** (later phases): a full custom node type: manifest + implementation +
  smoke tests. Highest risk, last.

Common fields: `name`, `plain_description` (the owner-facing blurb), `tier` (self-declared; the
pipeline re-derives it and treats a *lower* self-declaration than the scan finds as a hard fail),
`smoke_input`, and `provenance` (conversation id, builder model, timestamp).

Schema validation is mechanical: unknown fields rejected, port types from `PortType`, params
schema in the same pydantic-subset the registry already uses, entry path must resolve inside the
workspace (the `entry_outside_workspace` rule, symlink-safe).

### 2.3 The check pipeline (D20 a–e, mapped)

| D20 stage | What runs | Reuses |
|---|---|---|
| (a) static scan | AST + regex scan of the code: dangerous imports/calls, dynamic code (`eval`/`exec`/compile), obfuscation signals, file paths outside the node folder, network primitives | New module, but conceptually a `check.*`-style deterministic gate |
| (b) capability cover | Every capability the scan finds must be covered by the manifest declaration; extra declarations are listed but allowed | New; compare + report |
| (c) reviewer judge | One `llm.decision`/`judge.binary` call over code + manifest + scan findings, model family ≠ builder family | The judge backend machinery (policy-bound, `06`) |
| (d) observed smoke test | The manifest's smoke case runs in the restricted runner; files touched + network attempts recorded and diffed against declared capabilities | Restricted runner (§2.4) |
| (e) report + diff | A report bundle: scan findings, judge verdict + rationale, smoke output, full code diff | Rendered into the approver task (like the audition report bundle) |

Key honesty rule (D20, kept): **the check informs the owner and never replaces approval; it cannot
prove safety.** The report says what was checked and what was not.

### 2.4 The restricted runner

A subprocess wrapper used by (d) and later by the scheduler for workspace nodes:

- Scrubbed environment (no secrets unless declared by name and resolved through the engine's
  secret channel), confined working directory (the node's own folder for T1), time/CPU/memory
  limits, no shell, argv-only spawns (and for T1, no spawns at all).
- File access: hook or pre/post scan of the working tree (recorded in the report; enforced where
  the platform allows).
- Network: recorded (attempted endpoints) at T1; blocked only where a container/firewall rule is
  available. Where it cannot be enforced, the tier ceiling applies: no T2 claims without a real
  enforcement mechanism, per D20's "where it cannot be enforced…" clause.
- The runner is behind a seam (like `Executor`/`CacheLookup`), so a Docker-based sandbox later
  (M4.12, D10) is a swap, not a rewrite. Without a sandbox, T3 is unavailable, not unsafe.

### 2.5 The approval flow

Shaped exactly like audition `promote` (`audition.md`):

1. The pipeline stages the artifact: code file(s) under `nodes/workspace/<name>/` + manifest, or
   the subgraph file — **nothing in the live palette or document yet**.
2. An approver-role `human.task` is created: deliverable `decision: choice[approve, reject]`,
   optional `note`; context carries the report bundle and the diff. Out-of-band only (D15): no
   agent-facing completion path exists (`humans.md`); `agn approvals approve/reject` already
   works; the canvas gets an Inbox view over the same rows.
3. On approve: the staged files are promoted (registry picks them up), the ghost steps in the
   document become real, and a promotion record is written (what, when, approved_by, digest).
4. On reject: staged files deleted, reason recorded, the builder conversation can continue with
   the feedback.
5. **Digest rule:** the code digest (already the cache-key ingredient via `entry_sha256`) is part
   of the approval record. Any later edit to the file invalidates the approval and reruns the
   check (D20); the node refuses to run changed code it was not approved for — this is
   `tool_python.py`'s `entry_changed` behavior, extended from "cache correctness" to "approval
   correctness."

### 2.6 Workspace registry

- Approved node types live as text files in the workspace (`nodes/workspace/...`, principle 6:
  text files over databases), each a manifest + code, versioned.
- The registry loader merges: core registry (frozen) + workspace entries (approved digests only).
  Unapproved/staged entries are invisible to the planner — V03 "type not registered" is the
  enforcement that nothing runs before approval.
- `GET /api/registry` needs no change in shape; workspace types arrive with their plain labels.

---

## 3. Trust tiers for builder output (concrete)

Consistent with D10 (as amended by D20) and D15:

| Tier | Artifact | Runs free? | Check pipeline | Owner approval |
|---|---|---|---|---|
| T0 | Config of an existing type; composed subgraph (existing types only) | Yes, normal validation + save gate | Not needed | Document save (existing); nothing enters the workspace |
| T1 | `tool_python` code: no network, no secrets, files only in the node's own folder, no subprocess | Trial in restricted runner | Full pipeline (a–e) | Approver task, per node version |
| T2 | Adds declared network hosts + secrets-by-name | Restricted runner records attempts; blocking requires container/firewall | Full pipeline + hosts allowlist check | Approver task with allowlist highlighted; if network cannot be enforced on this machine, the node is capped at T1 |
| T3 | Executables, GPU, host reach | Only in a full sandbox (M4.12) or with a separate explicit owner approval per node | Full pipeline | Separate per-node approval, always |

Cross-cutting, unchanged from D10/D15/D20:
- Scratch/trial execution is sandboxed or refused; never unsandboxed (D10 rule 1).
- The builder never approves its own node; nothing that can approve is ever returned to the agent
  (D15/D20). No config override exists for this.
- The builder never grants itself network, executables, budget, or permissions; a self-declared
  tier below the scanned reality fails the pipeline outright.
- Any edit to approved code reruns the check and voids approval (digest rule).

---

## 4. What the artifact must satisfy to appear on the canvas

An agent-built step becomes a first-class citizen, so it must pass everything a hand-built one
would:

1. **Registry presence:** the type must be installed and approved (else V03 at plan time). The
   manifest's ports/params must satisfy the schema loader (pydantic subset, `PortType` tags).
2. **Planner V-rules** (the validator's checks, exercised by `build_plan` before anything runs):
   - V03 type registered; V04 params validate against the manifest's params schema (and
     `plan_params` must succeed — for `tool_python`-shaped nodes this is where `entry_sha256`
     gets pinned and the entry file must exist at plan time);
   - V05/V08 port existence and type compatibility on every wired edge (the coercion fold decides
     `coerce/wrap/check`; the builder should emit *correct* port types, not lean on `any`);
   - V06 no cycles; V10 required inputs connected; V12 loop/map caps; V15 depth; V17 required
     body params; V19 migrations exist for the declared version.
3. **Determinism declarations:** `determinism` and `side_effects` must be declared honestly — the
   scan + smoke test cross-check them (a "pure" node that touches the filesystem fails (d)). Only
   `pure` + `none` is cacheable (D14 O6); the builder should say so plainly in the panel ("this
   step's result is saved and reused").
4. **Plain-language surface:** plain title, blurb, port labels (`PORT_IN`/`PORT_OUT`-style),
   param hints — the manifest carries these so the canvas renders it without code changes in
   `naming.py` for workspace types.
5. **Errors name the node and the fix:** run-time failures surface through the existing
   `NodeError(code, message)` channel; the manifest may add fix-hints per error code (rendered by
   the canvas's problem list).
6. **Canvas placement:** new nodes appear via the same `addStep` path (registry summary →
   defaults → `node.ui`); nothing about the document format changes; `workflow_hash` stays stable
   under `node.ui` edits (canvas keys never planned).

---

## 5. Work packages (rough sizes; deps in brackets)

| # | Package | Size | Depends on |
|---|---|---|---|
| WP1 | Graph-context assembler + builder API endpoints (`/api/builder/*`) in `gui/server.py` | M | — |
| WP2 | Builder panel UI (side panel, ghost-step preview, plain-language cards) in `app.js` | M | WP1 |
| WP3 | Proposal schema + validation + retry loop (structured output from the builder agent) | S | — |
| WP4 | T0 path: config + subgraph proposals applied to the document through the existing validate/save gate | S | WP3 |
| WP5 | Workspace node registry: staging area, manifest loader, merge into `core_registry()`, approval-gated visibility | M | WP3 |
| WP6 | Restricted runner v1 (subprocess: scrubbed env, workdir confinement, limits, file/network recording) + seam | L | — |
| WP7 | Check pipeline stages (a)(b) static scan + capability cover | M | WP5 |
| WP8 | Check pipeline stage (c) reviewer judge (family guard wiring via existing judge machinery) | S | WP7 |
| WP9 | Check pipeline stage (d) observed smoke test through WP6; report bundle (e) | M | WP6, WP7 |
| WP10 | Approval flow: staged promote + approver task + apply/reject + promotion record; inbox view in the canvas | M | WP5, WP9 |
| WP11 | Digest-invalidation wiring for workspace nodes (`entry_changed` semantics generalized to the approval record) | S | WP5, WP10 |
| WP12 | T2 enforcement: hosts allowlist, secrets-by-name channel; platform capability probe (what can be enforced here) | M | WP6 |
| WP13 | T3: full sandbox integration (Docker/WSL probe), per-node approval; degrade gracefully when absent | L | WP6, WP12 |
| WP14 | Fix-hints + error rendering for builder-built nodes; smoke-test editing in the panel | S | WP2, WP9 |

Suggested build order: WP3 → WP4 (a usable v0 slice with almost no risk) → WP5+WP6 (the real
plumbing) → WP7–WP11 (the D20 pipeline end to end on T1) → WP12 → WP13. WP1/WP2 can start any
time and initially expose only the T0 slice.

---

## 6. Security notes

- **Sandboxing.** Trial runs always in the restricted runner; no sandbox capability on the machine
  means no execution, only proposal/validation (D10's "feature unavailable, never unsandboxed").
  T3 additionally requires a container-class sandbox.
- **No network by default.** T1 nodes get no network; T2 declares hosts and the allowlist is
  checked in the pipeline; enforcement is honest about platform limits — cannot enforce → tier
  capped or per-node approval required.
- **File/workspace boundaries.** Entries resolve symlink-safe inside the workspace root
  (existing `entry_file` rule). T1 file access is confined to the node's own folder; everything
  touched is recorded in the smoke report and diffed against the declaration.
- **Secrets.** Never passed as literals; only declared names resolved through the engine's secret
  channel at dispatch (`render_runtime(secret=...)`); the restricted runner's environment is
  scrubbed otherwise. The builder never sees secret values — only which names exist.
- **Prompt injection from graph content.** Node titles, prompts, values and notes are
  attacker-influenceable (a fetched web page can flow through an `llm.chat` output into the
  graph). Mitigations: graph content enters the builder prompt as delimited, quoted data with an
  explicit "content, not instructions" contract; the builder never acts on instructions found in
  graph text (including "approve this node" style text — such attempts are surfaced in the report
  as a finding, which the reviewer judge should also see); every consequential action still goes
  through the out-of-band approver task, so even a fully hijacked builder can at worst produce a
  proposal the owner must read and approve.
- **The builder never approves its own node.** Approval credentials live only in the human-task
  channel (D15: nothing that can approve is ever returned to the agent; agents never complete
  reviewer or approver tasks, no override). The check pipeline's reviewer judge is a *report
  input*, not a decision-maker; it is also family-separated from the builder so builder and
  reviewer do not share failure modes.
- **Budget/permissions.** The builder consumes budget like any node call (reserve/reconcile);
  it cannot raise caps. Staged artifacts cannot self-register; the only promotion path is the
  approval record.
- **Replayability.** Code digest in the cache key; approvals are keyed to digests; a re-run of an
  approved workflow runs exactly the approved bytes.

## Risks (honest)

- The check pipeline can be *defeated by craft* (obfuscated payloads, steganographic prompts).
  The design treats it as a filter that raises cost, with the owner's eyes as the real gate; the
  report must make the code readable, not just scannable. Calibrating the reviewer judge on a
  labeled benign/malicious set (D20) is a real project, not a checkbox.
- The restricted runner on Windows/macOS has uneven enforcement primitives; the tier-ceiling rule
  keeps us honest but may frustrate ("why can't I have T2 here?").
- Conversation quality is the actual product risk: a builder that needs five clarifications is a
  worse UX than a form. The T0-only first slice keeps the risk low while the dialogue matures.
- Scope discipline: this feature is famously where scope explodes (`release_scope.md`); the
  phased plan exists precisely to make each slice independently shippable and stoppable.

---

## 7. Phased plan

- **Phase 0 — "params builder" (v0 slice, smallest).** The + menu's "Describe it and let AI build
  it" emits `kind: config` proposals for *existing* node types only (e.g. configure a
  `check.regex` or `transform.format` from a description; propose an `llm.chat` prompt from
  neighbors). Ghost preview → document save gate. No code, no workspace changes, no approval
  machinery beyond the existing validate/save. Proves the conversation and the graph context.
- **Phase 1 — T0 subgraphs.** `kind: subgraph`: the builder composes small multi-step fragments
  (e.g. "judge + cascade + merge") with an interface, saved as a subgraph file. Still no new
  code. Normal validation is the only gate; approval = the save.
- **Phase 2 — T1 `tool.python` nodes.** Workspace registry + staging + full check pipeline (a–e)
  + restricted runner trial + approver task + digest rule. This is D20's core, and the point
  where Recipe_Ideas P9-style needs (pure transforms over artifacts) start to unlock.
- **Phase 3 — T2 (declared hosts/secrets).** Enforcement probes, allowlist, secrets channel.
- **Phase 4 — T3 + full custom node types.** Container sandbox (M4.12), per-node explicit
  approval, full manifest node types (not only `tool.python`-shaped), palette packaging
  (Recipe_Ideas P12-adjacent).
- **Phase 5 — polish.** Fix-hints library, smoke-test editing, calibration of the reviewer judge
  on a labeled set, workspace node reuse/sharing between workflows.

Each phase ends with an owner demo and sign-off before the next begins.

---

## 8. Open questions for the owner (one line each)

1. Should Phase 0 (params-only builder) be pulled into v0.1.x as a preview, or stay the v0.2 opener?
2. Which model should the builder use by default (cheap light model per D19, or one pinned "builder" policy)?
3. Should T0 subgraph proposals require an approver task too, or is the existing save+validate gate enough?
4. Where do approved workspace node types live — `nodes/workspace/` beside workflows, and should they be shareable across workflows from day one?
5. Is a canvas Inbox view of approver tasks in scope for v0.2, or is `agn approvals` (CLI) enough at first?
6. What is the trial-run input story — owner supplies a sample in the panel, or the builder pulls a recent neighbor output automatically?
7. Should every conversation be persisted as an artifact (report bundle includes the full transcript), yes/no?
8. Do we require the reviewer-judge calibration set (labeled benign/malicious) before any T1 ships, or ship with the family guard only and calibrate later?
9. On reject, should the builder get the owner's rejection reason as feedback in the same conversation, or start fresh?
10. Does the builder get write access to the document directly after approval, or does it only ever stage and the apply step is owner-clicked in the canvas?

---

*End of draft. Nothing here is built; per release_scope and the standing rule, build starts only
after owner sign-off on this design (and on the phase order).*
