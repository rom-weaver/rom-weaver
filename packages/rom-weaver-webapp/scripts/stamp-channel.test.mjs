import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const STAMP_CHANNEL = fileURLToPath(new URL("./stamp-channel.mjs", import.meta.url));

test("stamp-channel refuses an unknown channel instead of stamping dev", () => {
  const result = spawnSync(process.execPath, [STAMP_CHANNEL, "betta"], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /unknown channel 'betta'/u);
  assert.doesNotMatch(result.stdout, /stamped/u);
});
