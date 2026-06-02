import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The package browser OPFS API is now TypeScript source. The legacy scripts/wasm
// copy is still a build-artifact source for scripts/build-wasm-app.sh, so it is
// no longer byte-identical to the checked package implementation.

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');

const CANONICAL = resolve(REPO_ROOT, 'scripts/wasm/rom-weaver-browser-opfs-api.mjs');
const PACKAGE_COPY = resolve(PACKAGE_DIR, 'src/rom-weaver-browser-opfs-api.ts');

if (!existsSync(CANONICAL) || !existsSync(PACKAGE_COPY)) {
  process.stderr.write(
    `Missing OPFS API source file:\n`
      + `  legacy artifact source: ${CANONICAL}\n`
      + `  package TS source: ${PACKAGE_COPY}\n`,
  );
  process.exit(1);
}

process.stdout.write('OPFS API package source is TypeScript; legacy scripts/wasm artifact source exists.\n');
