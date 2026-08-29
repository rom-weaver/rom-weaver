#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createWasmSourceFingerprint } from "./wasm-source-fingerprint.mjs";
import { createWasmProdFingerprint } from "./wasm-prod-fingerprint.mjs";

export const parseMode = (value = "dev") => {
  if (value !== "dev" && value !== "prod") throw new Error("usage: node scripts/wasm/build-app.mjs [dev|prod]");
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

export function productionFingerprint({ builtArtifact, buildScript, quality, wasmOptVersion, stripVersion, brotliVersion, rustToolchain }) {
  return createWasmProdFingerprint({
    artifactPath: builtArtifact,
    buildScriptPath: buildScript,
    brotliQuality: quality,
    wasmOptVersion,
    stripVersion,
    brotliVersion,
    rustToolchain,
  });
}

// Unstable size flags for the production module only. -Zlocation-detail=none
// and -Zfmt-debug=none drop the panic-location strings and the derived Debug
// formatting code; -Cpanic=immediate-abort turns every panic into a bare
// `unreachable`, which needs std rebuilt from source, hence -Zbuild-std. The
// development build stays on stable and keeps all of it, because panic
// locations and messages in trace output are the primary way browser wasm
// issues are debugged.
//
// immediate-abort is a panic strategy rather than a build-std feature as of
// rustc 1.100.0-nightly; the old -Zbuild-std-features=panic_immediate_abort now
// fails core with a compile_error!.
export const NIGHTLY_RUSTFLAGS = ["-Zlocation-detail=none", "-Zfmt-debug=none", "-Zunstable-options", "-Cpanic=immediate-abort"];
export const NIGHTLY_CARGO_ARGS = ["-Zbuild-std=std,panic_abort"];

// Returns the toolchain name to build with, or null to build with the default
// stable toolchain. A nightly that is missing, or is missing a piece the build
// needs, MUST warn and fall back rather than fail: CI hosts without them still
// have to produce a module.
export function resolveNightlyToolchain(env = process.env, warn = (message) => process.stderr.write(message), target = "wasm32-wasip1-threads") {
  if (env.ROM_WEAVER_WASM_STABLE === "1") {
    warn("ROM_WEAVER_WASM_STABLE=1; building the production module with the stable toolchain\n");
    return null;
  }
  const toolchain = env.ROM_WEAVER_WASM_NIGHTLY;
  if (!toolchain) return null;
  const fallback = (reason) => {
    warn(`${reason}; falling back to the stable production build (install it with \`rustup toolchain install ${toolchain} --component rust-src --target ${target}\`)\n`);
    return null;
  };
  const sysroot = spawnSync("rustup", ["run", toolchain, "rustc", "--print", "sysroot"], { encoding: "utf8" });
  if (sysroot.error || sysroot.status !== 0) return fallback(`nightly toolchain ${toolchain} is unavailable`);
  const root = sysroot.stdout.trim();
  if (!existsSync(join(root, "lib/rustlib/src/rust/library/std/Cargo.toml"))) {
    return fallback(`nightly toolchain ${toolchain} has no rust-src component`);
  }
  // -Zbuild-std rebuilds the Rust half of std but not the WASI libc beside it,
  // so without the target's own rust-std component the link fails on a missing
  // crt1-command.o. Checking it here turns that into a fallback.
  if (!existsSync(join(root, `lib/rustlib/${target}/lib/self-contained/crt1-command.o`))) {
    return fallback(`nightly toolchain ${toolchain} has no ${target} standard library`);
  }
  return toolchain;
}

export function shouldReuseProductionArtifact({ artifact, brotliArtifactOk, fingerprintFile, wantedFingerprint, wantBrotli, force }) {
  return !force && existsSync(artifact) && brotliArtifactOk === wantBrotli && existsSync(fingerprintFile) && readFileSync(fingerprintFile, "utf8").trim() === wantedFingerprint;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const mode = parseMode(argv[0]);
  const root = env.MISE_PROJECT_ROOT;
  if (!root) throw new Error("MISE_PROJECT_ROOT is required");
  const target = "wasm32-wasip1-threads";
  const outDir = resolve(env.ROM_WEAVER_WASM_OUT_DIR || join(root, "packages/rom-weaver-webapp/src/wasm"));
  const packageDir = join(root, "packages/rom-weaver-webapp/src/wasm");
  const artifact = join(outDir, "rom-weaver-app.wasm");
  const builtArtifact = join(root, "target", target, "wasm-release", "examples", "rom-weaver-app.wasm");
  const fingerprintFile = `${artifact}.prod.sha256`;
  const sourceFingerprintFile = `${artifact}.source.sha256`;
  const sourceFingerprint = createWasmSourceFingerprint(root);
  if (!existsExecutable("cargo")) throw new Error("missing command: cargo");
  if (!existsExecutable(env.WASI_CLANG)) throw new Error(`missing WASI toolchain: ${env.WASI_CLANG} (install WASI SDK)`);
  if (!existsSync(env.WASI_SYSROOT || "")) throw new Error(`missing WASI sysroot: ${env.WASI_SYSROOT}`);
  mkdirSync(outDir, { recursive: true });

  const nightly = mode === "prod" ? resolveNightlyToolchain(env, undefined, target) : null;
  const cargoArgs = ["build", "-p", "rom-weaver-cli", "--no-default-features", "--features", "wasm-app", "--example", "rom-weaver-app", "--profile", "wasm-release", "--target", target];
  if (nightly) {
    // Cargo joins rustflags arrays across configuration sources, so --config
    // appends these to the target list in .cargo/config.toml instead of
    // replacing it the way a RUSTFLAGS environment override would.
    cargoArgs.push(...NIGHTLY_CARGO_ARGS, "--config", `target.${target}.rustflags=${JSON.stringify(NIGHTLY_RUSTFLAGS)}`);
  }

  process.stdout.write(`building ${target} -> ${artifact} (${nightly || "stable"})\n`);
  if (nightly) run("rustup", ["run", nightly, "cargo", ...cargoArgs]);
  else run("cargo", cargoArgs);

  if (mode === "prod") {
    if (!existsExecutable("wasm-opt")) throw new Error("missing command: wasm-opt (install via mise or brew install binaryen)");
    const wantBrotli = env.ROM_WEAVER_WASM_NO_BROTLI === "1" ? 0 : 1;
    if (!wantBrotli) rmSync(`${artifact}.br`, { force: true });
    const quality = env.BROTLI_QUALITY || "11";
    const fingerprint = productionFingerprint({
      builtArtifact,
      buildScript: fileURLToPath(import.meta.url),
      quality,
      wasmOptVersion: toolVersion("wasm-opt", ["--version"]),
      stripVersion: toolVersion(env.WASI_STRIP, ["--version"]),
      brotliVersion: `node-zlib libbrotli ${process.versions.brotli}`,
      rustToolchain: nightly ? `${toolVersion("rustup", ["run", nightly, "rustc", "-vV"])}\n${[...NIGHTLY_CARGO_ARGS, ...NIGHTLY_RUSTFLAGS].join(" ")}` : toolVersion("rustc", ["-vV"]),
    });
    const brotliArtifactOk = wantBrotli === 1 ? existsSync(`${artifact}.br`) : false;
    if (shouldReuseProductionArtifact({ artifact, brotliArtifactOk, fingerprintFile, wantedFingerprint: fingerprint, wantBrotli: Boolean(wantBrotli), force: env.ROM_WEAVER_WASM_FORCE === "1" })) {
      process.stdout.write("production WASM inputs unchanged; skipping wasm-opt and brotli\n");
    } else {
      rmSync(fingerprintFile, { force: true });
      cpSync(builtArtifact, artifact);
      run("wasm-opt", ["-O4", "--strip-debug", "--strip-dwarf", "--enable-bulk-memory", "--enable-bulk-memory-opt", "--enable-mutable-globals", "--enable-nontrapping-float-to-int", "--enable-sign-ext", "--enable-reference-types", "--enable-simd", "--enable-threads", "-o", `${artifact}.opt`, artifact]);
      cpSync(`${artifact}.opt`, artifact);
      rmSync(`${artifact}.opt`, { force: true });
      run(env.WASI_STRIP, [artifact]);
      if (wantBrotli) run("node", [join(root, "scripts/wasm/brotli-compress.mjs"), artifact, `${artifact}.br`, quality]);
      else process.stdout.write("ROM_WEAVER_WASM_NO_BROTLI=1; skipping .br sibling (host compresses on the fly)\n");
      writeFileSync(fingerprintFile, `${fingerprint}\n`);
    }
  } else {
    rmSync(`${artifact}.br`, { force: true });
    rmSync(fingerprintFile, { force: true });
    cpSync(builtArtifact, artifact);
    run(env.WASI_STRIP, [artifact]);
  }

  writeFileSync(sourceFingerprintFile, `${sourceFingerprint}\n`);
  run("node", [join(root, "scripts/gen-third-party-licenses.mjs"), outDir, "--target", "webapp"]);
  if (outDir !== packageDir) run("node", [join(root, "packages/rom-weaver-webapp/scripts/sync-dist.mjs"), outDir]);
  process.stdout.write(mode === "prod" && env.ROM_WEAVER_WASM_NO_BROTLI !== "1" ? `artifacts written to ${outDir} (rom-weaver-app.wasm, rom-weaver-app.wasm.br)\n` : `artifact written to ${artifact}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
