import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const action = readFileSync(new URL("../../.github/actions/cargo-profile-hash/action.yml", import.meta.url), "utf8");
const script = action.match(/ {6}run: \|\n((?: {8}.*\n|\n)+)/u)?.[1].replace(/^ {8}/gmu, "");
assert.ok(script, "missing cargo-profile-hash run script");

const profileHash = (cargoToml) => {
  const directory = mkdtempSync(join(tmpdir(), "cargo-profile-hash-"));
  try {
    writeFileSync(join(directory, "Cargo.toml"), cargoToml);
    const output = join(directory, "output");
    execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], { cwd: directory, env: { ...process.env, GITHUB_OUTPUT: output } });
    return readFileSync(output, "utf8").match(/^hash=(\d+)$/mu)?.[1];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const manifest = ({ version = "1", header = "[profile.release]", optLevel = "3 # fast", extra = "" } = {}) =>
  `[workspace.package]\nversion = "${version}"\n\n${header}\n# tuned\nopt-level = ${optLevel}\n\n[profiler]\nfoo = 1\n${extra}`;

test("the profile hash ignores edits outside the profile tables and comment-only edits", () => {
  const base = profileHash(manifest());
  assert.match(base, /^\d+$/u);
  for (const [label, changed] of [
    ["version bump", manifest({ version: "2" })],
    ["inline comment", manifest({ optLevel: "3 # slow" })],
    ["no comment", manifest({ optLevel: "3" })],
    ["table that only starts with profile", manifest({ extra: "bar = 2\n" })],
    ["CRLF line endings", manifest().replaceAll("\n", "\r\n")],
  ])
    assert.equal(profileHash(changed), base, label);
});

test("the profile hash changes when a profile value changes, whatever the header spacing", () => {
  for (const header of ["[profile.release]", "[ profile.release ]", "  [profile.release]"])
    assert.notEqual(profileHash(manifest({ header })), profileHash(manifest({ header, optLevel: "2" })), header);
});
