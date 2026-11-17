import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";

const script = new URL("./compress-static-assets.mjs", import.meta.url).pathname;
const quality = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } };

test("sidecars match a synchronous quality-11 brotli pass and skip excluded files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compress-static-"));
  try {
    const text = Buffer.from("rom-weaver ".repeat(2000));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "index.html"), text);
    fs.writeFileSync(path.join(dir, "assets", "app.js"), text);
    fs.writeFileSync(path.join(dir, "assets", "app.js.map"), text);
    fs.writeFileSync(path.join(dir, "tiny.txt"), "x");
    const result = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const expected = zlib.brotliCompressSync(text, quality);
    assert.deepEqual(fs.readFileSync(path.join(dir, "index.html.br")), expected);
    assert.deepEqual(fs.readFileSync(path.join(dir, "assets", "app.js.br")), expected);
    assert.equal(fs.existsSync(path.join(dir, "assets", "app.js.map.br")), false);
    assert.equal(fs.existsSync(path.join(dir, "tiny.txt.br")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing directory argument exits with usage status 2", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 2);
});
