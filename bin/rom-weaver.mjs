#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const linuxLibc = () => {
  if (process.platform !== "linux") return null;
  const report = process.report?.getReport?.();
  return report?.header?.glibcVersionRuntime ? "gnu" : "musl";
};

const platformPackage = (() => {
  if (process.platform === "darwin") return `@rom-weaver/darwin-${process.arch}`;
  if (process.platform === "win32") return `@rom-weaver/win32-${process.arch}-msvc`;
  if (process.platform === "linux" && process.arch === "x64" && linuxLibc() === "gnu")
    return "@rom-weaver/linux-x64-gnu";
  return null;
})();

if (!platformPackage) {
  console.error(`rom-weaver does not support ${process.platform}/${process.arch}`);
  process.exit(1);
}

try {
  const binary = process.platform === "win32" ? "bin/rom-weaver.exe" : "bin/rom-weaver";
  const binaryPath = require.resolve(`${platformPackage}/${binary}`);
  const child = spawn(binaryPath, process.argv.slice(2), { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`rom-weaver failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = Number.isInteger(code) ? code : 1;
  });
} catch (error) {
  console.error(`rom-weaver could not load ${platformPackage}: ${error.message}`);
  console.error(
    "Reinstall rom-weaver (@rom-weaver/cli) with optional dependencies enabled for this platform.",
  );
  process.exitCode = 1;
}
