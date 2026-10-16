import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

const created = new Set();

// Node runs each test file in its own process, so one exit hook removes every
// directory the file made, whether its tests passed, failed, or threw.
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

export function makeTempDir(prefix) {
  const dir = mkdtempSync(join(os.tmpdir(), prefix));
  created.add(dir);
  return dir;
}
