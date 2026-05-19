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
