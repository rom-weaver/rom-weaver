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
    const install = instructions.findIndex(
      (line) =>
        line.includes("npm ci") &&
        line.includes("npm exec -- playwright install --with-deps --only-shell chromium"),
    );
    const build = instructions.findIndex((line) =>
      line.includes("npm --prefix packages/rom-weaver-webapp run build"),
    );
    assert.ok(
      install >= 0 && build > install,
      `WASM=${wasm} needs the package-pinned renderer before its build`,
    );
  }
});

const buildAction = readFileSync(
  new URL("../../.github/actions/docker-build-arch/action.yml", import.meta.url),
  "utf8",
);
const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

function assertRuntimeSmoke(action) {
  assert.match(action, /name: Load image for runtime smoke[\s\S]*?load: true/u);
  assert.match(action, /tags: rom-weaver-smoke:\$\{\{ inputs.image \}\}-\$\{\{ inputs.arch \}\}/u);
  assert.match(
    action,
    /run: node scripts\/ci\/docker-smoke\.mjs --image "\$SMOKE_IMAGE" --kind "\$SMOKE_KIND"/u,
  );
}

test("Docker action loads and exercises runtime images without replacing published attestations", () => {
  assertRuntimeSmoke(buildAction);
  assert.match(
    buildAction,
    /provenance: \$\{\{ inputs.push == 'true' && 'mode=max' \|\| 'false' \}\}/u,
  );
  assert.match(buildAction, /push-by-digest=true,name-canonical=true,push=true/u);
  assert.match(buildAction, /value: \$\{\{ steps.build.outputs.digest \}\}/u);
});

test("runtime smoke wiring rejects a discarded image or missing invocation", () => {
  assert.throws(() => assertRuntimeSmoke(buildAction.replace("load: true", "load: false")));
  assert.throws(() =>
    assertRuntimeSmoke(
      buildAction.replace("run: node scripts/ci/docker-smoke.mjs", "run: echo skipped"),
    ),
  );
});

test("CI smokes source and prebuilt images and checks clean identify source imports", () => {
  const source = workflow.split("\n  docker:\n")[1].split(/\n  [\w-]+:\n/u)[0];
  const prebuilt = workflow.split("\n  docker-prebuilt:\n")[1].split(/\n  [\w-]+:\n/u)[0];
  assert.match(source, /smoke-kind: \$\{\{ matrix.name == 'CLI' && 'cli' \|\| 'webapp' \}\}/u);
  assert.match(
    source,
    /if: matrix.name == 'CLI' && matrix.arch == 'amd64'\n\s+run: docker build --file Dockerfile --target identify-data-verify \./u,
  );
  assert.match(prebuilt, /build-args: DIST=prebuilt\n\s+smoke-kind: webapp/u);
  for (const job of [source, prebuilt]) {
    assert.match(job, /uses: actions\/setup-node@/u);
    assert.match(
      job,
      /npm --prefix packages\/rom-weaver-webapp ci --ignore-scripts --no-audit --no-fund/u,
    );
    assert.match(job, /playwright install --with-deps --only-shell chromium/u);
  }
});
