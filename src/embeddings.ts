import { writeFile, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getOpenRouterKey } from "./transport.js";

const OR_BASE = "https://openrouter.ai/api/v1";
const MODEL = "openai/text-embedding-3-small";
const BATCH_SIZE = 64;

// Cache lives next to this module (the project root), not the cwd.
const CACHE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".embedding-cache.json");
const CACHE_TMP = `${CACHE_FILE}.tmp`;

type Cache = Record<string, number[]>;

let cache: Cache | null = null;
let cacheDirty = false;

function cacheKey(text: string): string {
  return `${MODEL}\0${text}`;
}

async function loadCache(): Promise<Cache> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(CACHE_FILE, "utf8")) as Cache;
  } catch (err) {
    if ((err as { code?: string })?.code !== "ENOENT") {
      // Corrupt cache: keep it for inspection, start fresh, warn loudly.
      console.error(`warning: embedding cache unreadable (${err instanceof Error ? err.message : err}); moved aside`);
      await rename(CACHE_FILE, `${CACHE_FILE}.corrupt`).catch(() => {});
    }
    cache = {};
  }
  return cache;
}

export async function flushCache(): Promise<void> {
  if (!cacheDirty || !cache) return;
  // Atomic write: tmp file + rename, so a crash cannot truncate the cache.
  await writeFile(CACHE_TMP, JSON.stringify(cache), "utf8");
  await rename(CACHE_TMP, CACHE_FILE);
  cacheDirty = false;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Embed texts via OpenRouter, cached by (model, text). Duplicates in the input
 * are paid for once; the cache is flushed after every batch so a later failure
 * never loses paid results. */
export async function embed(texts: string[]): Promise<number[][]> {
  const c = await loadCache();
  const need = [...new Set(texts.filter((t) => !(cacheKey(t) in c)))];

  for (let i = 0; i < need.length; i += BATCH_SIZE) {
    const batch = need.slice(i, i + BATCH_SIZE);
    const key = await getOpenRouterKey();
    const res = await fetch(`${OR_BASE}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, input: batch }),
      signal: AbortSignal.timeout(60_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.data || !Array.isArray(json.data)) {
      throw new Error(`Embedding request failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
    }
    if (json.data.length !== batch.length) {
      throw new Error(`Embedding API returned ${json.data.length} vectors for ${batch.length} inputs`);
    }
    for (const d of json.data) {
      if (typeof d?.index !== "number" || !Array.isArray(d.embedding)) {
        throw new Error("Embedding API response missing index or embedding");
      }
      c[cacheKey(batch[d.index]!)] = d.embedding as number[];
    }
    cacheDirty = true;
    await flushCache();
  }
  return texts.map((t) => {
    const v = c[cacheKey(t)];
    if (!v) throw new Error("Internal: embedding missing after fetch");
    return v;
  });
}

/** Test seam: never used in production paths. */
export function setCacheFileForTests(path: string): void {
  void path;
  throw new Error("setCacheFileForTests: rework cache injection before using");
}
