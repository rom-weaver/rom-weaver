import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkReactRuntimeExclusion, checkWorkerRuntimeChunk } from "../../scripts/check-size-budget.mjs";

// These fixtures stand in for a production build. The guard they exercise is what stops a silent
// Vite/rolldown regression from re-duplicating the worker runtime or putting it on the first-paint
// path; without these cases the guard itself could rot into something that always passes.
type Chunks = Record<string, string>;

const temporaryDirectories: string[] = [];

const writeDist = (chunks: Chunks, documentChunks: string[]): string => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-chunk-guard-"));
  temporaryDirectories.push(distDir);
  const assetsDir = path.join(distDir, "assets");
  fs.mkdirSync(assetsDir);
  for (const [name, code] of Object.entries(chunks)) fs.writeFileSync(path.join(assetsDir, name), code);
  const links = documentChunks.map((name) => `<link rel="modulepreload" href="./assets/${name}" />`).join("");
  fs.writeFileSync(path.join(distDir, "index.html"), `<html><head>${links}</head></html>`);
  return distDir;
};

const writeSourceMapDist = (sources: string[]): string => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-runtime-guard-"));
  temporaryDirectories.push(distDir);
  const assetsDir = path.join(distDir, "assets");
  fs.mkdirSync(assetsDir);
  fs.writeFileSync(path.join(assetsDir, "index-test.js.map"), JSON.stringify({ sources, version: 3 }));
  return distDir;
};

const RUNTIME = "wasm-runtime-abc12345.js";
const RUNNER = "browser-runner-worker-def67890.js";
const THREAD = "browser-wasi-thread-worker-fed09876.js";
const SHARED = "shared-cba54321.js";
const INDEX = "index-0a1b2c3d.js";

const healthyChunks = (): Chunks => ({
  [INDEX]: `import{a}from"./${SHARED}";`,
  [RUNNER]: `import{b}from"./${SHARED}";import{c}from"./${RUNTIME}";`,
  [RUNTIME]: `import{d}from"./${SHARED}";`,
  [SHARED]: "var a=1;",
  [THREAD]: `import{e}from"./${RUNTIME}";`,
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("checkWorkerRuntimeChunk", () => {
  it("passes when both workers import the hoisted runtime and the document does not", () => {
    const distDir = writeDist(healthyChunks(), [INDEX, SHARED]);
    expect(checkWorkerRuntimeChunk(distDir)).toEqual({ failures: 0, problems: [] });
  });

  it("fails when the shared runtime chunk is gone entirely", () => {
    const chunks = healthyChunks();
    delete chunks[RUNTIME];
    chunks[RUNNER] = `import{b}from"./${SHARED}";`;
    chunks[THREAD] = `import{e}from"./${SHARED}";`;
    const result = checkWorkerRuntimeChunk(writeDist(chunks, [INDEX, SHARED]));
    expect(result.failures).toBe(1);
    expect(result.problems[0]).toContain("expected exactly one wasm-runtime chunk");
  });

  it("fails when a worker entry stops importing the runtime chunk", () => {
    const chunks = healthyChunks();
    chunks[THREAD] = `import{e}from"./${SHARED}";`;
    const result = checkWorkerRuntimeChunk(writeDist(chunks, [INDEX, SHARED]));
    expect(result.failures).toBe(1);
    expect(result.problems[0]).toContain(`${THREAD} does not import ${RUNTIME}`);
  });

  it("fails when a first-paint chunk gains a static import of the runtime chunk", () => {
    const chunks = healthyChunks();
    chunks[SHARED] = `import{f}from"./${RUNTIME}";var a=1;`;
    chunks[RUNTIME] = "var d=1;";
    const result = checkWorkerRuntimeChunk(writeDist(chunks, [INDEX, SHARED]));
    expect(result.failures).toBe(1);
    expect(result.problems[0]).toContain("is on the first-paint critical path");
    expect(result.problems[0]).toContain(SHARED);
  });

  it("ignores dynamic imports and Vite's preload manifest strings", () => {
    const chunks = healthyChunks();
    chunks[INDEX] =
      `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./${RUNTIME}"])))=>i.map(i=>d[i]);` +
      `import{a}from"./${SHARED}";const load=()=>import("./${RUNTIME}");`;
    expect(checkWorkerRuntimeChunk(writeDist(chunks, [INDEX, SHARED])).failures).toBe(0);
  });
});

describe("checkReactRuntimeExclusion", () => {
  it("passes when source maps contain only Preact compat", () => {
    const distDir = writeSourceMapDist(["../../node_modules/preact/compat/src/index.js", "../../src/webapp/main.tsx"]);
    expect(checkReactRuntimeExclusion(distDir)).toEqual({ failures: 0, problems: [] });
  });

  it("fails when React or Scheduler enters a bundle", () => {
    const distDir = writeSourceMapDist([
      "../../node_modules/react-dom/client.js",
      "../../node_modules/scheduler/index.js",
    ]);
    const result = checkReactRuntimeExclusion(distDir);
    expect(result.failures).toBe(2);
    expect(result.problems).toEqual([
      expect.stringContaining("react-dom was bundled"),
      expect.stringContaining("scheduler was bundled"),
    ]);
  });
});
