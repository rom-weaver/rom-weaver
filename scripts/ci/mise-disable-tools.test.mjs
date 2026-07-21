import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "mise-disable-tools.sh");
const config = join(here, "..", "..", ".mise.toml");

const run = (...wanted) =>
  execFileSync(script, [config, ...wanted], { encoding: "utf8" }).trim();

const runFails = (...wanted) => {
  try {
    execFileSync(script, [config, ...wanted], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    return error.stderr;
  }
  return null;
};

// The exclusion lists each CI job used to carry by hand. Regenerating them
// from .mise.toml is only safe if it reproduces them exactly, so the previous
// values are pinned here rather than described.
const JOBS = {
  "wasm / release fallback": [
    ["node", "rust", "binaryen"],
    "aqua:BurntSushi/ripgrep,aqua:EmbarkStudios/cargo-deny,ubi:bnjbvr/cargo-machete,ubi:nextest-rs/nextest,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint",
  ],
  "rust-host": [
    ["node", "rust", "ripgrep", "cargo-deny", "cargo-machete", "nextest"],
    "aqua:WebAssembly/binaryen,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint",
  ],
  "rust-macos": [
    ["rust", "nextest"],
    "node,aqua:WebAssembly/binaryen,aqua:BurntSushi/ripgrep,aqua:EmbarkStudios/cargo-deny,ubi:bnjbvr/cargo-machete,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint",
  ],
  security: [
    ["node", "rust", "cargo-deny"],
    "aqua:WebAssembly/binaryen,aqua:BurntSushi/ripgrep,ubi:bnjbvr/cargo-machete,ubi:nextest-rs/nextest,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint",
  ],
  "wasm-check": [
    ["rust"],
    "node,aqua:WebAssembly/binaryen,aqua:BurntSushi/ripgrep,aqua:EmbarkStudios/cargo-deny,ubi:bnjbvr/cargo-machete,ubi:nextest-rs/nextest,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint",
  ],
  "webapp / deploy / static-webapp": [
    ["node", "ripgrep"],
    "rust,aqua:WebAssembly/binaryen,aqua:EmbarkStudios/cargo-deny,ubi:bnjbvr/cargo-machete,ubi:nextest-rs/nextest,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint",
  ],
  "coverage / parity / e2e-nightly": [
    ["node", "rust"],
    "aqua:WebAssembly/binaryen,aqua:BurntSushi/ripgrep,aqua:EmbarkStudios/cargo-deny,ubi:bnjbvr/cargo-machete,ubi:nextest-rs/nextest,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint",
  ],
};

test("reproduces the exclusion list each job used to hard-code", async (t) => {
  for (const [job, [wanted, expected]] of Object.entries(JOBS)) {
    await t.test(job, () => assert.equal(run(...wanted), expected));
  }
});

test("wanting every pinned tool disables nothing", () => {
  const all = [
    "node",
    "rust",
    "binaryen",
    "ripgrep",
    "cargo-deny",
    "cargo-machete",
    "nextest",
    "cargo-semver-checks",
    "actionlint",
    "shellcheck",
    "hadolint",
  ];
  assert.equal(run(...all), "");
});

// The negative form silently ignored typos; the positive form must not.
test("rejects a tool that is not pinned", () => {
  assert.match(runFails("nodejs") ?? "", /unknown tool\(s\): nodejs/);
});

test("refuses to emit a list from a config with no [tools] table", () => {
  const empty = join(here, "..", "..", "package.json");
  let stderr = null;
  try {
    execFileSync(script, [empty], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    stderr = error.stderr;
  }
  assert.match(stderr ?? "", /no tools found/);
});
