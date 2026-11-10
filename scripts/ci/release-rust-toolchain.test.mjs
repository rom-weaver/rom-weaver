import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const SITES = [
  ".github/actions/build-cli-platform/action.yml",
  ".github/workflows/release.yml",
  ".github/workflows/cargo-publish.yml",
  ".github/workflows/npm-build.yml",
];

test("every release toolchain install uses the version pinned in mise.toml", () => {
  let installs = 0;
  for (const site of SITES) {
    const lines = read(site).split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("dtolnay/rust-toolchain@")) return;
      installs += 1;
      const step = lines.slice(index, index + 4).join("\n");
      assert.match(step, /toolchain: \$\{\{ steps\.rust-pin\.outputs\.version \}\}/u, `${site}:${index + 1}`);
      const before = lines.slice(0, index).join("\n");
      assert.ok(before.lastIndexOf("uses: ./.github/actions/read-rust-pin") !== -1, `${site}:${index + 1} reads the pin first`);
    });
  }
  assert.equal(installs, 6);
});

test("the pin reader extracts the version from the repository's mise.toml", (t) => {
  const action = read(".github/actions/read-rust-pin/action.yml");
  const script = action.match(/^ {6}run: \|\n((?: {8}.*\n)+)/mu)[1].replace(/^ {8}/gmu, "");
  const dir = mkdtempSync(join(tmpdir(), "rust-pin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (toml) => {
    writeFileSync(join(dir, "mise.toml"), toml);
    const output = join(dir, "output");
    writeFileSync(output, "");
    execFileSync("bash", ["-c", script.replace(".config/mise.toml", join(dir, "mise.toml"))], {
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    return readFileSync(output, "utf8");
  };
  assert.equal(run('[tools]\nrust = { version = "9.8.7", components = "rustfmt" }\n'), "rust=9.8.7\n");
  assert.equal(run('[tools]\nrust = "9.8.7"\n'), "rust=9.8.7\n");
  assert.throws(() => run("[tools]\nnode = 24\n"));
  assert.match(run(read(".config/mise.toml")), /^rust=\d+\.\d+\.\d+\n$/u);
});
