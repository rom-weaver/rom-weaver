import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./generate-channel-icons.mjs", import.meta.url));
const SKIPPED = /skipping the render/;

const generate = (outputDir) =>
  execFileSync(process.execPath, [scriptPath, "--output-dir", outputDir], { encoding: "utf8" });

test("reuses a stamped render and re-renders output that no longer matches its stamp", { timeout: 180_000 }, () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-icon-stamp-"));
  const productionDir = path.join(outputDir, "channel-icons", "production");
  const stampPath = path.join(outputDir, "render-stamp.json");
  try {
    assert.doesNotMatch(generate(outputDir), SKIPPED);
    const rendered = {
      favicon: fs.readFileSync(path.join(productionDir, "favicon.ico")),
      icon: fs.readFileSync(path.join(productionDir, "icon-192.png")),
    };
    assert.match(generate(outputDir), SKIPPED);

    const staleOutputs = [
      { name: "a deleted output", mutate: () => fs.rmSync(path.join(productionDir, "favicon.ico")) },
      {
        name: "a corrupted output",
        mutate: () => fs.writeFileSync(path.join(productionDir, "icon-192.png"), "not a png"),
      },
      {
        name: "a stamp written for other inputs",
        mutate: () => {
          const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
          fs.writeFileSync(stampPath, JSON.stringify({ ...stamp, inputs: "0".repeat(64) }));
        },
      },
    ];
    for (const { name, mutate } of staleOutputs) {
      mutate();
      assert.doesNotMatch(generate(outputDir), SKIPPED, name);
      assert.deepEqual(fs.readFileSync(path.join(productionDir, "favicon.ico")), rendered.favicon, name);
      assert.deepEqual(fs.readFileSync(path.join(productionDir, "icon-192.png")), rendered.icon, name);
      assert.match(generate(outputDir), SKIPPED, `${name}: the re-render MUST restamp its output`);
    }
  } finally {
    fs.rmSync(outputDir, { force: true, recursive: true });
  }
});
