import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The browser OPFS API exists in two tracked copies that must stay byte-identical:
//   - scripts/wasm/rom-weaver-browser-opfs-api.mjs  (canonical; build-wasm-app.sh ships this one)
//   - packages/rom-weaver-wasm/src/rom-weaver-browser-opfs-api.mjs  (imported by workers/tests/benches)
// Editing one without the other ships stale code while local benches/tests keep passing. This guard
// fails loudly so any edit must touch both copies in lockstep.

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');

const CANONICAL = resolve(REPO_ROOT, 'scripts/wasm/rom-weaver-browser-opfs-api.mjs');
const PACKAGE_COPY = resolve(PACKAGE_DIR, 'src/rom-weaver-browser-opfs-api.mjs');

const canonicalText = readFileSync(CANONICAL, 'utf8');
const packageText = readFileSync(PACKAGE_COPY, 'utf8');

if (canonicalText !== packageText) {
  process.stderr.write(
    `OPFS API copies diverged. Re-sync them (canonical is scripts/wasm):\n`
      + `  ${CANONICAL}\n  ${PACKAGE_COPY}\n`,
  );
  process.exit(1);
}

process.stdout.write('OPFS API copies are in sync.\n');
