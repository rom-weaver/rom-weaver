import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createNodeFsRunner,
  createRomWeaverWasiRunner,
} from '../src/rom-weaver-wasi-api.mjs';

async function withTempFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'rom-weaver-wasm-test-'));
  try {
    const sourcePath = join(dir, 'input.bin');
    await writeFile(sourcePath, Buffer.from('rom-weaver wasm test fixture', 'utf8'));
    await run({ dir, sourcePath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('runJson executes checksum through WASI runner', async () => {
  await withTempFixture(async ({ sourcePath }) => {
    const runner = createRomWeaverWasiRunner();
    const result = await runner.runJson([
      'checksum',
      sourcePath,
      '--algo',
      'crc32',
      '--no-extract',
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    assert.equal(result.args[0], '--json');
    assert.ok(Array.isArray(result.events));
    assert.ok(result.events.length > 0);

    const terminal = result.events.at(-1);
    assert.equal(terminal.status, 'succeeded');
    assert.equal(terminal.command, 'checksum');
  });
});

test('run reports parser errors for unknown commands', async () => {
  const runner = createRomWeaverWasiRunner();
  const result = await runner.run(['definitely-not-a-command']);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /unknown command/i);
});

test('nodefs runner supports mounted guest paths', async () => {
  await withTempFixture(async ({ dir }) => {
    const runner = createNodeFsRunner({
      mountCwd: false,
      mounts: {
        '/roms': dir,
      },
    });
    const result = await runner.runJson([
      'checksum',
      '/roms/input.bin',
      '--algo',
      'crc32',
      '--no-extract',
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    const terminal = result.events.at(-1);
    assert.equal(terminal.status, 'succeeded');
    assert.equal(terminal.command, 'checksum');
  });
});
