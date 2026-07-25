#!/usr/bin/env node

// Print the WASI SDK root, or nothing if none is found.
//
// Resolution order (first hit wins):
//   1. $WASI_SDK_PATH, if it already points at a real directory (CI sets this).
//   2. /opt/wasi-sdk
//   3. /opt/homebrew/opt/wasi-sdk
//   4. newest ~/.local/toolchains/wasi-sdk-*
//
// Kept outside mise tools so its clang does not shadow the host clang and break
// libarchive-sys bindgen on macOS. Mise consumes the printed root; absence still
// exits successfully, so only WASM build tasks fail on a missing SDK. Printing a
// directory that is not an SDK is worse than printing nothing: .config/mise.toml
// derives WASI_SYSROOT and WASI_CLANG from this, so a wrong root turns "no SDK
// installed" into a confusing missing-file error deep inside a build.

import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const isDirectory = (path) => Boolean(path) && existsSync(path) && statSync(path).isDirectory();

// Sorted oldest to newest, so the caller takes the last entry. Numeric
// collation keeps wasi-sdk-9 behind wasi-sdk-25.
export function localToolchains(home) {
  const toolchains = join(home, ".local", "toolchains");
  if (!isDirectory(toolchains)) return [];
  return readdirSync(toolchains, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("wasi-sdk-"))
    .map((entry) => join(toolchains, entry.name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function resolveWasiSdk({ env = process.env, home = os.homedir(), candidates = ["/opt/wasi-sdk", "/opt/homebrew/opt/wasi-sdk"] } = {}) {
  if (isDirectory(env.WASI_SDK_PATH)) return env.WASI_SDK_PATH;
  for (const candidate of candidates) if (isDirectory(candidate)) return candidate;
  return localToolchains(home).at(-1) || "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(resolveWasiSdk());
