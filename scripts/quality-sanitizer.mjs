#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runMain } from "./run-main.mjs";
export function sanitizerEnvironment(root, inherited = process.env) {
  const env = {
    ...inherited,
    CARGO_BUILD_JOBS: inherited.CARGO_BUILD_JOBS ?? "4",
    RUSTC_WRAPPER: "",
    RUSTC_WORKSPACE_WRAPPER: "",
    CMAKE_C_COMPILER_LAUNCHER: "",
    CMAKE_CXX_COMPILER_LAUNCHER: "",
    CARGO_TARGET_DIR: path.join(root, "target"),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    CC: "clang-18",
    CXX: "clang++-18",
    CFLAGS: "-fsanitize=address,undefined -fno-omit-frame-pointer",
    CXXFLAGS: "-fsanitize=address,undefined -fno-omit-frame-pointer",
    RUSTFLAGS:
      "-Zsanitizer=address -Zexternal-clangrt -C linker=clang-18 -C link-arg=-fsanitize=address,undefined -C force-frame-pointers=yes",
    ASAN_OPTIONS: "detect_leaks=1:halt_on_error=1",
    UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
  };
  delete env.CARGO_ENCODED_RUSTFLAGS;
  return env;
}
export function instrumentedArchive(symbols) {
  if (!symbols.includes("__asan_") || !symbols.includes("__ubsan_"))
    throw new Error("Vendored libarchive is missing ASan or UBSan instrumentation");
  return { address: true, undefined: true };
}
function findArchives(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? findArchives(name) : entry.name === "libarchive.a" ? [name] : [];
  });
}
export function sanitizerArgs() {
  return [
    "+nightly-2026-08-25",
    "test",
    "-p",
    "rom-weaver-containers",
    "--lib",
    "--target",
    "x86_64-unknown-linux-gnu",
    "libarchive::entries::tests",
    "--",
    "--nocapture",
  ];
}
export function runSanitizers(run = spawnSync) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Sanitizer lane currently supports x86_64 Linux only");
  const root = path.resolve(".agent/quality-sanitizer");
  fs.mkdirSync(root, { recursive: true });
  const env = sanitizerEnvironment(root);
  const clangVersion = run("clang-18", ["--version"], { encoding: "utf8" });
  const rustVersion = run("rustc", ["+nightly-2026-08-25", "--version"], { encoding: "utf8" });
  if (clangVersion.status !== 0 || rustVersion.status !== 0)
    throw new Error("Cannot resolve pinned sanitizer compiler versions");
  const args = sanitizerArgs();
  const listing = run("cargo", [...args.slice(0, -1), "--list"], {
    encoding: "utf8",
    env,
    timeout: 1800000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listing.status !== 0) throw new Error(`Sanitizer discovery/build failed: ${listing.stderr}`);
  const tests = listing.stdout.split(/\r?\n/u).filter((line) => line.endsWith(": test"));
  if (!tests.length) throw new Error("Sanitizer lane selected no tests");
  const archives = findArchives(env.CARGO_TARGET_DIR);
  if (!archives.length)
    throw new Error("No vendored libarchive archive found; native instrumentation unverified");
  for (const archive of archives) {
    const symbols = run("nm", ["-u", archive], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (symbols.status !== 0) throw new Error("Cannot inspect native instrumentation");
    instrumentedArchive(symbols.stdout);
  }
  fs.writeFileSync(
    path.join(root, "instrumentation.json"),
    `${JSON.stringify({ tests, archives, clangVersion: clangVersion.stdout.trim(), rustVersion: rustVersion.stdout.trim(), rust: "ASan", vendoredLibarchive: "ASan + UBSan", limitation: "Rust has no UBSan mode; Rust standard library, external system libraries and assembly are not claimed instrumented" }, null, 2)}\n`,
  );
  const result = run("cargo", args, {
    encoding: "utf8",
    env,
    timeout: 1800000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  fs.writeFileSync(path.join(root, "tests.log"), output);
  fs.writeFileSync(
    path.join(root, "summary.json"),
    `${JSON.stringify({ status: result.status, error: result.error?.message ?? null, selectedTests: tests.length })}\n`,
  );
  console.log(output);
  return result.status ?? 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(() => runSanitizers());
