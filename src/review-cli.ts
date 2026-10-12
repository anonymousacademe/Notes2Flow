import { readFile } from "node:fs/promises";
import { GraphWithStatus } from "./schema.js";
import { reviewGraph } from "./review.js";

async function main() {
  const argv = process.argv.slice(2);
  const file = argv[0] ?? "";
  if (!file) {
    console.error("Usage: npm run review -- <graph.json>");
    process.exit(2);
  }
  const graph = GraphWithStatus.parse(JSON.parse(await readFile(file, "utf8")));
  const issues = reviewGraph(graph);

  const warns = issues.filter((i) => i.severity === "warn");
  const infos = issues.filter((i) => i.severity === "info");
  console.log(`Review: ${issues.length} finding(s) — ${warns.length} warn, ${infos.length} info\n`);
  for (const issue of issues) {
    console.log(`[${issue.severity.toUpperCase()}] ${issue.message}`);
    console.log(`  targets: ${issue.targets.join(", ")}\n`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
