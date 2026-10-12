const WORD_RE = /[\p{L}\p{N}]+/gu;

// Content words only: stopwords excluded from all similarity scoring.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "been", "being", "that", "this", "it", "its",
  "as", "at", "by", "from", "do", "does", "did", "can", "could",
  "should", "would", "will", "may", "might", "must", "have", "has", "had",
  "we", "our", "you", "your", "they", "their", "them", "he", "she", "his",
  "her", "if", "then", "than", "so", "such", "into", "over", "under",
  "between", "within", "per", "via", "up", "down", "out", "about",
  "which", "who", "whom", "whose", "what", "when", "where", "why", "how",
  "all", "any", "both", "each", "more", "most", "other", "some", "only",
  "own", "same", "too", "very", "just", "also",
]);

// Negators stay OUT of the stopword list on purpose: "use green roofs" and
// "do not use green roofs" must not be treated as the same label.
const NEGATORS = new Set(["not", "no", "never", "without", "cannot", "cant", "dont"]);
const NEGATION_CAP = 0.5;

export function hasNegation(s: string): boolean {
  const words = normalizeText(s).match(WORD_RE) ?? [];
  return words.some((w) => NEGATORS.has(w));
}

export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lightStem(w: string): string {
  let out = w;
  if (out.length > 4 && out.endsWith("ings")) out = out.slice(0, -4);
  else if (out.length > 4 && out.endsWith("ing")) out = out.slice(0, -3);
  else if (out.length > 3 && out.endsWith("ed")) out = out.slice(0, -2);
  else if (out.length > 3 && out.endsWith("es")) out = out.slice(0, -2);
  else if (out.length > 3 && out.endsWith("s") && !out.endsWith("ss")) out = out.slice(0, -1);
  if (out.length > 4 && out.endsWith("e")) out = out.slice(0, -1);
  return out;
}

/** Content-word set: normalized, stopword-filtered, lightly stemmed. */
export function tokenize(s: string): Set<string> {
  const norm = normalizeText(s);
  const out = new Set<string>();
  for (const w of norm.match(WORD_RE) ?? []) {
    if (!STOPWORDS.has(w)) out.add(lightStem(w));
  }
  return out;
}

export function contentTokenList(s: string): string[] {
  const norm = normalizeText(s);
  const out: string[] = [];
  for (const w of norm.match(WORD_RE) ?? []) {
    if (!STOPWORDS.has(w)) out.push(lightStem(w));
  }
  return out;
}

/** |A ∩ B| / min(|A|, |B|): 1.0 when one side's content words are a subset. */
export function tokenContainment(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** |A ∩ B| / |A ∪ B| — penalizes extra words, unlike containment. */
export function tokenJaccard(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Blended label similarity: 0.35 * containment + 0.65 * Jaccard.
 * If exactly one side contains a negator ("do not X" vs "X"), similarity is
 * capped so opposing claims never merge.
 */
export function tokenSimilarity(a: string, b: string): number {
  if (hasNegation(a) !== hasNegation(b)) return Math.min(NEGATION_CAP, 0);
  return 0.35 * tokenContainment(a, b) + 0.65 * tokenJaccard(a, b);
}

export interface QuoteCheck {
  verified: boolean;
  method: "exact" | "normalized" | "fuzzy" | "none";
  score: number;
  reason?: string;
}

/** Longest common subsequence length of two token arrays. */
function lcsLength(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const ai = a[i - 1]!;
    for (let j = 1; j <= n; j++) {
      curr[j] = ai === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

export const MIN_QUOTE_TOKENS = 3;
export const MAX_QUOTE_TOKENS = 40;
const FUZZY_THRESHOLD = 0.85;

/**
 * Verify a quote appears in the source notes.
 * Tiers:
 *  1. exact substring
 *  2. normalized substring (NFKC, case/punctuation/whitespace), word-boundary padded
 *  3. sliding-window fuzzy: quote's ordered content tokens matched against windows
 *     of the source (~1.3x quote length, min +3 tokens) via LCS ratio >= 0.85.
 *     Never compares against whole-document vocabulary, so a plausible invented
 *     sentence cannot pass by reusing scattered words.
 * Quotes under 3 or over 40 content tokens never verify.
 */
export function verifyQuote(quote: string, source: string): QuoteCheck {
  const qTokensRaw = (normalizeText(quote).match(WORD_RE) ?? []).length;
  if (qTokensRaw < MIN_QUOTE_TOKENS) {
    return { verified: false, method: "none", score: 0, reason: "too_short" };
  }
  if (qTokensRaw > MAX_QUOTE_TOKENS) {
    return { verified: false, method: "none", score: 0, reason: "too_long" };
  }
  if (source.includes(quote)) return { verified: true, method: "exact", score: 1 };

  const nq = normalizeText(quote);
  const ns = normalizeText(source);
  if (` ${ns} `.includes(` ${nq} `)) {
    return { verified: true, method: "normalized", score: 0.99 };
  }

  const qTokens = contentTokenList(quote);
  const srcTokens = contentTokenList(source);
  if (qTokens.length < MIN_QUOTE_TOKENS) {
    return { verified: false, method: "none", score: 0, reason: "too_short" };
  }
  const win = Math.max(qTokens.length + 3, Math.ceil(qTokens.length * 1.3));
  let best = 0;
  for (let i = 0; i + win <= srcTokens.length || (i === 0 && srcTokens.length > 0 && win > srcTokens.length); i++) {
    const window = srcTokens.slice(i, i + win);
    const ratio = lcsLength(qTokens, window) / qTokens.length;
    if (ratio > best) best = ratio;
    if (best >= FUZZY_THRESHOLD) break;
    if (i + win > srcTokens.length) break;
  }
  if (best >= FUZZY_THRESHOLD) {
    return { verified: true, method: "fuzzy", score: best };
  }
  return { verified: false, method: "none", score: best, reason: "no_window_match" };
}
