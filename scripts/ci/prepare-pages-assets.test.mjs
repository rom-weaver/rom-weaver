import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { preparePagesAssets } from "./prepare-pages-assets.mjs";

const fixture = () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-pages-assets-"));
  const cheatDir = path.join(distDir, "cheats");
  fs.mkdirSync(cheatDir);
  fs.writeFileSync(
    path.join(cheatDir, "manifest.json"),
    JSON.stringify({ systems: { nes: { path: "/cheats/nes.json?revision=test" } } }),
  );
  fs.writeFileSync(path.join(cheatDir, "nes.json"), "{}\n");
  fs.writeFileSync(path.join(cheatDir, "nes.json.br"), "compressed");
  return { cheatDir, distDir };
};

test("removes only manifest-listed raw shards", (context) => {
  const { cheatDir, distDir } = fixture();
  context.after(() => fs.rmSync(distDir, { recursive: true }));
  fs.writeFileSync(path.join(cheatDir, "LICENSE"), "license");

  assert.deepEqual(preparePagesAssets(distDir), ["nes.json"]);
  assert.equal(fs.existsSync(path.join(cheatDir, "nes.json")), false);
  assert.equal(fs.existsSync(path.join(cheatDir, "nes.json.br")), true);
  assert.equal(fs.existsSync(path.join(cheatDir, "LICENSE")), true);
});

test("rejects a missing sidecar", (context) => {
  const { cheatDir, distDir } = fixture();
  context.after(() => fs.rmSync(distDir, { recursive: true }));
  fs.rmSync(path.join(cheatDir, "nes.json.br"));

  assert.throws(() => preparePagesAssets(distDir), /pair is incomplete/u);
});

test("rejects nested manifest paths", (context) => {
  const { cheatDir, distDir } = fixture();
  context.after(() => fs.rmSync(distDir, { recursive: true }));
  fs.writeFileSync(
    path.join(cheatDir, "manifest.json"),
    JSON.stringify({ systems: { nes: { path: "/cheats/nested/nes.json" } } }),
  );

  assert.throws(() => preparePagesAssets(distDir), /Invalid cheat shard path/u);
});

test("rejects raw shards that are absent from the manifest", (context) => {
  const { cheatDir, distDir } = fixture();
  context.after(() => fs.rmSync(distDir, { recursive: true }));
  fs.writeFileSync(path.join(cheatDir, "snes.json"), "{}\n");

  assert.throws(() => preparePagesAssets(distDir), /absent from the manifest/u);
  assert.equal(fs.existsSync(path.join(cheatDir, "nes.json")), true);
});
