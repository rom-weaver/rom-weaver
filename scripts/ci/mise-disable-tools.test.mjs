import assert from "node:assert/strict";
import test from "node:test";

import { disabledTools } from "./mise-disable-tools.mjs";

const config = `${import.meta.dirname}/../../.config/mise.toml`;

// The exclusion lists each CI job used to carry by hand. Regenerating them
// from .config/mise.toml is only safe if it reproduces them exactly, so the previous
// values are pinned here rather than described.
const JOBS = {
  "wasm / release fallback": [
    ["node", "rust", "binaryen"],
    "aqua:EmbarkStudios/cargo-deny,ubi:bnjbvr/cargo-machete,ubi:nextest-rs/nextest,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint,ubi:sourcefrog/cargo-mutants,cargo:cargo-fuzz,cargo:kani-verifier,ubi:taiki-e/cargo-llvm-cov",
  ],
  "rust-lint": [
    ["node", "rust", "cargo-deny", "cargo-machete"],
    "github:WebAssembly/binaryen,ubi:nextest-rs/nextest,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint,ubi:sourcefrog/cargo-mutants,cargo:cargo-fuzz,cargo:kani-verifier,ubi:taiki-e/cargo-llvm-cov",
  ],
  "rust-host": [
    ["node", "rust", "nextest"],
    "github:WebAssembly/binaryen,aqua:EmbarkStudios/cargo-deny,ubi:bnjbvr/cargo-machete,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint,ubi:sourcefrog/cargo-mutants,cargo:cargo-fuzz,cargo:kani-verifier,ubi:taiki-e/cargo-llvm-cov",
  ],
  "rust-macos": [
    ["rust", "nextest"],
    "node,github:WebAssembly/binaryen,aqua:EmbarkStudios/cargo-deny,ubi:bnjbvr/cargo-machete,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint,ubi:sourcefrog/cargo-mutants,cargo:cargo-fuzz,cargo:kani-verifier,ubi:taiki-e/cargo-llvm-cov",
  ],
  security: [
    ["node", "rust", "cargo-deny"],
    "github:WebAssembly/binaryen,ubi:bnjbvr/cargo-machete,ubi:nextest-rs/nextest,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint,ubi:sourcefrog/cargo-mutants,cargo:cargo-fuzz,cargo:kani-verifier,ubi:taiki-e/cargo-llvm-cov",
  ],
  "wasm-check": [
    ["rust"],
    "node,github:WebAssembly/binaryen,aqua:EmbarkStudios/cargo-deny,ubi:bnjbvr/cargo-machete,ubi:nextest-rs/nextest,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint,ubi:sourcefrog/cargo-mutants,cargo:cargo-fuzz,cargo:kani-verifier,ubi:taiki-e/cargo-llvm-cov",
  ],
  "webapp / deploy / static-webapp": [
    ["node"],
    "rust,github:WebAssembly/binaryen,aqua:EmbarkStudios/cargo-deny,ubi:bnjbvr/cargo-machete,ubi:nextest-rs/nextest,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint,ubi:sourcefrog/cargo-mutants,cargo:cargo-fuzz,cargo:kani-verifier,ubi:taiki-e/cargo-llvm-cov",
  ],
  "coverage / parity / e2e-nightly": [
    ["node", "rust"],
    "github:WebAssembly/binaryen,aqua:EmbarkStudios/cargo-deny,ubi:bnjbvr/cargo-machete,ubi:nextest-rs/nextest,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint,ubi:sourcefrog/cargo-mutants,cargo:cargo-fuzz,cargo:kani-verifier,ubi:taiki-e/cargo-llvm-cov",
  ],
};

test("reproduces the exclusion list each job used to hard-code", async (t) => {
  for (const [job, [wanted, expected]] of Object.entries(JOBS)) {
    await t.test(job, () => assert.equal(disabledTools(config, wanted), expected));
  }
});
test("wanting every pinned tool disables nothing", () => assert.equal(disabledTools(config, ["node", "rust", "binaryen", "cargo-deny", "cargo-machete", "nextest", "cargo-semver-checks", "actionlint", "shellcheck", "hadolint", "cargo-mutants", "cargo-fuzz", "kani-verifier", "cargo-llvm-cov"]), ""));
test("rejects a tool that is not pinned", () => assert.throws(() => disabledTools(config, ["nodejs"]), /unknown tool\(s\): nodejs/));
test("refuses a config with no tools table", () => assert.throws(() => disabledTools(new URL("../../package.json", import.meta.url), []), /no tools found/));

test("quality jobs install only their pinned analysis tools", () => {
  const wanted = ["node", "rust", "cargo-mutants"];
  const excluded = disabledTools(config, wanted).split(",");
  assert.ok(!excluded.includes("ubi:sourcefrog/cargo-mutants"));
  assert.ok(excluded.includes("cargo:cargo-fuzz"));
  assert.ok(excluded.includes("cargo:kani-verifier"));
  assert.ok(excluded.includes("ubi:taiki-e/cargo-llvm-cov"));
});
