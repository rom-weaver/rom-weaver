#!/usr/bin/env node
// Theme-veil twin audit.
//
// The iOS theme wipe (src/webapp/theme-wipe.ts) renders a clone of the UI in
// the incoming theme inside `.theme-veil`. A subtree only picks up theme
// styling through selectors that are not anchored to `:root`, so every
// `:root[...][data-theme=...]` selector needs a `.theme-veil.theme-veil[...]`
// twin - doubled class, because during the wipe the clone also matches the
// outgoing `:root[data-theme=...]` rules and the twin has to out-specify them.
// Without the twin the wipe reveals a clone wearing the wrong colours.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const VEIL = ".theme-veil.theme-veil";

const cssFiles = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return full.endsWith(".css") ? [full] : [];
  });

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ");

const selectorsOf = (prelude) =>
  prelude
    .split(",")
    .map((selector) => selector.trim().replace(/\s+/g, " "))
    .filter(Boolean);

const failures = [];
let twins = 0;

for (const file of cssFiles(SRC_DIR)) {
  const src = stripComments(readFileSync(file, "utf8"));
  for (const match of src.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1];
    if (prelude.trim().startsWith("@")) continue;
    const line = src.slice(0, match.index).split("\n").length;
    const selectors = selectorsOf(prelude);
    const veiled = new Set(selectors.filter((selector) => selector.includes(VEIL)));
    twins += veiled.size;
    for (const selector of selectors) {
      if (!(selector.startsWith(":root") && selector.includes('[data-theme="'))) continue;
      const twin = selector.replace(/^:root/, VEIL);
      if (veiled.has(twin)) continue;
      failures.push(`${path.relative(SRC_DIR, file)}:${line}: \`${selector}\` has no \`${twin}\` twin`);
    }
  }
}

if (failures.length) {
  console.error("Theme veil audit failed (see tokens.css for why the twins exist):");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Theme veil audit passed: ${twins} twinned theme selector(s).`);
