#!/usr/bin/env node

// Exercises each published install path end to end.
//
// `install.sh` is piped through stdin rather than passed as a file argument,
// because that is the documented command (`curl ... | sh`) and it is the only
// form that catches an installer whose entrypoint depends on knowing its own
// path.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const installDir = process.env.ROM_WEAVER_INSTALL_DIR;

function pipeToShell(shell, script) {
  const result = spawnSync(shell, [], { input: readFileSync(script), stdio: ["pipe", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${script} piped to ${shell} exited with status ${result.status}`);
}

// `needsInstallDir` is per method: the npm path installs globally and never
// reads ROM_WEAVER_INSTALL_DIR, so requiring it there would fail a leg that
// would otherwise work.
const METHODS = {
  "install.sh": {
    needsInstallDir: true,
    run: () => {
      pipeToShell("sh", "install.sh");
      execFileSync(`${installDir}/rom-weaver`, ["--version"], { stdio: "inherit" });
    },
  },
  "install.ps1": {
    needsInstallDir: true,
    run: () => {
      execFileSync("pwsh", ["-NoProfile", "-File", "install.ps1"], { stdio: "inherit" });
      execFileSync(`${installDir}/rom-weaver.exe`, ["--version"], { stdio: "inherit" });
    },
  },
  npm: {
    needsInstallDir: false,
    run: () => {
      execFileSync("npm", ["install", "--global", "rom-weaver"], { stdio: "inherit" });
      execFileSync("rom-weaver", ["--version"], { stdio: "inherit" });
    },
  },
};

try {
  const method = process.argv[2];
  const selected = METHODS[method];
  if (!selected) throw new Error(`unknown install method: ${method} (expected one of ${Object.keys(METHODS).join(", ")})`);
  if (selected.needsInstallDir && !installDir) throw new Error(`ROM_WEAVER_INSTALL_DIR is required by ${method}`);
  selected.run();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
