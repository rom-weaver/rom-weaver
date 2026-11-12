#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cargoTargetDir } from "../cargo-target-dir.mjs";
import { brotliCompressFile } from "./brotli-compress.mjs";
import { restoreWasmArtifacts, storeWasmArtifacts, wasmArtifactCacheKey, wasmArtifactCacheRoot } from "./wasm-artifact-cache.mjs";
import { createCargoConfigSnapshot, createWasmSourceFingerprint, recordedSourceFingerprint, shouldBuildWasm, wasmSourcesModifiedSince } from "./wasm-source-fingerprint.mjs";
import { createWasmProdFingerprint } from "./wasm-prod-fingerprint.mjs";

export const parseMode = (value = "dev") => {
  if (value !== "dev" && value !== "fast" && value !== "prod") throw new Error("usage: node scripts/wasm/build-app.mjs [dev|fast|prod]");
  return value;
};

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "inherit", ...options });
// Both streams, as the shell's `$(tool --version 2>&1)` captured. Today's
// wasm-opt and llvm-strip print to stdout, but a version string that moved to
// stderr would drop out of the fingerprint silently - and a fingerprint that
// ignores a toolchain upgrade serves a stale artifact from the cache.
function toolVersion(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw new Error(`missing command: ${command} (${result.error.message})`);
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}
// `-x`, not `-e`: a WASI_CLANG that exists without the executable bit fails
// later inside cargo, as a compiler error with no mention of the toolchain.
const existsExecutable = (file) => {
  if (!file) return false;
  if (file.includes("/")) {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return spawnSync(file, ["--version"], { stdio: "ignore" }).status === 0;
};

// `--zero-filled-memory` asserts the imported memory arrives zeroed, so
// wasm-opt MAY drop data segments that only write zeros. The module imports
// its memory, so the guarantee comes from the host, not the wasm spec: the
// browser runtime creates a fresh WebAssembly.Memory per run
// (createSharedThreadMemory in browser-opfs-runner.ts). Reusing a memory
// across runs would break this flag's assumption.
export const WASM_OPT_ARGS = [
  "-O3",
  "--strip-debug",
  "--strip-dwarf",
  "--zero-filled-memory",
  "--enable-bulk-memory",
  "--enable-bulk-memory-opt",
  "--enable-mutable-globals",
  "--enable-nontrapping-float-to-int",
  "--enable-sign-ext",
  "--enable-reference-types",
  "--enable-simd",
  "--enable-threads",
];

export function productionFingerprint({ builtArtifact, buildScript, quality, wasmOptVersion, wasmOptArgs, stripVersion, brotliVersion }) {
  return createWasmProdFingerprint({
    artifactPath: builtArtifact,
    buildScriptPath: buildScript,
    brotliQuality: quality,
    wasmOptVersion,
    wasmOptArgs,
    stripVersion,
    brotliVersion,
  });
}

export function shouldReuseProductionArtifact({ artifact, brotliArtifactOk, fingerprintFile, wantedFingerprint, wantBrotli, force }) {
  return !force && existsSync(artifact) && brotliArtifactOk === wantBrotli && existsSync(fingerprintFile) && readFileSync(fingerprintFile, "utf8").trim() === wantedFingerprint;
}

// Rust embeds absolute dependency and toolchain source paths (panic locations)
// in the module. Fixed prefixes make the bytes independent of the Cargo home and
// toolchain location. Workspace crates already embed relative paths, and a
// checkout-specific flag would change every rustc command line and stop sccache
// from replaying dependencies across worktrees, so the checkout is not remapped.
// Cargo appends --config rustflags to the list in .cargo/config.toml, so
// extraFlags follow the remapping and override earlier flags.
export function targetRustflagsArgs({ cargoHome, sysroot, target, extraFlags = [] }) {
  const flags = [
    [cargoHome, "/cargo"],
    [sysroot, "/rustc-sysroot"],
  ].map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  return ["--config", `target.${target}.rustflags=${JSON.stringify([...flags, ...extraFlags])}`];
}

// Environment that reaches rustc or the C compilers as flags. Compiler paths
// stay out of the cache key: they differ per checkout, and the wrapper scripts
// they name are part of the source fingerprint.
const BUILD_FLAG_ENV = /^(?:RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_PROFILE_|CARGO_TARGET_WASM32_|(?:(?:HOST|TARGET)_)?C(?:XX)?FLAGS|CC_SHELL_ESCAPED_FLAGS|CRATE_CC_NO_DEFAULTS)/;
export const buildFlagEnv = (env) =>
  JSON.stringify(
    Object.keys(env)
      .filter((name) => BUILD_FLAG_ENV.test(name))
      .sort()
      .map((name) => [name, env[name]]),
  );

// .cargo/config.toml turns on linker-plugin-lto, which runs link-time optimization (LTO) over every crate.
// A later flag overrides it, and RUSTFLAGS would drop the remapping above.
const FAST_RUSTFLAGS = ["-C", "linker-plugin-lto=no"];

// Fast mode writes a quick sidecar, so the webapp build skips its quality-11 compression.
function brotliSettings(mode, env) {
  if (mode === "fast") return { wantBrotli: true, quality: env.BROTLI_QUALITY || "1" };
  return { wantBrotli: mode === "prod" && env.ROM_WEAVER_WASM_NO_BROTLI !== "1", quality: env.BROTLI_QUALITY || "11" };
}

// WASM MUST use the default window: the larger asset window increases this module's transfer size.
function writeBrotliSidecar({ artifact, quality }) {
  const { cached, compressedSize, sourceSize } = brotliCompressFile({
    inputPath: artifact,
    outputPath: `${artifact}.br`,
    quality,
    parameterProfile: "default",
  });
  process.stdout.write(`brotli q${quality}${cached ? " (cached)" : ""}: ${sourceSize} -> ${compressedSize} bytes\n`);
}

// Any mode may have built the module in outDir. One built from the current inputs is as good as a fast build.
const builtFromCurrentInputs = ({ artifact, sourceFingerprint }) =>
  !shouldBuildWasm({ artifactExists: existsSync(artifact), recordedFingerprint: recordedSourceFingerprint(artifact), sourceFingerprint });

function keepModuleWithSidecar({ artifact, fingerprintFile, quality }) {
  process.stdout.write(`kept ${artifact}: already built from the current inputs\n`);
  // A dev module has no sidecar. Without one, the webapp build compresses the module at quality 11.
  if (!existsSync(`${artifact}.br`) && !existsSync(fingerprintFile)) writeBrotliSidecar({ artifact, quality });
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const mode = parseMode(argv[0]);
  const root = env.MISE_PROJECT_ROOT;
  if (!root) throw new Error("MISE_PROJECT_ROOT is required");
  const target = "wasm32-wasip1-threads";
  const outDir = resolve(env.ROM_WEAVER_WASM_OUT_DIR || join(root, "packages/rom-weaver-webapp/src/wasm"));
  const packageDir = join(root, "packages/rom-weaver-webapp/src/wasm");
  const artifact = join(outDir, "rom-weaver-app.wasm");
  const builtArtifact = join(cargoTargetDir(root, env), target, "wasm-release", "examples", "rom-weaver-app.wasm");
  const fingerprintFile = `${artifact}.prod.sha256`;
  const sourceFingerprintFile = `${artifact}.source.sha256`;
  const sourcesReadAt = Date.now();
  const sourceFingerprint = createWasmSourceFingerprint(root);
  if (!existsExecutable("cargo")) throw new Error("missing command: cargo");
  if (!existsExecutable(env.WASI_CLANG)) throw new Error(`missing WASI toolchain: ${env.WASI_CLANG} (install WASI SDK)`);
  if (!existsSync(env.WASI_SYSROOT || "")) throw new Error(`missing WASI sysroot: ${env.WASI_SYSROOT}`);
  if (mode === "prod" && !existsExecutable("wasm-opt")) throw new Error("missing command: wasm-opt (install via mise or brew install binaryen)");
  mkdirSync(outDir, { recursive: true });

  const { wantBrotli, quality } = brotliSettings(mode, env);
  const brotliVersion = `node-zlib libbrotli ${process.versions.brotli}`;
  const stripVersion = toolVersion(env.WASI_STRIP, ["--version"]);
  const wasmOptVersion = mode === "prod" ? toolVersion("wasm-opt", ["--version"]) : "";
  const force = env.ROM_WEAVER_WASM_FORCE === "1";
  if (!wantBrotli) rmSync(`${artifact}.br`, { force: true });
  const cacheFiles = wantBrotli ? ["rom-weaver-app.wasm", "rom-weaver-app.wasm.br"] : ["rom-weaver-app.wasm"];
  const configurationOptions = { root, cwd: process.cwd(), cargoHome: env.CARGO_HOME || join(homedir(), ".cargo"), sinceMs: sourcesReadAt };
  let configuration;
  if (env.ROM_WEAVER_WASM_CACHE !== "0") {
    try {
      configuration = createCargoConfigSnapshot(configurationOptions);
    } catch {
      configuration = undefined;
    }
    if (!configuration?.usable) process.stderr.write("warning: shared WASM cache disabled: could not snapshot Cargo configuration\n");
  }
  // scripts/wasm is part of the source fingerprint, so this script's flags,
  // remapping, and wasm-opt arguments are keyed through it.
  const cache =
    !configuration?.usable
      ? undefined
      : {
          root: wasmArtifactCacheRoot(env),
          key: wasmArtifactCacheKey({
            mode,
            source: sourceFingerprint,
            configuration: configuration.fingerprint,
            rustc: toolVersion("rustc", ["-vV"]),
            clang: toolVersion(env.WASI_CLANG, ["--version"]),
            strip: stripVersion,
            env: buildFlagEnv(env),
            wasmOpt: wasmOptVersion,
            brotli: wantBrotli ? `q${quality} ${brotliVersion}` : "none",
          }),
        };

  const keep = mode === "fast" && !force && builtFromCurrentInputs({ artifact, sourceFingerprint });
  // A restore or build stopped halfway leaves a module its recorded inputs do not describe.
  if (!keep) rmSync(sourceFingerprintFile, { force: true });
  if (keep) {
    keepModuleWithSidecar({ artifact, fingerprintFile, quality });
  } else if (cache && !force && restoreWasmArtifacts({ ...cache, files: cacheFiles, outDir })) {
    // The production fingerprint describes this checkout's Cargo output, which the cached module did not come from.
    rmSync(fingerprintFile, { force: true });
    process.stdout.write(`reused ${mode} WASM for unchanged inputs from ${join(cache.root, cache.key)}\n`);
    writeFileSync(sourceFingerprintFile, `${sourceFingerprint}\n`);
  } else {
    buildArtifact({ mode, target, artifact, builtArtifact, fingerprintFile, wantBrotli, quality, brotliVersion, stripVersion, wasmOptVersion, force, env });
    settleBuiltModule({ cache, configuration, configurationOptions, root, sourcesReadAt, sourceFingerprint, sourceFingerprintFile, cacheFiles, outDir, force });
  }

  run("node", [join(root, "scripts/gen-third-party-licenses.mjs"), outDir, "--target", "webapp"]);
  if (outDir !== packageDir) run("node", [join(root, "packages/rom-weaver-webapp/scripts/sync-dist.mjs"), outDir]);
  process.stdout.write(wantBrotli ? `artifacts written to ${outDir} (rom-weaver-app.wasm, rom-weaver-app.wasm.br)\n` : `artifact written to ${artifact}\n`);
}

// An edit during the build reaches Cargo's output, even if reverted before the build ends.
// The fingerprint predates it, so a later build could reuse the module with that edit.
function settleBuiltModule({ cache, configuration, configurationOptions, root, sourcesReadAt, sourceFingerprint, sourceFingerprintFile, cacheFiles, outDir, force }) {
  const sourcesChanged = wasmSourcesModifiedSince(root, sourcesReadAt) || createWasmSourceFingerprint(root) !== sourceFingerprint;
  if (sourcesChanged) rmSync(sourceFingerprintFile, { force: true });
  else writeFileSync(sourceFingerprintFile, `${sourceFingerprint}\n`);
  if (!cache) return;
  let configurationAfter;
  try {
    configurationAfter = createCargoConfigSnapshot(configurationOptions);
  } catch {
    configurationAfter = undefined;
  }
  if (sourcesChanged || !configurationAfter?.usable || configurationAfter.fingerprint !== configuration.fingerprint || configurationAfter.state !== configuration.state || configurationAfter.modified) {
    process.stderr.write("warning: WASM build inputs changed during the build; not caching it\n");
    return;
  }
  try {
    storeWasmArtifacts({ ...cache, files: cacheFiles, sourceDir: outDir, replace: force });
  } catch (error) {
    process.stderr.write(`warning: could not store WASM in ${cache.root} (${error.message})\n`);
  }
}

function buildArtifact({ mode, target, artifact, builtArtifact, fingerprintFile, wantBrotli, quality, brotliVersion, stripVersion, wasmOptVersion, force, env }) {
  process.stdout.write(`building ${target} -> ${artifact}\n`);
  const rustflagsArgs = targetRustflagsArgs({
    cargoHome: env.CARGO_HOME || join(homedir(), ".cargo"),
    sysroot: toolVersion("rustc", ["--print", "sysroot"]),
    target,
    extraFlags: mode === "fast" ? FAST_RUSTFLAGS : [],
  });
  run("cargo", ["build", "-p", "rom-weaver-cli", "--no-default-features", "--features", "wasm-app", "--example", "rom-weaver-app", "--profile", "wasm-release", "--target", target, ...rustflagsArgs]);

  if (mode === "prod") {
    const fingerprint = productionFingerprint({
      builtArtifact,
      buildScript: fileURLToPath(import.meta.url),
      quality,
      wasmOptVersion,
      wasmOptArgs: WASM_OPT_ARGS,
      stripVersion,
      brotliVersion,
    });
    const brotliArtifactOk = wantBrotli ? existsSync(`${artifact}.br`) : false;
    if (shouldReuseProductionArtifact({ artifact, brotliArtifactOk, fingerprintFile, wantedFingerprint: fingerprint, wantBrotli, force })) {
      process.stdout.write("production WASM inputs unchanged; skipping wasm-opt and brotli\n");
    } else {
      rmSync(fingerprintFile, { force: true });
      cpSync(builtArtifact, artifact);
      run("wasm-opt", [...WASM_OPT_ARGS, "-o", `${artifact}.opt`, artifact]);
      cpSync(`${artifact}.opt`, artifact);
      rmSync(`${artifact}.opt`, { force: true });
      run(env.WASI_STRIP, [artifact]);
      if (wantBrotli) writeBrotliSidecar({ artifact, quality });
      else
        process.stdout.write(
          "ROM_WEAVER_WASM_NO_BROTLI=1; skipping .br sibling (host compresses on the fly)\n",
        );
      writeFileSync(fingerprintFile, `${fingerprint}\n`);
    }
  } else {
    rmSync(fingerprintFile, { force: true });
    cpSync(builtArtifact, artifact);
    run(env.WASI_STRIP, [artifact]);
    if (wantBrotli) writeBrotliSidecar({ artifact, quality });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
