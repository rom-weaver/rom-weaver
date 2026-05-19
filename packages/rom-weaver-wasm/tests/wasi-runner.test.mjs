import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createNodeFsRunner,
  createRomWeaverWasiRunner,
} from '../src/rom-weaver-wasi-api.mjs';
import {
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

    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    const terminal = result.events.at(-1);
    assert.equal(terminal.status, 'succeeded');
    assert.equal(terminal.command, 'checksum');
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

    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    const terminal = result.events.at(-1);
    assert.equal(terminal.status, 'succeeded');
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
