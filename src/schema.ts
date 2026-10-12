import { z } from "zod";

export const NODE_KINDS = [
  "claim",
  "assumption",
  "option",
  "decision",
  "action",
  "prereq",
  "question",
  "note",
] as const;
export const NodeKind = z.enum(NODE_KINDS);

export const RELATIONS = [
  "causes",
  "requires",
  "supports",
  "contradicts",
  "part_of",
  "next",
] as const;
export const Relation = z.enum(RELATIONS);

export const GROUNDINGS = ["explicit", "implied"] as const;
export const Grounding = z.enum(GROUNDINGS);

export const Provenance = z.object({
  source_range: z
    .string()
    .min(1)
    .describe("Locator in the source notes, e.g. 'Problem section, bullet 2'"),
  quote: z
    .string()
    .min(1)
    .describe("Verbatim contiguous quote (3-40 words) copied from the source notes"),
});
export type Provenance = z.infer<typeof Provenance>;

export const Node = z.object({
  id: z
    .string()
    .min(1)
    .describe("Short reference key used in edges, e.g. n1, n2 (ids are reassigned by the app)"),
  label: z.string().min(1).describe("Short node label, at most 8 words"),
  kind: NodeKind,
  provenance: z.array(Provenance).min(1),
});
export type Node = z.infer<typeof Node>;

export const Edge = z.object({
  from: z.string().describe("id of the source node"),
  to: z.string().describe("id of the target node"),
  relation: Relation,
  grounding: Grounding.describe(
    "explicit: the relation is stated in the notes; implied: the notes imply it without stating it",
  ),
  label: z.string().nullable().describe("Optional short edge label, or null"),
  quote: z.string().min(1).describe("Verbatim quote (3-40 words) grounding this relation"),
  source_range: z.string().min(1),
});
export type Edge = z.infer<typeof Edge>;

export const Graph = z.object({
  graph_id: z.string(),
  map_type: z.literal("plan"),
  nodes: z.array(Node),
  edges: z.array(Edge),
  meta: z
    .object({
      model_used: z.string().optional(),
      created: z.string().optional(),
      structured: z.string().optional(),
      granularity: z.string().optional(),
      prompt_sha: z.string().optional(),
      revision: z.number().optional(),
      verification: z
        .object({
          exact: z.number(),
          normalized: z.number(),
          fuzzy: z.number(),
          unverified: z.number(),
        })
        .optional(),
    })
    .optional(),
});
export type Graph = z.infer<typeof Graph>;

/** Graph enriched with post-extraction verification results (never sent to the model). */
export const VerifiedEdgeStatus = z.enum(["verified", "unverified", "user_confirmed", "user_rejected"]);

/** Visual shapes a user can pick for a node. Presentation only; never sent to the model. */
export const NODE_SHAPES = ["rectangle", "rounded", "pill", "diamond", "ellipse"] as const;
export const NodeShape = z.enum(NODE_SHAPES);
export type NodeShape = z.infer<typeof NodeShape>;

/** Default shape for a node kind when the user has not picked one. */
export function defaultShape(kind: string): NodeShape {
  return kind === "decision" || kind === "question" ? "diamond" : "rounded";
}

/** Optional per-node presentation overrides (user edits on the canvas). */
export const NodeStyle = z.object({
  shape: NodeShape.optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type NodeStyle = z.infer<typeof NodeStyle>;

export const GraphWithStatus = Graph.extend({
  nodes: z.array(
    Node.extend({
      // user_added: created by the user on the canvas (no source quote exists, not a hallucination).
      provenance_status: z.enum(["verified", "unverified", "user_added"]).optional(),
      style: NodeStyle.optional(),
    }),
  ),
  edges: z.array(Edge.extend({ status: VerifiedEdgeStatus.optional() })),
});
export type GraphWithStatus = z.infer<typeof GraphWithStatus>;

interface SanitizeOptions {
  strict?: boolean;
}

/**
 * Produce a wire-safe JSON Schema from a Zod model:
 * - strips $schema, pattern, minLength/maxLength, minItems (some providers reject these)
 * - optionally sets additionalProperties:false on every object and makes every
 *   property required (OpenRouter/Anthropic strict mode requires this)
 */
export function jsonSchemaFor(model: z.ZodType, opts: SanitizeOptions = {}): Record<string, unknown> {
  const raw = z.toJSONSchema(model, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  const out = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  sanitizeNode(out, opts.strict ?? true);
  delete out.$schema;
  return out;
}

function sanitizeNode(node: unknown, strict: boolean): void {
  if (Array.isArray(node)) {
    for (const item of node) sanitizeNode(item, strict);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const key of ["pattern", "minLength", "maxLength", "minItems", "$schema"]) {
    delete obj[key];
  }
  if (strict && obj.type === "object" && obj.properties && typeof obj.properties === "object") {
    obj.additionalProperties = false;
    obj.required = Object.keys(obj.properties as Record<string, unknown>);
  }
  for (const value of Object.values(obj)) sanitizeNode(value, strict);
}
