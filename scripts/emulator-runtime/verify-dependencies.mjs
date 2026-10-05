#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { platformConfig } from "./platform.mjs";

const windowsSystemLibraries = new Set(
  [
    "advapi32.dll",
    "bcrypt.dll",
    "cfgmgr32.dll",
    "comctl32.dll",
    "comdlg32.dll",
    "crypt32.dll",
    "dinput8.dll",
    "dnsapi.dll",
    "dwmapi.dll",
    "gdi32.dll",
    "hid.dll",
    "imm32.dll",
    "iphlpapi.dll",
    "kernel32.dll",
    "msimg32.dll",
    "msvcrt.dll",
    "ntdll.dll",
    "ole32.dll",
    "oleaut32.dll",
    "opengl32.dll",
    "powrprof.dll",
    "psapi.dll",
    "rpcrt4.dll",
    "secur32.dll",
    "setupapi.dll",
    "shell32.dll",
    "shlwapi.dll",
    "ucrtbase.dll",
    "user32.dll",
    "userenv.dll",
    "usp10.dll",
    "version.dll",
    "winmm.dll",
    "winspool.drv",
    "ws2_32.dll",
    "wsock32.dll",
  ].map((name) => name.toLowerCase()),
);

export const parseWindowsDependencies = (output) =>
  [...output.matchAll(/^\s*DLL Name:\s*(\S+)\s*$/gim)].map((match) => match[1]);

export const unexpectedWindowsDependencies = (dependencies) =>
  dependencies.filter((dependency) => {
    const name = dependency.toLowerCase();
    return (
      !windowsSystemLibraries.has(name) &&
      !name.startsWith("api-ms-win-") &&
      !name.startsWith("ext-ms-win-")
    );
  });

export const parseDarwinDependencies = (output) => {
  const dependencies = [];
  let loadsLibrary = false;
  for (const line of output.split("\n")) {
    const command = /^\s*cmd (\S+)/.exec(line);
    if (command) {
      loadsLibrary = /^LC_(?:LOAD|LOAD_WEAK|REEXPORT|LOAD_UPWARD)_DYLIB$/.test(command[1]);
    }
    const name = /^\s*name (.+) \(offset \d+\)/.exec(line);
    if (loadsLibrary && name) dependencies.push(name[1]);
  }
  return dependencies;
};

export const unexpectedDarwinDependencies = (dependencies) =>
  dependencies.filter(
    (dependency) =>
      !dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/Library/Frameworks/"),
  );

export const runtimeBinaries = (runtimeDirectory, manifest) =>
  [manifest.retroarch.path, ...manifest.cores.map((core) => core.path)].map((relative) =>
    path.join(runtimeDirectory, relative),
  );

const main = () => {
  const runtimeDirectory = path.resolve(process.argv[2] ?? "");
  assert.ok(process.argv[2], "usage: verify-dependencies.mjs RUNTIME_DIRECTORY");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(runtimeDirectory, "manifest.json"), "utf8"),
  );
  platformConfig(manifest.platform);
  for (const binary of runtimeBinaries(runtimeDirectory, manifest)) {
    let unexpected = [];
    if (manifest.platform === "win32-x64") {
      const output = execFileSync("objdump", ["-p", binary], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      unexpected = unexpectedWindowsDependencies(parseWindowsDependencies(output));
    } else if (manifest.platform.startsWith("darwin-")) {
      const output = execFileSync("otool", ["-l", binary], { encoding: "utf8" });
      unexpected = unexpectedDarwinDependencies(parseDarwinDependencies(output));
    }
    assert.deepEqual(unexpected, [], `${binary} has unpackaged dependencies`);
  }
  console.log(`verified emulator runtime dependencies: ${runtimeDirectory}`);
};

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) main();
