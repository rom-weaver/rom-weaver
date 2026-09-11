import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(
  new URL("../../packages/rom-weaver-webapp/Dockerfile", import.meta.url),
  "utf8",
);

function inheritedInstructions(target, args) {
  const stages = new Map();
  let stage;
  for (const line of dockerfile.replace(/\\\r?\n\s*/g, " ").split("\n")) {
    const from = /^FROM (\S+) AS (\S+)$/i.exec(line);
    if (from) {
      stage = {
        parent: from[1].replace(/\$\{(\w+)\}/g, (_, name) => args[name]),
        instructions: [],
      };
      stages.set(from[2], stage);
    } else if (stage && /^(RUN|COPY) /.test(line)) {
      stage.instructions.push(line);
    }
  }
  const collect = (name) => {
    const current = stages.get(name);
    if (!current) return [];
    return [...collect(current.parent), ...current.instructions];
  };
  assert.ok(stages.has(target), `missing Docker stage ${target}`);
  return collect(target);
}

for (const wasm of ["source", "prebuilt"]) {
  test(`cached identify packs precede every data consumer with WASM=${wasm}`, () => {
    const instructions = inheritedInstructions("app", { WASM: wasm, IDENTIFY_DATA: "prebuilt" });
    const copy = instructions.findIndex((line) => line.startsWith("COPY target/identify-data/v1 "));
    assert.ok(copy >= 0, "the selected build must copy the staged identify packs");
    for (const [index, line] of instructions.entries()) {
      if (/ensure-identify-data|wasm\/build-app|gen-third-party-licenses/.test(line)) {
        assert.ok(index > copy, `identify packs must be copied before ${line}`);
      }
    }
    assert.ok(
      instructions.some((line) =>
        line.includes("test -s /app/crates/rom-weaver-cli/data/identify/v1/index.json"),
      ),
      "missing staged data must fail",
    );
  });
}

test("the default source build prepares identify data before WASM attribution", () => {
  const instructions = inheritedInstructions("app", { WASM: "source", IDENTIFY_DATA: "source" });
  const prepare = instructions.findIndex((line) => line.includes("ensure-identify-data.mjs"));
  const compile = instructions.findIndex((line) => line.includes("wasm/build-app.mjs"));
  assert.ok(prepare >= 0 && compile > prepare);
  assert.ok(!instructions.some((line) => line.startsWith("COPY target/identify-data/v1 ")));
});

test("source builds install the pinned icon renderer before building the webapp", () => {
  for (const wasm of ["source", "prebuilt"]) {
    const instructions = inheritedInstructions("app", { WASM: wasm, IDENTIFY_DATA: "source" });
    const install = instructions.findIndex((line) =>
      line.includes("npm ci") && line.includes("npm exec -- playwright install --with-deps --only-shell chromium"),
    );
    const build = instructions.findIndex((line) => line.includes("npm --prefix packages/rom-weaver-webapp run build"));
    assert.ok(install >= 0 && build > install, `WASM=${wasm} needs the package-pinned renderer before its build`);
  }
});
