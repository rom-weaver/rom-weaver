import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createNodeFsRunner,
  createRomWeaverWasiRunner,
} from '../src/rom-weaver-wasi-api.mjs';
import {
  assertRunJsonSucceeded,
  runFullFormatMatrix,
  runPatchMatrix,
  runProgressMatrix,
  withTempFixture,
} from './test-helpers.mjs';

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));
const BROTLI_WASM_PATH = join(TEST_DIR, '..', 'rom-weaver-cli.wasm.br');

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

    assertRunJsonSucceeded(result, {
      command: 'checksum',
      context: 'nodefs checksum',
    });
  });
});

test('runJson emits trace events when --trace is enabled', async () => {
  await withTempFixture(async ({ sourcePath }) => {
    const runner = createRomWeaverWasiRunner();
    let streamedTraceEvents = 0;
    let streamedTraceLines = 0;
    const result = await runner.runJson(
      [
        '--trace',
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--no-extract',
      ],
      {
        onTraceEvent() {
          streamedTraceEvents += 1;
        },
        onTraceNonJsonLine() {
          streamedTraceLines += 1;
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    assert.ok((result.traceEvents.length + result.traceNonJsonLines.length) > 0);
    assert.ok((streamedTraceEvents + streamedTraceLines) > 0);
  });
});

test('runJson emits progress events for compress, extract, and patch-apply', async () => {
  await withTempFixture(async ({ dir, sourcePath }) => {
    const runner = createRomWeaverWasiRunner();
    await runProgressMatrix({
      runJson: (args, options) => runner.runJson(args, options),
      dir,
      sourcePath,
      appliedOutputName: 'applied-output',
    });
  });
});

test('runJson integration matrix covers chd, zip, and patch wasm paths', async () => {
  await withTempFixture(async ({ dir, sourcePath }) => {
    const runner = createRomWeaverWasiRunner();
    await runPatchMatrix({
      runJson: (args, options) => runner.runJson(args, options),
      dir,
      sourcePath,
    });
  });
});

test('runJson full format matrix covers patch and container registries', async () => {
  await withTempFixture(async ({ dir }) => {
    const runner = createRomWeaverWasiRunner();
    await runFullFormatMatrix({
      runJson: (args, options) => runner.runJson(args, options),
      dir,
    });
  });
});

test('runner supports explicit .wasm.br module paths', async () => {
  await withTempFixture(async ({ sourcePath }) => {
    const runner = createRomWeaverWasiRunner({ wasmPath: BROTLI_WASM_PATH });
    const result = await runner.runJson([
      'checksum',
      sourcePath,
      '--algo',
      'crc32',
      '--no-extract',
    ]);

    assertRunJsonSucceeded(result, {
      command: 'checksum',
      context: 'brotli wasm checksum',
    });
  });
});

test('runner rejects missing wasm artifacts', async () => {
  const runner = createRomWeaverWasiRunner({
    wasmPath: join(TEST_DIR, '..', 'missing-rom-weaver-cli.wasm'),
  });
  await assert.rejects(
    runner.run(['--help']),
    /WASM artifact not found/i,
  );
});

test('runner stdin normalization accepts supported types and rejects invalid input', async () => {
  const runner = createRomWeaverWasiRunner();
  const unknownCommand = ['definitely-not-a-command'];
  const validStdinValues = [
    'stdin text',
    new Uint8Array([1, 2, 3]),
    new Uint8Array([4, 5, 6]).buffer,
  ];

  for (const stdin of validStdinValues) {
    const result = await runner.run(unknownCommand, { stdin });
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.ok, false);
  }

  await assert.rejects(
    runner.run(unknownCommand, { stdin: 123 }),
    /stdin must be a string, Uint8Array, ArrayBuffer, or undefined/i,
  );
});

test('runJson stays stable across repeated wasm 7z codec create calls', async () => {
  await withTempFixture(async ({ dir }) => {
    const runner = createRomWeaverWasiRunner({ executionIsolation: 'none' });
    const sourcePath = join(dir, 'repeat-lzma-source.bin');
    const sourceData = Buffer.alloc(256 * 1024);
    for (let index = 0; index < sourceData.length; index += 1) {
      sourceData[index] = index % 251;
    }
    await writeFile(sourcePath, sourceData);

    try {
      for (const codec of ['store', 'deflate', 'bzip2', 'zstd', 'lz4', 'brotli', 'ppmd', 'lzma', 'lzma2']) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const archivePath = join(dir, `repeat-${codec}-${attempt}.7z`);
          const resolvedCodec = codec === 'store' ? codec : `${codec}:6`;
          const command = [
            'compress',
            sourcePath,
            '--format',
            '7z',
            '--output',
            archivePath,
            '--codec',
            resolvedCodec,
            '--threads',
            '1',
          ];
          const result = await runner.runJson(command);
          assert.equal(result.ok, true);
          assert.equal(result.exitCode, 0);
        }
      }
    } finally {
      if (typeof runner.dispose === 'function') {
        await runner.dispose();
      }
    }
  });
});
