import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createWasmEnvImports } from './rom-weaver-runtime-utils.mjs';

const WASM_PATH = fileURLToPath(
  new URL('../../packages/rom-weaver-react/src/wasm/rom-weaver-app.wasm', import.meta.url),
);

test('provides every env function imported by the built wasm module', () => {
  const module = new WebAssembly.Module(readFileSync(WASM_PATH));
  const env = createWasmEnvImports();
  for (const imported of WebAssembly.Module.imports(module)) {
    if (imported.module === 'env' && imported.kind === 'function') {
      assert.equal(typeof env[imported.name], 'function', imported.name);
    }
  }
});

test('writes bounded multi-select results into wasm memory', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const request = new TextEncoder().encode('{}');
  new Uint8Array(memory.buffer).set(request, 0);
  const env = createWasmEnvImports(memory, () => [2, 4, -1]);

  assert.equal(env.rom_weaver_host_select(0, request.length), 2);
  assert.equal(env.rom_weaver_host_select_many(0, request.length, 16, 1), 1);
  assert.deepEqual([...new Uint32Array(memory.buffer, 16, 1)], [2]);
});
