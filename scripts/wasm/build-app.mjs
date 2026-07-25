#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createWasmProdFingerprint } from "./wasm-prod-fingerprint.mjs";

export const parseMode = (value = "dev") => {
  if (value !== "dev" && value !== "prod") throw new Error("usage: node scripts/wasm/build-app.mjs [dev|prod]");
  return value;
};

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "inherit", ...options });
const output = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", ...options }).trim();
const existsExecutable = (file) => {
  if (!file) return false;
  if (file?.includes("/")) return existsSync(file);
  return spawnSync(file, ["--version"], { stdio: "ignore" }).status === 0;
};

export function productionFingerprint({ builtArtifact, buildScript, quality, wasmOptVersion, stripVersion, brotliVersion }) {
  return createWasmProdFingerprint({
    artifactPath: builtArtifact,
    buildScriptPath: buildScript,
    brotliQuality: quality,
    wasmOptVersion,
    stripVersion,
    brotliVersion,
  });
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
  const builtArtifact = join(root, "target", target, "wasm-release", "rom-weaver-app.wasm");
  const fingerprintFile = `${artifact}.prod.sha256`;
  if (!existsExecutable("cargo")) throw new Error("missing command: cargo");
  if (!existsExecutable(env.WASI_CLANG)) throw new Error(`missing WASI toolchain: ${env.WASI_CLANG} (install WASI SDK)`);
  if (!existsSync(env.WASI_SYSROOT || "")) throw new Error(`missing WASI sysroot: ${env.WASI_SYSROOT}`);
  mkdirSync(outDir, { recursive: true });

  process.stdout.write(`building ${target} -> ${artifact}\n`);
  run("cargo", ["build", "-p", "rom-weaver-cli", "--features", "wasm-app", "--bin", "rom-weaver-app", "--profile", "wasm-release", "--target", target]);

  if (mode === "prod") {
    if (!existsExecutable("wasm-opt")) throw new Error("missing command: wasm-opt (install via mise or brew install binaryen)");
    const wantBrotli = env.ROM_WEAVER_WASM_NO_BROTLI === "1" ? 0 : 1;
    if (!wantBrotli) rmSync(`${artifact}.br`, { force: true });
    const quality = env.BROTLI_QUALITY || "11";
    const fingerprint = productionFingerprint({
      builtArtifact,
      buildScript: fileURLToPath(import.meta.url),
      quality,
      wasmOptVersion: output("wasm-opt", ["--version"], { stdio: ["ignore", "pipe", "pipe"] }),
      stripVersion: output(env.WASI_STRIP, ["--version"], { stdio: ["ignore", "pipe", "pipe"] }),
      brotliVersion: `node-zlib libbrotli ${process.versions.brotli}`,
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

  run("node", [join(root, "scripts/gen-third-party-licenses.mjs"), outDir]);
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
