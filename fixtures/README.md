# Fixtures

Each fixture is a folder containing:

- `notes.md` — the input notes (Markdown)
- `expected.json` — a hand-built graph: `{ nodes: [{label, kind?}], edges: [{from, to, relation}] }`
  written with **labels**, not ids (the eval matches labels fuzzily)
- `notes.extracted.json` — produced by `npm run extract -- --input fixtures/<name>/notes.md`
  (gitignored once we have real numbers; committed only when it is the golden baseline)

`fixture-01-stormwater` is synthetic, written to exercise every node kind and relation.
Step 0 requires 5–10 fixtures built from the owner's real proposal notes.

Run the eval: `npm run eval -- --fixtures fixtures`
