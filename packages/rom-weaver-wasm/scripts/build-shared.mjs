// Build helpers shared by the @rom-weaver/wasm package build (build.mjs) and
// the @rom-weaver/webapp library build (../rom-weaver-webapp/scripts/build-lib.mjs).
// They live here because esbuild and @jridgewell/sourcemap-codec are this
// package's devDependencies (the webapp cannot pin its own esbuild - @lingui/cli
// peer-requires a different major), and the webapp already runs this package's
// build scripts for its prebuild.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { decode, encode } from "@jridgewell/sourcemap-codec";

export { build } from "esbuild";

// Emit `.d.ts` declarations beside the bundled `.js` so consumers resolve real
// types from `dist` rather than the `.ts` source (which needs
// `allowImportingTsExtensions`). Runs the emit-only tsconfig through the
// workspace's TypeScript.
export const emitDeclarations = (packageRoot, project) => {
  const require = createRequire(import.meta.url);
  const tscBin = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  const result = spawnSync(process.execPath, [tscBin, "-p", project], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`tsc declaration emit failed with exit code ${result.status ?? "signal"}`);
  }
};

// Hand-authored/generated `.d.ts` source files are declaration-only, so tsc's
// emitDeclarationOnly pass never copies them to the output. Copy them verbatim,
// preserving their relative path, so the emitted declarations that reference
// them resolve.
export const copyDeclarationSources = (srcDir, distDir) => {
  let copied = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".d.ts")) continue;
      const rel = path.relative(srcDir, full);
      const dest = path.join(distDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(full, dest);
      copied += 1;
    }
  };
  walk(srcDir);
  return copied;
};

// tsc (tsgo) emits declarations that keep the source's explicit `.ts`/`.d.ts`
// import specifiers, which only resolve for a consumer that enables
// `allowImportingTsExtensions`. Normalize every relative specifier to `.js`
// (its sibling `.d.ts` resolves by the standard rule), so the published types
// work under a stock consumer config too.
const REL_SPECIFIER_RE = /(["'])(\.\.?\/[^"']*?)(?:\.d)?\.ts\1/g;

export const rewriteDeclarationExtensions = (dir) => {
  let rewritten = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".d.ts")) continue;
      const original = readFileSync(full, "utf8");
      const edits = [];
      const next = original.replace(REL_SPECIFIER_RE, (match, quote, spec, offset) => {
        edits.push({
          ...lineAndColumnAt(original, offset),
          oldLength: match.length,
          delta: `${quote}${spec}.js${quote}`.length - match.length,
        });
        return `${quote}${spec}.js${quote}`;
      });
      if (next !== original) {
        writeFileSync(full, next);
        shiftSourceMapColumns(`${full}.map`, edits);
        rewritten += 1;
      }
    }
  };
  walk(dir);
  return rewritten;
};

// Shift the generated-column entries of `mapPath` to match single-line text
// edits applied to its emitted file AFTER the map was written. Every edit
// replaces `oldLength` characters at 0-based (line, column) with a same-line
// replacement whose length differs by `delta`; segments at or beyond the end
// of the replaced range move by the summed deltas of the edits before them.
// All comparisons use pre-edit coordinates, so the shift is applied exactly
// once per segment regardless of edit order.
const shiftSourceMapColumns = (mapPath, edits) => {
  const effective = edits.filter((edit) => edit.delta !== 0);
  if (effective.length === 0 || !existsSync(mapPath)) return;
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const decoded = decode(map.mappings);
  for (const [line, segments] of decoded.entries()) {
    const lineEdits = effective.filter((edit) => edit.line === line);
    if (lineEdits.length === 0) continue;
    for (const segment of segments) {
      let shift = 0;
      for (const edit of lineEdits) {
        if (segment[0] >= edit.column + edit.oldLength) shift += edit.delta;
      }
      segment[0] += shift;
    }
  }
  map.mappings = encode(decoded);
  writeFileSync(mapPath, JSON.stringify(map));
};

const lineAndColumnAt = (content, offset) => {
  let line = 0;
  let lineStart = 0;
  for (let index = content.indexOf("\n"); index !== -1 && index < offset; index = content.indexOf("\n", index + 1)) {
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: offset - lineStart };
};
