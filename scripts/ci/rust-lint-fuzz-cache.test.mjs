import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/ci.yml");
const setup = read(".github/actions/setup-build-env/action.yml");

// The text of one top-level job, from its key to the next job.
const job = (name) => workflow.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:\\n)`, "mu"))?.[0];

test("setup-build-env passes cargo-cache-workspaces to rust-cache, empty meaning the root workspace", () => {
  assert.match(setup, /^  cargo-cache-workspaces:\n(?:    .+\n)*?    default: ""$/mu);
  const rustCache = setup.match(/uses: Swatinem\/rust-cache@v2\n[\s\S]*?(?=\n    - name:)/u)?.[0];
  assert.ok(rustCache, "missing rust-cache step");
  assert.match(rustCache, /^ {8}workspaces: \$\{\{ inputs\.cargo-cache-workspaces \}\}$/mu);
});

test("rust-lint caches the fuzz workspace next to the root workspace", () => {
  const body = job("rust-lint");
  assert.ok(body, "missing rust-lint job");
  assert.match(body, /cargo-cache-workspaces: \|\n {12}\.\n {12}fuzz\n/u);
});

test("the fuzz build check stays gated on the fuzz flag", () => {
  assert.match(
    job("rust-lint"),
    /- name: Fuzz targets build\n {8}if: needs\.changes\.outputs\.fuzz == 'true'\n {8}run: cargo check --manifest-path fuzz\/Cargo\.toml --bins\n/u,
  );
});
