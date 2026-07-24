import assert from "node:assert/strict";
import test from "node:test";

import { disabledTools } from "./mise-disable-tools.mjs";

const config = `${import.meta.dirname}/../../.mise.toml`;

test("excludes wanted tools from the pinned mise ids", () => {
  assert.equal(disabledTools(config, ["node", "rust"]), "aqua:WebAssembly/binaryen,aqua:EmbarkStudios/cargo-deny,ubi:bnjbvr/cargo-machete,ubi:nextest-rs/nextest,ubi:obi1kenobi/cargo-semver-checks,aqua:rhysd/actionlint,aqua:koalaman/shellcheck,aqua:hadolint/hadolint");
});
test("wanting every pinned tool disables nothing", () => assert.equal(disabledTools(config, ["node", "rust", "binaryen", "cargo-deny", "cargo-machete", "nextest", "cargo-semver-checks", "actionlint", "shellcheck", "hadolint"]), ""));
test("rejects a tool that is not pinned", () => assert.throws(() => disabledTools(config, ["nodejs"]), /unknown tool\(s\): nodejs/));
test("refuses a config with no tools table", () => assert.throws(() => disabledTools(new URL("../../package.json", import.meta.url), []), /no tools found/));
