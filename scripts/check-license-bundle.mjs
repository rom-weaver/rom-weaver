#!/usr/bin/env node

// Generates the bundle into a throwaway directory and asserts its shape, so a
// generator regression fails the gate rather than shipping an empty NOTICE.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMain } from "./run-main.mjs";

runMain(() => {
  const output = mkdtempSync(join(os.tmpdir(), "rom-weaver-license-check-"));
  try {
    execFileSync("node", [fileURLToPath(new URL("./gen-third-party-licenses.mjs", import.meta.url)), output], { stdio: "inherit" });
    const notice = readFileSync(join(output, "NOTICE"), "utf8");
    if (!/^Third-party components$/m.test(notice)) throw new Error("NOTICE is missing the 'Third-party components' heading");
    if (existsSync(join(output, "THIRD_PARTY_LICENSES.md"))) throw new Error("license bundle unexpectedly contains THIRD_PARTY_LICENSES.md");
    if (!existsSync(join(output, "third_party/licenses"))) throw new Error("license bundle is missing third_party/licenses");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
