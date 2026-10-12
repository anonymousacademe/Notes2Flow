import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { z } from "zod";
import { jsonSchemaFor } from "./schema.js";

const execFileAsync = promisify(execFile);

const OR_BASE = "https://openrouter.ai/api/v1";

/** Models that burn their output budget on visible reasoning; effort is capped
 * and reasoning excluded from content for these (verified on z-ai/glm-5.3-flash). */
const REASONING_PRONE = /glm-5\.3-flash/i;
const MAX_OUTPUT_TOKENS = 32000;

/** Fallback USD per million tokens (input/output), used only when OpenRouter
 * does not return usage.cost. Real cost is preferred via `usage: {include: true}`. */
const PRICE_TABLE: Record<string, [number, number]> = {
  "anthropic/claude-sonnet-5.5": [2, 10],
  "z-ai/glm-5.3": [1.4, 4.4],
  "z-ai/glm-5.3-flash": [0.15, 0.5],
  "deepseek/deepseek-v4-pro": [0.66, 1.98],
};

export interface Usage {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}

export interface CallResult<T> {
  data: T;
  usage: Usage;
  /** "strict": schema + require_parameters honored; "sent": schema sent but
   * enforcement unverified; "none": plain prompt-only JSON. */
  structured: "strict" | "sent" | "none";
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let cachedKey: string | null = null;

/**
 * Resolve the OpenRouter key. Order:
 * 1. OPENROUTER_API_KEY env var
 * 2. Windows Credential Manager entry "agentic-nodes/openrouter" via Python keyring
 *    (same store the dev-cost tracker uses). Never printed or written to disk.
 * The key is resolved once per process and reused.
 */
export async function getOpenRouterKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const env = process.env.OPENROUTER_API_KEY;
  if (env && env.length > 0) {
    cachedKey = env;
    return env;
  }
  let stdout = "";
  try {
    const result = await execFileAsync(
      "python",
      ["-I", "-c", "import keyring,sys; sys.stdout.write(keyring.get_password('agentic-nodes','openrouter') or '')"],
      { windowsHide: true, timeout: 15_000 },
    );
    stdout = result.stdout;
  } catch {
    throw new Error(
      "No OpenRouter key: set OPENROUTER_API_KEY, or store it in Credential Manager " +
        "(agentic-nodes/openrouter) with Python keyring installed",
    );
  }
  const key = stdout.trim();
  if (!key) {
    throw new Error(
      "No OpenRouter key: set OPENROUTER_API_KEY, or store it in Credential Manager " +
        "(agentic-nodes/openrouter) with Python keyring installed",
    );
  }
  cachedKey = key;
  return key;
}

interface ApiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}

async function callOpenRouterOnce(
  key: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ content: string; usage: Usage; finish_reason: string | null }> {
  const res = await fetch(`${OR_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OpenRouterError(`OpenRouter returned non-JSON response (status ${res.status})`, res.status);
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? text.slice(0, 300);
    throw new OpenRouterError(`OpenRouter ${res.status}: ${msg}`, res.status);
  }
  const content: string | undefined = json.choices?.[0]?.message?.content;
  if (!content) {
    const fr = json.choices?.[0]?.finish_reason ?? "unknown";
    const hasReasoning = json.choices?.[0]?.message?.reasoning != null;
    throw new OpenRouterError(
      `Empty completion content (finish_reason: ${fr}${hasReasoning ? ", reasoning-only output" : ""})`,
      res.status,
    );
  }
  const u: ApiUsage = json.usage ?? {};
  const model = body.model as string;
  const price = PRICE_TABLE[model] ?? [0, 0];
  return {
    content,
    finish_reason: json.choices?.[0]?.finish_reason ?? null,
    usage: {
      model,
      prompt_tokens: u.prompt_tokens ?? 0,
      completion_tokens: u.completion_tokens ?? 0,
      cost_usd:
        u.cost ??
        (((u.prompt_tokens ?? 0) * price[0] + (u.completion_tokens ?? 0) * price[1]) / 1e6),
    },
  };
}

export function extractJson(text: string): string {
  // 1. Direct parse of the whole content.
  const direct = text.trim();
  if (direct.startsWith("{")) {
    try {
      JSON.parse(direct);
      return direct;
    } catch {
      /* fall through */
    }
  }
  // 2. Balanced-brace scan that respects JSON strings (a quote containing
  //    a code fence cannot break this, unlike naive fence matching).
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (start === -1) {
      if (ch === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // 3. Last resort: code fence.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1];
  throw new Error("No JSON object found in model output");
}

export interface CallOptions {
  model: string;
  system?: string;
  user: string;
  schema?: z.ZodType;
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
}

/**
 * Call a model via OpenRouter. Schema-constrained first; if the provider rejects
 * response_format (HTTP 400 naming it), retry once without it — anything else
 * (429, 5xx) is retried with the same body after a short backoff. Usage is
 * accumulated across attempts.
 */
export async function callModel<T = unknown>(opts: CallOptions): Promise<CallResult<T>> {
  const key = await getOpenRouterKey();
  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.user });

  const baseBody: Record<string, unknown> = {
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.max_tokens ?? MAX_OUTPUT_TOKENS,
    usage: { include: true },
    provider: { require_parameters: true },
  };
  if (REASONING_PRONE.test(opts.model)) {
    baseBody.reasoning = { effort: "low", exclude: true };
  }

  const usageParts: Usage[] = [];
  let lastError: unknown;

  const attempt = async (body: Record<string, unknown>, level: "strict" | "sent" | "none"): Promise<CallResult<T>> => {
    for (let retry = 0; retry < 2; retry++) {
      try {
        const { content, usage, finish_reason } = await callOpenRouterOnce(
          key,
          body,
          opts.timeout_ms ?? 300_000,
        );
        usageParts.push(usage);
        if (finish_reason === "length") {
          throw new Error(
            `Output truncated at ${usage.completion_tokens} tokens; increase max_tokens or reduce input size`,
          );
        }
        const data = JSON.parse(extractJson(content)) as T;
        return { data, usage: totalUsage(usageParts, opts.model), structured: level };
      } catch (err) {
        lastError = err;
        const name = (err as { name?: string })?.name;
        if (name === "TimeoutError" || name === "AbortError") {
          await sleep(1000);
          continue;
        }
        if (err instanceof OpenRouterError && (err.status === 429 || err.status >= 500)) {
          await sleep(2000 * (retry + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  const isSchemaRejection = (err: unknown): boolean => {
    if (!(err instanceof OpenRouterError)) return false;
    const schemaIssue =
      err.status === 400 && /response_format|json_schema|structured|schema|parameters/i.test(err.message);
    const noEndpointForParams =
      err.status === 404 && /endpoint|parameters/i.test(err.message);
    return schemaIssue || noEndpointForParams;
  };

  if (opts.schema) {
    // Level 1: strict schema enforcement. Level 2: schema sent, enforcement
    // unverified (some providers reject require_parameters). Level 3: prompt-only.
    const withSchema = {
      ...baseBody,
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", strict: true, schema: jsonSchemaFor(opts.schema) },
      },
    };
    try {
      return await attempt(withSchema, "strict");
    } catch (err) {
      if (!isSchemaRejection(err)) throw err;
      console.error(`note: strict schema rejected by provider (${err instanceof Error ? err.message : err}); retrying with schema sent but unenforced`);
    }
    try {
      const { provider: _provider, ...rest } = baseBody;
      return await attempt({ ...rest, response_format: withSchema.response_format }, "sent");
    } catch (err) {
      if (!isSchemaRejection(err)) throw err;
      console.error("note: schema rejected; retrying prompt-only");
    }
  }
  return await attempt({ ...baseBody }, "none");
}

function totalUsage(parts: Usage[], model: string): Usage {
  return {
    model,
    prompt_tokens: parts.reduce((a, u) => a + u.prompt_tokens, 0),
    completion_tokens: parts.reduce((a, u) => a + u.completion_tokens, 0),
    cost_usd: parts.reduce((a, u) => a + u.cost_usd, 0),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function usageLine(u: Usage): string {
  return `${u.model}: ${u.prompt_tokens} in / ${u.completion_tokens} out, $${u.cost_usd.toFixed(4)}`;
}
