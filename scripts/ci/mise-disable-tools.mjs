#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function readToolIds(config) {
  const text = readFileSync(config, "utf8");
  const toolsStart = text.search(/^\[tools\]\s*$/m);
  if (toolsStart < 0) return [];
  const sectionStart = text.indexOf("\n", toolsStart) + 1;
  const rest = text.slice(sectionStart);
  const nextSection = rest.search(/^\[/m);
  const section = rest.slice(0, nextSection < 0 ? rest.length : nextSection);
  return [...section.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=/gm)].map((match) => match[1] ?? match[2]);
}

export function disabledTools(config, wanted) {
  const ids = readToolIds(config);
  if (ids.length === 0) throw new Error(`no tools found in [tools] of ${config}`);
  const shortNames = new Set(ids.map((id) => id.split("/").at(-1).split(":").at(-1)));
  const unknown = wanted.filter((name) => !shortNames.has(name));
  if (unknown.length) throw new Error(`unknown tool(s): ${unknown.join(" ")} - not pinned in ${config}`);
  const wantedSet = new Set(wanted);
  return ids.filter((id) => !wantedSet.has(id.split("/").at(-1).split(":").at(-1))).join(",");
}

export function main(argv = process.argv.slice(2)) {
  if (!argv[0]) throw new Error("usage: node scripts/ci/mise-disable-tools.mjs <mise.toml> [wanted...]");
  process.stdout.write(`${disabledTools(argv[0], argv.slice(1))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
