import { describe, expect, it } from 'vitest';
import { createRomWeaverZenFsBrowser } from '../src/rom-weaver-zenfs-api.mjs';
import { createBrowserWorkerClient } from '../src/workers/browser-worker-client.mjs';
import {
  assertRunJsonSucceeded,
  getGuestFileSize,
  joinGuestPath,
  runFullFormatMatrix,
  runPatchMatrix,
  runProgressMatrix,
  toBytes,
  withTempFixture,
  writeGuestPatternFile,
  writeGuestFile,
} from './test-helpers.mjs';

const RUN_1GB_STRESS = typeof __ROM_WEAVER_WASM_STRESS_1GB__ !== 'undefined'
  && __ROM_WEAVER_WASM_STRESS_1GB__ === true;

describe('rom-weaver-wasm browser runner parity', () => {
  it('requires createRomWeaverZenFsBrowser to run in a dedicated worker', async () => {
    await expect(createRomWeaverZenFsBrowser()).rejects.toThrow(/Dedicated Worker/i);
  });

  it('runJson executes checksum through browser worker runner', async () => {
    await withTempFixture(async ({ sourcePath, worker }) => {
      const result = await worker.runJson([
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--no-extract',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.args[0]).toBe('--json');
      expect(Array.isArray(result.events)).toBe(true);
      expect(result.events.length).toBeGreaterThan(0);

      const terminal = result.events.at(-1);
      expect(terminal.status).toBe('succeeded');
      expect(terminal.command).toBe('checksum');
    });
  });

  it('scratch namespace is cleaned after each run', async () => {
    await withTempFixture(async ({ sourcePath, worker, opfsHandle }) => {
      const result = await worker.runJson([
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--no-extract',
      ]);
      expect(result.ok).toBe(true);

      const scratchNamespace = await opfsHandle.getDirectoryHandle('.rom-weaver-scratch');
      const runEntries = [];
      for await (const [entryName] of scratchNamespace.entries()) {
        runEntries.push(entryName);
      }
      expect(runEntries).toEqual([]);
    });
  });

  it('keeps /opfs mounts read-only while /scratch is writable', async () => {
    await withTempFixture(async ({ sourcePath, worker, dir }) => {
      const roOutput = joinGuestPath(dir, 'should-fail.gz');
      const roResult = await worker.runJson([
        'compress',
        sourcePath,
        '--format',
        'gz',
        '--output',
        roOutput,
        '--threads',
        '1',
      ]);
      expect(roResult.ok).toBe(false);
      expect(`${roResult.stderr}\n${roResult.stdout}`).toMatch(/read-only|rofs|permission/i);

      const scratchOutput = joinGuestPath('/scratch', 'writable.gz');
      const scratchResult = await worker.runJson([
        'compress',
        sourcePath,
        '--format',
        'gz',
        '--output',
        scratchOutput,
        '--threads',
        '1',
      ]);
      assertRunJsonSucceeded(scratchResult, { command: 'compress' });
    });
  });

  it('run reports parser errors for unknown commands', async () => {
    await withTempFixture(async ({ worker }) => {
      const result = await worker.run(['definitely-not-a-command']);
      expect(result.exitCode).not.toBe(0);
      expect(result.ok).toBe(false);
      expect(result.stderr).toMatch(/unknown command/i);
    });
  });

  it('browser runner supports mounted guest paths', async () => {
    await withTempFixture(async ({ worker, opfsHandle, dir }) => {
      const nestedSourcePath = joinGuestPath(dir, 'roms', 'input.bin');
      await writeGuestFile(opfsHandle, nestedSourcePath, toBytes('nested guest fixture'));

      const result = await worker.runJson([
        'checksum',
        nestedSourcePath,
        '--algo',
        'crc32',
        '--no-extract',
      ]);

      assertRunJsonSucceeded(result, {
        command: 'checksum',
      });
    });
  });

  it('runJson emits trace events when --trace is enabled', async () => {
    await withTempFixture(async ({ sourcePath, worker }) => {
      let streamedTraceEvents = 0;
      let streamedTraceLines = 0;
      const result = await worker.runJson(
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

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.traceEvents.length + result.traceNonJsonLines.length).toBeGreaterThan(0);
      expect(streamedTraceEvents + streamedTraceLines).toBeGreaterThan(0);
    });
  });

  it('runJson emits progress events for compress, extract, and patch-apply', async () => {
    await withTempFixture(async ({ dir, sourcePath, worker, opfsHandle }) => {
      await runProgressMatrix({
        runJson: (args, options) => worker.runJson(args, options),
        opfsHandle,
        dir,
        sourcePath,
        appliedOutputName: 'applied-output',
      });
    });
  });

  it('runJson integration matrix covers chd, zip, and patch wasm paths', async () => {
    await withTempFixture(async ({ dir, sourcePath, worker, opfsHandle, fixtures }) => {
      await runPatchMatrix({
        runJson: (args, options) => worker.runJson(args, options),
        opfsHandle,
        dir,
        sourcePath,
        fixtures,
      });
    });
  });

  it('runJson full format matrix covers patch and container registries', async () => {
    await withTempFixture(async ({ dir, worker, opfsHandle, fixtures }) => {
      await runFullFormatMatrix({
        runJson: (args, options) => worker.runJson(args, options),
        opfsHandle,
        dir,
        fixtures,
      });
    });
  });

  it('runner supports explicit wasm module URL paths', async () => {
    await withTempFixture(async ({ sourcePath, worker }) => {
      const result = await worker.runJson([
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--no-extract',
      ]);

      assertRunJsonSucceeded(result, {
        command: 'checksum',
      });
    }, {
      initOptions: {
        wasmUrl: new URL('../rom-weaver-cli.wasm', import.meta.url).href,
      },
    });
  });

  it('runner rejects missing wasm artifacts', async () => {
    await expect(
      withTempFixture(async () => {}, {
        initOptions: {
          wasmUrl: new URL('../missing-rom-weaver-cli.wasm', import.meta.url).href,
        },
      }),
    ).rejects.toThrow(/failed to fetch wasm module/i);
  });

  it('runner stdin normalization accepts supported types and rejects invalid input', async () => {
    await withTempFixture(async ({ worker }) => {
      const unknownCommand = ['definitely-not-a-command'];
      const validStdinValues = [
        'stdin text',
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]).buffer,
      ];

      for (const stdin of validStdinValues) {
        const result = await worker.run(unknownCommand, { stdin });
        expect(result.exitCode).not.toBe(0);
        expect(result.ok).toBe(false);
      }

      await expect(
        worker.run(unknownCommand, { stdin: 123 }),
      ).rejects.toThrow(/stdin must be a string, Uint8Array, ArrayBuffer, or undefined/i);
    });
  });

  it('runJson stays stable across repeated wasm 7z codec create calls', async () => {
    await withTempFixture(async ({ dir, tmpDir, worker, opfsHandle }) => {
      const sourcePath = joinGuestPath(dir, 'repeat-lzma-source.bin');
      const sourceData = new Uint8Array(256 * 1024);
      for (let index = 0; index < sourceData.length; index += 1) {
        sourceData[index] = index % 251;
      }
      await writeGuestFile(opfsHandle, sourcePath, sourceData);

      for (const codec of ['store', 'deflate', 'bzip2', 'zstd', 'lz4', 'brotli', 'ppmd', 'lzma', 'lzma2']) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const archivePath = joinGuestPath(tmpDir, `repeat-${codec}-${attempt}.7z`);
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
          const result = await worker.runJson(command);
          expect(result.ok).toBe(true);
          expect(result.exitCode).toBe(0);
        }
      }
    });
  });

  it('survives large-file memory pressure workloads without worker crashes', async () => {
    await withTempFixture(async ({ dir, tmpDir, worker, opfsHandle }) => {
      const sourcePath = joinGuestPath(dir, 'large-memory-source.bin');
      await writeGuestPatternFile(opfsHandle, sourcePath, 64 * 1024 * 1024);

      const archivePath = joinGuestPath(tmpDir, 'large-memory.gz');
      const extractDir = joinGuestPath(tmpDir, 'large-memory-extract');
      const extractedPath = joinGuestPath(extractDir, 'large-memory');

      assertRunJsonSucceeded(
        await worker.runJson([
          'compress',
          sourcePath,
          '--format',
          'gz',
          '--output',
          archivePath,
          '--threads',
          '1',
        ]),
        { command: 'compress' },
      );

      assertRunJsonSucceeded(
        await worker.runJson([
          'extract',
          archivePath,
          '--out-dir',
          extractDir,
          '--threads',
          '1',
        ]),
        { command: 'extract' },
      );

      assertRunJsonSucceeded(
        await worker.runJson([
          'checksum',
          sourcePath,
          '--algo',
          'crc32',
          '--no-extract',
        ]),
        { command: 'checksum' },
      );

      assertRunJsonSucceeded(
        await worker.runJson([
          'checksum',
          extractedPath,
          '--algo',
          'crc32',
          '--no-extract',
        ]),
        { command: 'checksum' },
      );
    });
  });

  it.runIf(RUN_1GB_STRESS)(
    'survives 1 GiB compress extract checksum and 100MB-class xdelta apply workload',
    async () => {
      await withTempFixture(async ({ dir, tmpDir, worker, opfsHandle }) => {
        const oneGiB = 1024 * 1024 * 1024;
        const mutatedTailBytes = 100 * 1024 * 1024;
        const sourcePath = joinGuestPath(dir, 'stress-1gb-source.bin');
        const modifiedPath = joinGuestPath(dir, 'stress-1gb-modified.bin');
        const archivePath = joinGuestPath(tmpDir, 'stress-1gb.gz');
        const extractDir = joinGuestPath(tmpDir, 'stress-1gb-extract');
        const extractedPath = joinGuestPath(extractDir, 'stress-1gb');
        const patchPath = joinGuestPath(tmpDir, 'stress-1gb-tail.xdelta');
        const appliedPath = joinGuestPath(tmpDir, 'stress-1gb-applied.bin');

        await writeGuestPatternFile(opfsHandle, sourcePath, oneGiB, {
          chunkSizeBytes: 4 * 1024 * 1024,
        });
        await writeGuestPatternFile(opfsHandle, modifiedPath, oneGiB, {
          chunkSizeBytes: 4 * 1024 * 1024,
          mutateFromOffset: oneGiB - mutatedTailBytes,
          mutateAdd: 29,
        });

        assertRunJsonSucceeded(
          await worker.runJson([
            'compress',
            sourcePath,
            '--format',
            'gz',
            '--output',
            archivePath,
            '--threads',
            '1',
          ]),
          { command: 'compress' },
        );

        assertRunJsonSucceeded(
          await worker.runJson([
            'extract',
            archivePath,
            '--out-dir',
            extractDir,
            '--threads',
            '1',
          ]),
          { command: 'extract' },
        );

        assertRunJsonSucceeded(
          await worker.runJson([
            'checksum',
            sourcePath,
            '--algo',
            'crc32',
            '--no-extract',
          ]),
          { command: 'checksum' },
        );
        assertRunJsonSucceeded(
          await worker.runJson([
            'checksum',
            extractedPath,
            '--algo',
            'crc32',
            '--no-extract',
          ]),
          { command: 'checksum' },
        );

        assertRunJsonSucceeded(
          await worker.runJson([
            'patch-create',
            '--original',
            sourcePath,
            '--modified',
            modifiedPath,
            '--format',
            'xdelta',
            '--output',
            patchPath,
            '--threads',
            '1',
          ]),
          { command: 'patch-create' },
        );

        const patchSize = await getGuestFileSize(opfsHandle, patchPath);
        expect(patchSize).toBeGreaterThan(80 * 1024 * 1024);

        assertRunJsonSucceeded(
          await worker.runJson([
            'patch-apply',
            '--input',
            extractedPath,
            '--patch',
            patchPath,
            '--output',
            appliedPath,
            '--threads',
            '1',
            '--no-compress',
          ]),
          { command: 'patch-apply' },
        );

        assertRunJsonSucceeded(
          await worker.runJson([
            'checksum',
            appliedPath,
            '--algo',
            'crc32',
            '--no-extract',
          ]),
          { command: 'checksum' },
        );
      });
    },
    45 * 60 * 1000,
  );
});

describe('rom-weaver-wasm browser worker client parity', () => {
  it('browser worker client initializes and runs checksum with runJson', async () => {
    await withTempFixture(async ({ sourcePath, worker }) => {
      let streamedEvents = 0;
      const result = await worker.runJson(
        ['checksum', sourcePath, '--algo', 'crc32', '--no-extract'],
        {
          onEvent() {
            streamedEvents += 1;
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(streamedEvents).toBeGreaterThan(0);
      const terminal = result.events.at(-1);
      expect(terminal.status).toBe('succeeded');
      expect(terminal.command).toBe('checksum');

      const disposed = await worker.dispose();
      expect(disposed.disposed).toBe(true);
    }, {
      prefix: 'rom-weaver-wasm-worker-test-',
      sourceContents: 'rom-weaver worker fixture',
    });
  });

  it('browser worker client rejects runJson before init', async () => {
    const client = createBrowserWorkerClient();
    try {
      await expect(
        client.runJson(['checksum', '/opfs/does-not-exist.bin', '--algo', 'crc32', '--no-extract']),
      ).rejects.toMatchObject({
        kind: 'worker',
      });
    } finally {
      client.terminate();
    }
  });

  it('browser worker client rejects unsupported worker modes with typed kind', async () => {
    const client = createBrowserWorkerClient();
    try {
      await expect(
        client._send({ type: 'init', mode: 'invalid-mode', options: {} }),
      ).rejects.toMatchObject({
        kind: 'worker',
      });
    } finally {
      client.terminate();
    }
  });

  it('browser worker client handles concurrent runJson calls after init', async () => {
    await withTempFixture(async ({ worker, opfsHandle, dir }) => {
      const sourceAPath = joinGuestPath(dir, 'a.bin');
      const sourceBPath = joinGuestPath(dir, 'b.bin');
      await writeGuestFile(opfsHandle, sourceAPath, toBytes('parallel fixture a'));
      await writeGuestFile(opfsHandle, sourceBPath, toBytes('parallel fixture b'));

      const [resultA, resultB] = await Promise.all([
        worker.runJson(['checksum', sourceAPath, '--algo', 'crc32', '--no-extract']),
        worker.runJson(['checksum', sourceBPath, '--algo', 'crc32', '--no-extract']),
      ]);

      for (const result of [resultA, resultB]) {
        assertRunJsonSucceeded(result, {
          command: 'checksum',
        });
      }
    });
  });

  it('browser worker client streams progress events for compress, extract, and patch-apply', async () => {
    await withTempFixture(async ({ dir, sourcePath, worker, opfsHandle }) => {
      await runProgressMatrix({
        runJson: (args, options) => worker.runJson(args, options),
        opfsHandle,
        dir,
        sourcePath,
        appliedOutputName: 'patched-output',
      });
    }, {
      prefix: 'rom-weaver-wasm-worker-progress-',
      sourceFileName: 'source.bin',
      sourceContents: 'worker progress fixture',
    });
  });

  it('browser worker client integration matrix covers chd, zip, and patch wasm paths', async () => {
    await withTempFixture(async ({ dir, sourcePath, worker, opfsHandle, fixtures }) => {
      await runPatchMatrix({
        runJson: (args, options) => worker.runJson(args, options),
        opfsHandle,
        dir,
        sourcePath,
        fixtures,
      });
    }, {
      prefix: 'rom-weaver-wasm-worker-matrix-',
      sourceFileName: 'source.bin',
      sourceContents: 'rom-weaver worker matrix fixture',
    });
  });

  it('browser worker client full format matrix covers patch and container registries', async () => {
    await withTempFixture(async ({ dir, worker, opfsHandle, fixtures }) => {
      await runFullFormatMatrix({
        runJson: (args, options) => worker.runJson(args, options),
        opfsHandle,
        dir,
        fixtures,
      });
    }, {
      prefix: 'rom-weaver-wasm-worker-full-matrix-',
      sourceFileName: 'source.bin',
      sourceContents: 'rom-weaver worker full matrix fixture',
    });
  });
});
