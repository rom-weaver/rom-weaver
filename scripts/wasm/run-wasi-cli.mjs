#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';
import { createWasmEnvImports } from './rom-weaver-runtime-utils.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_WASM_MODULE = resolve(REPO_ROOT, 'packages/rom-weaver-wasm/rom-weaver-cli.wasm');

function parseArgs(argv) {
  let wasmModule = DEFAULT_WASM_MODULE;
  let commandArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      commandArgs = argv.slice(index + 1);
      break;
    }
    if (arg === '--wasm-module') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--wasm-module requires a path value');
      }
      wasmModule = resolve(REPO_ROOT, next);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (commandArgs.length === 0) {
    throw new Error('missing command args; pass wasm CLI args after `--`');
  }

  return { wasmModule, commandArgs };
}

async function main() {
  const { wasmModule, commandArgs } = parseArgs(process.argv.slice(2));
  const wasmBytes = readFileSync(wasmModule);
  const module = await WebAssembly.compile(wasmBytes);
  const wasi = new WASI({
    version: 'preview1',
    args: ['rom-weaver', ...commandArgs],
    env: process.env,
    preopens: { '/': '/' },
    returnOnExit: true,
  });

  const envImports = {
    ...createWasmEnvImports(),
    __archive_write_entry_filetype_unsupported: () => 0,
  };

  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
    env: envImports,
  });

  const exitCode = wasi.start(instance);
  process.exitCode = Number.isInteger(exitCode) ? exitCode : 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
