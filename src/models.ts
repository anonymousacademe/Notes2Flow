/**
 * Default extraction model per granularity.
 *
 * Compact maps need a model that is good at deciding what to leave out. In a
 * four-model comparison on a 9-section process document (2026-10-18), Gemini 4
 * Argon was the only one to hit the ~15-node compact target with every branch
 * correct; GLM 5.3 Flash left dangling steps and one-branch decisions at that
 * size. Thorough and exhaustive maps keep the caller's default.
 *
 * Mirrored in web/app.tsx (kept local so the browser bundle stays dependency-free).
 */
export const COMPACT_MODEL = process.env.N2F_COMPACT_MODEL ?? "google/gemini-4-argon";

export function defaultModelFor(granularity: string, fallback: string): string {
  return granularity === "low" ? COMPACT_MODEL : fallback;
}
