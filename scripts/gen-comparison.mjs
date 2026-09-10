#!/usr/bin/env node
// Regenerates the "How SignBridge compares" section of README.md from the single
// source of truth in frontend/src/data/comparison.mjs.
//
// Usage:  node scripts/gen-comparison.mjs   (or: npm run docs:comparison)
//
// It replaces everything between the two marker comments in README.md:
//   <!-- BEGIN:COMPARISON (generated from frontend/src/data/comparison.mjs) -->
//   <!-- END:COMPARISON -->
// The markers must already exist in README.md.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const {
  intro,
  tools,
  features,
  differentiators,
  caveats,
  legend,
} = await import(join(repoRoot, "frontend/src/data/comparison.mjs"));

const BEGIN = "<!-- BEGIN:COMPARISON (generated from frontend/src/data/comparison.mjs) -->";
const END = "<!-- END:COMPARISON -->";

function cell(value) {
  return legend[value] || value;
}

function buildTable() {
  const header = ["Capability", ...tools.map((t) => (t.self ? `**${t.name}**` : t.name))];
  const sep = header.map(() => "---");
  const rows = features.map((f) => [
    f.label,
    ...tools.map((t) => cell(f.values[t.key])),
  ]);
  const line = (cols) => `| ${cols.join(" | ")} |`;
  return [line(header), line(sep), ...rows.map(line)].join("\n");
}

function buildBody() {
  const parts = [];
  parts.push(BEGIN);
  parts.push("");
  parts.push("## How SignBridge compares");
  parts.push("");
  parts.push(intro);
  parts.push("");
  parts.push(buildTable());
  parts.push("");
  parts.push(`Legend: ${legend.yes} full · ${legend.partial} partial / indirect · ${legend.no} not supported.`);
  parts.push("");
  parts.push("### Where SignBridge stands out");
  parts.push("");
  for (const d of differentiators) {
    parts.push(`- **${d.title}.** ${d.body}`);
  }
  parts.push("");
  parts.push("### Honest caveats");
  parts.push("");
  for (const c of caveats) {
    parts.push(`- ${c}`);
  }
  parts.push("");
  parts.push(END);
  return parts.join("\n");
}

const readmePath = join(repoRoot, "README.md");
const readme = await readFile(readmePath, "utf8");

const beginIdx = readme.indexOf(BEGIN);
const endIdx = readme.indexOf(END);
if (beginIdx === -1 || endIdx === -1) {
  console.error(
    "ERROR: could not find COMPARISON markers in README.md.\n" +
      "Add these two lines where the section should live:\n" +
      `  ${BEGIN}\n  ${END}`
  );
  process.exit(1);
}

const before = readme.slice(0, beginIdx);
const after = readme.slice(endIdx + END.length);
const updated = `${before}${buildBody()}${after}`;

if (updated === readme) {
  console.log("README comparison section already up to date.");
} else {
  await writeFile(readmePath, updated, "utf8");
  console.log("README comparison section regenerated from frontend/src/data/comparison.mjs.");
}
