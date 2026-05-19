import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNodeWorkerClient } from '../src/workers/node-worker-client.mjs';

test('node worker client initializes and runs checksum with runJson', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rom-weaver-wasm-worker-test-'));
  const sourcePath = join(dir, 'input.bin');
  const client = createNodeWorkerClient();

  try {
    await writeFile(sourcePath, Buffer.from('rom-weaver worker fixture', 'utf8'));

    const init = await client.init('wasi');
    assert.equal(init.mode, 'wasi');

    let streamedEvents = 0;
    const result = await client.runJson(
      ['checksum', sourcePath, '--algo', 'crc32', '--no-extract'],
      {
        onEvent() {
          streamedEvents += 1;
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    assert.ok(streamedEvents > 0);
    const terminal = result.events.at(-1);
    assert.equal(terminal.status, 'succeeded');
    assert.equal(terminal.command, 'checksum');

    const disposed = await client.dispose();
    assert.equal(disposed.disposed, true);
  } finally {
    await client.terminate();
    await rm(dir, { recursive: true, force: true });
  }
});

test('node worker client rejects runJson before init', async () => {
  const client = createNodeWorkerClient();
  try {
    await assert.rejects(
      client.runJson(['checksum', '/tmp/does-not-exist.bin', '--algo', 'crc32', '--no-extract']),
      (error) => {
        assert.equal(error.kind, 'worker');
        assert.equal(error.context?.command, 'checksum');
        assert.equal(error.context?.stage, 'worker.runJson');
        assert.match(error.message, /worker is not initialized/i);
        return true;
      },
    );
  } finally {
    await client.terminate();
  }
});

test('node worker client rejects unsupported worker modes with typed kind', async () => {
  const client = createNodeWorkerClient();
  try {
    await assert.rejects(
      client.init('invalid-mode'),
      (error) => {
        assert.equal(error.kind, 'worker');
        assert.equal(error.context?.stage, 'worker.init');
        assert.match(error.message, /unsupported node worker mode/i);
        return true;
      },
    );
  } finally {
    await client.terminate();
  }
});

test('node worker client handles concurrent runJson calls after init', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rom-weaver-wasm-worker-parallel-'));
  const sourceAPath = join(dir, 'a.bin');
  const sourceBPath = join(dir, 'b.bin');
  const client = createNodeWorkerClient();

  try {
    await writeFile(sourceAPath, Buffer.from('parallel fixture a', 'utf8'));
    await writeFile(sourceBPath, Buffer.from('parallel fixture b', 'utf8'));
    await client.init('wasi');

    const [resultA, resultB] = await Promise.all([
      client.runJson(['checksum', sourceAPath, '--algo', 'crc32', '--no-extract']),
      client.runJson(['checksum', sourceBPath, '--algo', 'crc32', '--no-extract']),
    ]);

    for (const result of [resultA, resultB]) {
      assert.equal(result.exitCode, 0);
      assert.equal(result.ok, true);
      const terminal = result.events.at(-1);
      assert.equal(terminal.status, 'succeeded');
      assert.equal(terminal.command, 'checksum');
    }
  } finally {
    await client.terminate();
    await rm(dir, { recursive: true, force: true });
  }
});
