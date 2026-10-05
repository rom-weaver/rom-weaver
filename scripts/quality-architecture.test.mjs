import test from "node:test";
import assert from "node:assert/strict";
import {
  dependencyViolations,
  browserViolations,
  rustErrorViolations,
  mainThreadViolations,
} from "./quality-architecture.mjs";
const metadata = (edges) => ({
  workspace_members: Object.keys(edges),
  packages: Object.entries(edges).map(([name, dependencies]) => ({
    id: name,
    name,
    dependencies: dependencies.map((name) => ({ name })),
  })),
});
test("actual permitted checksum cross-edge passes", () =>
  assert.deepEqual(
    dependencyViolations(
      metadata({
        "rom-weaver-core": [],
        "rom-weaver-checksum": ["rom-weaver-core"],
        "rom-weaver-patches": ["rom-weaver-checksum", "rom-weaver-core"],
      }),
    ),
    [],
  ));
test("reverse and dev edges fail", () =>
  assert.equal(
    dependencyViolations(metadata({ "rom-weaver-core": ["rom-weaver-cli"], "rom-weaver-cli": [] }))
      .length,
    1,
  ));
test("unclassified new workspace package fails closed", () =>
  assert.equal(dependencyViolations(metadata({ surprise: [] })).length, 1));
test("computed OPFS calls and aliases of dangerous members rejected", () => {
  assert.equal(
    browserViolations("webapp/a.ts", 'const open = h["createSyncAccessHandle"];').length,
    1,
  );
  assert.equal(browserViolations("webapp/a.ts", "navigator.storage?.getDirectory?.()").length, 1);
  assert.deepEqual(
    browserViolations("webapp/a.ts", '// h.createSyncAccessHandle()\nconst x="getDirectory"'),
    [],
  );
});
test("only exact approved sync owner passes", () => {
  assert.deepEqual(
    browserViolations("wasm/browser-opfs-sync-access.ts", "h.createSyncAccessHandle()"),
    [],
  );
  assert.equal(browserViolations("wasm/other.ts", "h.createSyncAccessHandle()").length, 1);
});
test("generated duplicate rejected and generated owner passes", () => {
  const names = new Set(["ProgressEvent"]);
  assert.equal(browserViolations("webapp/new.ts", "interface ProgressEvent {}", names).length, 1);
  assert.deepEqual(
    browserViolations("wasm/generated/a.ts", "interface ProgressEvent {}", names),
    [],
  );
});
test("raw TS worker URLs rejected", () =>
  assert.equal(
    browserViolations("webapp/a.ts", 'new URL("a.worker.ts", import.meta.url)').length,
    1,
  ));
test("domain errors fail but state enums and vendor errors pass", () => {
  assert.equal(
    rustErrorViolations(
      "crates/rom-weaver-patches/src/a.rs",
      "#[derive(Debug, thiserror::Error)]\npub enum PatchError {}",
    ).length,
    1,
  );
  assert.deepEqual(
    rustErrorViolations("crates/rom-weaver-core/src/a.rs", "enum ErrorState { Retry }"),
    [],
  );
  assert.deepEqual(
    rustErrorViolations(
      "crates/rom-weaver-containers/src/nod/a.rs",
      "#[derive(thiserror::Error)] enum Error {}",
    ),
    [],
  );
});
test("worker-only blocking and synchronous reader APIs reject main modules", () => {
  for (const source of [
    "new FileReaderSync()",
    "FileReaderSync()",
    "new globalThis.FileReaderSync()",
    "Atomics.wait(x,0,1)",
    'Atomics["wait"](x,0,1)',
    "const a=Atomics; a.wait(x,0,1)",
    "const {wait: block}=Atomics; block(x,0,1)",
    "const Reader=FileReaderSync;new Reader()",
  ])
    assert.ok(browserViolations("webapp/a.ts", source).length > 0, source);
  assert.deepEqual(
    browserViolations("wasm/browser-opfs-io-adapters.ts", "new FileReaderSync()"),
    [],
  );
  assert.deepEqual(
    browserViolations("wasm/browser-wasi-thread-protocol.ts", "Atomics.wait(x,0,1)"),
    [],
  );
});
test("intervening attributes and unqualified Error implementations rejected", () => {
  assert.equal(
    rustErrorViolations(
      "crates/rom-weaver-patches/src/a.rs",
      '#[derive(Debug, thiserror::Error)]\n#[cfg(test)]\n#[serde(rename_all="camelCase")]\npub enum PatchError {}',
    ).length,
    1,
  );
  assert.equal(
    rustErrorViolations(
      "crates/rom-weaver-patches/src/a.rs",
      "use std::error::Error; impl Error for PatchError {}",
    ).length,
    1,
  );
});
test("imported Error alias implementation rejected", () =>
  assert.equal(
    rustErrorViolations(
      "crates/rom-weaver-patches/src/a.rs",
      "use std::error::Error as DomainFailure; impl DomainFailure for PatchFailure {}",
    ).length,
    1,
  ));
const graph = (sources) => new Map(Object.entries(sources));
test("transitive import and barrel export report a complete main-thread violation path", () => {
  const result = mainThreadViolations(
    graph({
      "webapp/main.tsx": 'import "./middle";',
      "webapp/middle.ts": 'export * from "../wasm/barrel.ts";',
      "wasm/barrel.ts": 'export {open} from "./browser-opfs-sync-access.ts";',
      "wasm/browser-opfs-sync-access.ts": "export const open=1;",
    }),
    ["webapp/main.tsx"],
  );
  assert.equal(result.violations.length, 1);
  assert.match(
    result.violations[0],
    /main.tsx -> webapp\/middle.ts -> wasm\/barrel.ts -> wasm\/browser-opfs-sync-access.ts/,
  );
});
test("type-only imports and exports erase ownership edges", () => {
  const result = mainThreadViolations(
    graph({
      "main.ts":
        'import type {T} from "./wasm/browser-opfs-sync-access.ts"; export type * from "./wasm/browser-opfs-runner.ts"; import {type U} from "./missing.ts"; export {type V} from "./absent.ts";',
    }),
    ["main.ts"],
  );
  assert.deepEqual(result.violations, []);
  assert.equal(result.checkedMainThreadModules, 1);
});
test("mixed value/type imports preserve runtime edge", () => {
  const result = mainThreadViolations(
    graph({
      "main.ts": 'import {type T, open} from "./wasm/browser-opfs-sync-access.ts";',
      "wasm/browser-opfs-sync-access.ts": "export const open=1;",
    }),
    ["main.ts"],
  );
  assert.equal(result.violations.length, 1);
});
test("literal dynamic imports remain main-thread code even inside a callback", () => {
  const result = mainThreadViolations(
    graph({
      "main.ts": 'const later = () => import("./wasm/browser-opfs-runner.ts");',
      "wasm/browser-opfs-runner.ts": "export const run=1;",
    }),
    ["main.ts"],
  );
  assert.equal(result.violations.length, 1);
});
test("worker URL and Worker asset imports do not execute worker code in main graph", () => {
  const result = mainThreadViolations(
    graph({
      "main.ts":
        'import workerUrl from "./worker.worker.ts?worker&url"; import WorkerCtor from "./worker.worker.ts?worker"; new Worker(new URL("./worker.worker.js", import.meta.url));',
      "worker.worker.ts": 'import "./wasm/browser-opfs-sync-access.ts";',
      "wasm/browser-opfs-sync-access.ts": "export const open=1;",
    }),
    ["main.ts"],
  );
  assert.deepEqual(result.violations, []);
  assert.equal(result.checkedMainThreadModules, 1);
});
test("ordinary import of worker entry is rejected", () => {
  assert.match(
    mainThreadViolations(
      graph({ "main.ts": 'import "./worker.worker.ts";', "worker.worker.ts": "" }),
      ["main.ts"],
    ).violations[0],
    /worker-only/,
  );
});
test("missing roots, unresolved imports, opaque dynamic imports and local aliases fail closed", () => {
  for (const source of [
    'import "./missing";',
    'import("./missing.ts")',
    "import(path)",
    'import "@/wasm/browser-opfs-sync-access.ts";',
    'import "#runtime";',
    'import "/src/wasm/browser-opfs-runner.ts";',
  ]) {
    assert.ok(
      mainThreadViolations(graph({ "main.ts": source }), ["main.ts"]).violations.length,
      source,
    );
  }
  assert.match(mainThreadViolations(graph({}), ["missing.ts"]).violations[0], /not selected/);
});
test("extensionless index imports, cycles and package imports preserve selection", () => {
  const result = mainThreadViolations(
    graph({
      "main.ts": 'import "./folder"; import "react";',
      "folder/index.ts": 'import "../main.ts";',
    }),
    ["main.ts"],
  );
  assert.deepEqual(result.violations, []);
  assert.equal(result.checkedMainThreadModules, 2);
});
test("malformed imported modules cannot be silently omitted", () => {
  const result = mainThreadViolations(
    graph({ "main.ts": 'import "./bad.ts";', "bad.ts": "import (" }),
    ["main.ts"],
  );
  assert.match(result.violations[0], /parser failed/);
});
