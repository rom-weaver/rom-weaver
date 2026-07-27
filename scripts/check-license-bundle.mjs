#!/usr/bin/env node

// Generates the bundle into a throwaway directory and asserts its shape, so a
// generator regression fails the gate rather than shipping empty notices.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMain } from "./run-main.mjs";

runMain(() => {
  const output = mkdtempSync(join(os.tmpdir(), "rom-weaver-license-check-"));
  try {
    execFileSync(
      "node",
      [
        fileURLToPath(new URL("./gen-third-party-licenses.mjs", import.meta.url)),
        output,
        "--target",
        "all",
      ],
      { stdio: "inherit" },
    );
    const notices = Object.fromEntries(
      ["CLI_NOTICE", "WEBAPP_NOTICE", "NOTICE"].map((filename) => {
        const notice = readFileSync(join(output, filename), "utf8");
        if (!/^Third-party components$/m.test(notice))
          throw new Error(`${filename} is missing the 'Third-party components' heading`);
        return [filename, notice];
      }),
    );
    if (!/\| nod\s+\|/.test(notices.CLI_NOTICE))
      throw new Error("CLI_NOTICE is missing the in-source nod component");
    if (/\| react\s+\|/.test(notices.CLI_NOTICE))
      throw new Error("CLI_NOTICE unexpectedly contains webapp dependencies");
    if (!/\| react\s+\|/.test(notices.WEBAPP_NOTICE))
      throw new Error("WEBAPP_NOTICE is missing the webapp react dependency");
    if (/\| nod\s+\|/.test(notices.WEBAPP_NOTICE))
      throw new Error("WEBAPP_NOTICE unexpectedly contains CLI dependencies");
    if (!/\| nod\s+\|/.test(notices.NOTICE) || !/\| react\s+\|/.test(notices.NOTICE))
      throw new Error("NOTICE is missing the combined dependency inventory");
    const licenseDirs = readdirSync(join(output, "third_party", "licenses"));
    if (!licenseDirs.some((name) => name.startsWith("source-nod-")))
      throw new Error("license bundle is missing the in-source nod license");
    if (!licenseDirs.some((name) => name.startsWith("npm-react-")))
      throw new Error("license bundle is missing the webapp react license");
    if (existsSync(join(output, "THIRD_PARTY_LICENSES.md")))
      throw new Error("license bundle unexpectedly contains THIRD_PARTY_LICENSES.md");
    if (!existsSync(join(output, "third_party/licenses")))
      throw new Error("license bundle is missing third_party/licenses");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
