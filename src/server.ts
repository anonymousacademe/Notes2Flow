import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import elkBundled from "elkjs/lib/elk.bundled.js";
const ELK = (elkBundled as unknown as { default?: new () => unknown }).default ?? (elkBundled as unknown as new () => unknown);
import { callModel, usageLine } from "./transport.js";
import { repairGraph, verifyProvenance, systemPrompt, userPrompt, ExtractOutput } from "./extract.js";
import { reviewGraph } from "./review.js";
import { toMermaid } from "./mermaid.js";
import { toExcalidraw } from "./excalidraw.js";
import { splitIntoChunks, mergeSectionGraphs, type GraphPart } from "./chunk.js";
import { GraphWithStatus, MAP_TYPES, type MapType, type GraphWithStatus as GraphT } from "./schema.js";

const PORT = Number(process.env.N2F_PORT ?? 5175);
const DEFAULT_MODEL = process.env.N2F_MODEL ?? "z-ai/glm-5.3-flash";
const STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");

interface Job {
  id: string;
  status: "queued" | "extracting" | "reviewing" | "done" | "error";
  progress: string[];
  graph?: GraphT;
  mermaid?: string;
  error?: string;
}
const jobs = new Map<string, Job>();

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function runExtraction(job: Job, notes: string, model: string, granularity: string, mapType: MapType): Promise<void> {
  const chunks = splitIntoChunks(notes);
  const chunked = chunks.length > 1;

  let data: unknown;
  let usage = { model, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };
  let structured: "strict" | "sent" | "none" = "none";

  if (!chunked) {
    job.status = "extracting";
    job.progress.push("extracting (single section)");
    const r = await callModel({
      model,
      system: systemPrompt(granularity as "low" | "medium" | "high", mapType),
      user: userPrompt(notes, `notes-${Date.now().toString(36)}`, mapType),
      schema: ExtractOutput,
      temperature: 0,
    });
    data = r.data;
    usage = r.usage;
    structured = r.structured;
  } else {
    const parts: GraphPart[] = [];
    for (const [ci, chunk] of chunks.entries()) {
      job.status = "extracting";
      job.progress.push(`extracting chunk ${ci + 1}/${chunks.length}`);
      const r = await callModel({
        model,
        system: systemPrompt(granularity as "low" | "medium" | "high", mapType),
        user: userPrompt(chunk, `notes-${Date.now().toString(36)}`, mapType),
        schema: ExtractOutput,
        temperature: 0,
      });
      usage = {
        model,
        prompt_tokens: usage.prompt_tokens + r.usage.prompt_tokens,
        completion_tokens: usage.completion_tokens + r.usage.completion_tokens,
        cost_usd: usage.cost_usd + r.usage.cost_usd,
      };
      structured = r.structured;
      const repaired = repairGraph(r.data, mapType).parsed;
      parts.push({ nodes: repaired.nodes, edges: repaired.edges });
    }
    job.progress.push("merging sections");
    const merged = await mergeSectionGraphs(parts);
    data = { nodes: merged.nodes, edges: merged.edges };
  }

  job.progress.push("verifying provenance");
  const { parsed } = repairGraph(data, mapType);
  const { graph, tiers } = verifyProvenance(parsed, notes, mapType);
  graph.meta = {
    ...graph.meta,
    model_used: model,
    structured,
    granularity,
    verification: tiers,
  };

  job.status = "reviewing";
  job.progress.push("rule-based logic review");
  const issues = reviewGraph(graph);
  (graph as any).issues = issues;

  job.status = "done";
  job.graph = graph;
  job.mermaid = toMermaid(graph);
  job.progress.push(usageLine(usage));
}

/**
 * Estimated rendered size, so ELK leaves room for nodes that carry detail lists.
 * Mirrors the web CSS: 300px wide boxes for nodes with details, 220px otherwise.
 */
function nodeSize(
  n: { kind?: string; label?: string; details?: string[] },
  process: boolean,
): { width: number; height: number } {
  const details = n.details ?? [];
  if (details.length > 0) {
    const lines = (text: string, perLine: number) => Math.max(1, Math.ceil(text.length / perLine));
    const labelLines = lines(n.label ?? "", 30);
    const detailLines = details.reduce((sum, d) => sum + lines(d, 44), 0);
    return { width: 300, height: 44 + labelLines * 20 + detailLines * 15 + details.length * 3 };
  }
  if (process && n.kind === "decision") return { width: 260, height: 110 };
  return { width: 220, height: 76 };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    // POST /api/extract {notes, model?, granularity?} -> {job_id}
    if (req.method === "POST" && url.pathname === "/api/extract") {
      const body = (await readBody(req)) as { notes?: string; model?: string; granularity?: string; map_type?: string };
      const notes = (body.notes ?? "").trim();
      if (notes.length === 0) return send(res, 400, { error: "notes are required" });
      const mapType = (MAP_TYPES as readonly string[]).includes(body.map_type ?? "plan") ? ((body.map_type ?? "plan") as MapType) : null;
      if (!mapType) return send(res, 400, { error: `map_type must be one of ${MAP_TYPES.join(", ")}` });
      const job: Job = { id: randomUUID(), status: "queued", progress: [] };
      jobs.set(job.id, job);
      void runExtraction(job, notes, body.model ?? DEFAULT_MODEL, body.granularity ?? "medium", mapType).catch((err) => {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
      });
      return send(res, 200, { job_id: job.id });
    }

    // GET /api/job/:id -> job state
    if (req.method === "GET" && url.pathname.startsWith("/api/job/")) {
      const job = jobs.get(url.pathname.split("/").pop() ?? "");
      if (!job) return send(res, 404, { error: "unknown job" });
      return send(res, 200, job);
    }

    // GET /api/graph -> last completed graph (session persistence)
    if (req.method === "GET" && url.pathname === "/api/graph") {
      const last = [...jobs.values()].reverse().find((j) => j.status === "done");
      return send(res, 200, last?.graph ?? null);
    }

    // POST /api/layout {nodes:[{id}], edges:[{from,to}]} -> positions (deterministic elkjs)
    if (req.method === "POST" && url.pathname === "/api/layout") {
      const body = (await readBody(req)) as {
        nodes?: { id: string; kind?: string; label?: string; details?: string[] }[];
        edges?: { from: string; to: string }[];
        map_type?: string;
      };
      const process = body.map_type === "process";
      const ids = (body.nodes ?? []).map((n) => n.id);
      const idSet = new Set(ids);
      const elkEdges = (body.edges ?? [])
        .filter((e) => idSet.has(e.from) && idSet.has(e.to))
        .map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] }));
      const elk = new (ELK as new () => {
        layout: (g: unknown) => Promise<{ children?: { id: string; x?: number; y?: number }[] }>;
      })();
      const hasIncoming = new Set(elkEdges.map((e) => e.targets[0]));
      const out = await elk.layout({
        id: "root",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "DOWN",
          "elk.spacing.nodeNode": "60",
          "elk.layered.spacing.nodeNodeBetweenLayers": "80",
          "elk.edgeRouting": process ? "ORTHOGONAL" : "SPLINES",
          ...(process ? { "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES" } : {}),
        },
        children: (body.nodes ?? []).map((n) => ({
          id: n.id,
          ...nodeSize(n, process),
          // ELK refuses a FIRST constraint on a node that has an incoming edge.
          ...(process && n.kind === "start" && !hasIncoming.has(n.id)
            ? { layoutOptions: { "elk.layered.layering.layerConstraint": "FIRST" } }
            : {}),
        })),
        edges: elkEdges,
      });
      const positions: Record<string, { x: number; y: number }> = {};
      for (const child of (out.children ?? []) as { id: string; x?: number; y?: number }[]) {
        positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
      }
      return send(res, 200, { positions });
    }

    // POST /api/review {graph} -> issues
    if (req.method === "POST" && url.pathname === "/api/review") {
      const body = (await readBody(req)) as { graph?: unknown };
      const graph = GraphWithStatus.parse(body.graph);
      return send(res, 200, { issues: reviewGraph(graph) });
    }

    // POST /api/export {graph, format} -> file content
    if (req.method === "POST" && url.pathname === "/api/export") {
      const body = (await readBody(req)) as { graph?: unknown; format?: string };
      const graph = GraphWithStatus.parse(body.graph);
      if (body.format === "mermaid") {
        return send(res, 200, { content: toMermaid(graph), ext: "mmd", mime: "text/plain" });
      }
      if (body.format === "excalidraw") {
        return send(res, 200, {
          content: JSON.stringify(toExcalidraw(graph), null, 2),
          ext: "excalidraw",
          mime: "application/json",
        });
      }
      if (body.format === "json") {
        return send(res, 200, { content: JSON.stringify(graph, null, 2), ext: "json", mime: "application/json" });
      }
      return send(res, 400, { error: "unknown format; use mermaid | excalidraw | json" });
    }

    // POST /api/save {graph} -> writes to disk
    if (req.method === "POST" && url.pathname === "/api/save") {
      const body = (await readBody(req)) as { name?: string; graph?: unknown };
      const graph = GraphWithStatus.parse(body.graph);
      const name = (body.name ?? "map").replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
      const outDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "maps");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(outDir, { recursive: true });
      const file = join(outDir, `${name}.n2f.json`);
      await writeFile(file, JSON.stringify(graph, null, 2), "utf8");
      return send(res, 200, { saved: file });
    }

    // Static files from web/
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = join(STATIC_DIR, rel);
    if (!resolve(file).startsWith(STATIC_DIR)) return send(res, 403, { error: "forbidden" });
    const content = await readFile(file);
    const mime =
      file.endsWith(".html") ? "text/html"
      : file.endsWith(".js") ? "text/javascript"
      : file.endsWith(".css") ? "text/css"
      : "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

server.listen(PORT, () => {
  console.log(`Notes2Flow: http://localhost:${PORT} (model: ${DEFAULT_MODEL})`);
});
