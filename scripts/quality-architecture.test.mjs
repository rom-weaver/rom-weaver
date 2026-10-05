import test from "node:test";
import assert from "node:assert/strict";
import {
  dependencyViolations,
  browserViolations,
  rustErrorViolations,
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
