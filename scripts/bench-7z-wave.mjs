#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

import { createRomWeaverWasiRunner } from '../packages/rom-weaver-wasm/src/rom-weaver-wasi-api.mjs';

const MIB = 1024 * 1024;
const DEFAULT_SIZE_MIB = 8;
const DEFAULT_CODECS = ['lzma2', 'lzma', 'zstd', 'deflate', 'bzip2', 'lz4', 'brotli', 'ppmd'];

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

function parseArgs(argv) {
  const options = {
    nativeBin: resolve(REPO_ROOT, 'target/debug/rom-weaver'),
    output: resolve(REPO_ROOT, 'target/bench-7z-wave.json'),
    sizeMiB: DEFAULT_SIZE_MIB,
    codecs: [...DEFAULT_CODECS],
    noBuild: false,
    threads: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--native-bin' && next) {
      options.nativeBin = resolve(REPO_ROOT, next);
      index += 1;
      continue;
    }
    if (arg === '--output' && next) {
      options.output = resolve(REPO_ROOT, next);
      index += 1;
      continue;
    }
    if (arg === '--size-mib' && next) {
      options.sizeMiB = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === '--codecs' && next) {
      options.codecs = next
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0);
      index += 1;
      continue;
    }
    if (arg === '--threads' && next) {
      options.threads = next
        .split(',')
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isInteger(value) && value >= 1);
      index += 1;
      continue;
    }
    if (arg === '--no-build') {
      options.noBuild = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.sizeMiB) || options.sizeMiB <= 0) {
    throw new Error('--size-mib must be a positive integer');
  }
  if (options.codecs.length === 0) {
    throw new Error('--codecs must include at least one codec');
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/bench-7z-wave.mjs [options]\n\n` +
    `Options:\n` +
    `  --native-bin <path>   Native rom-weaver binary path (default: target/debug/rom-weaver)\n` +
    `  --output <path>       JSON output path (default: target/bench-7z-wave.json)\n` +
    `  --size-mib <int>      Fixture size per profile in MiB (default: ${DEFAULT_SIZE_MIB})\n` +
    `  --codecs <csv>        Codec matrix (default: ${DEFAULT_CODECS.join(',')})\n` +
    `  --threads <csv>       Thread counts (default: 1 and min(8, logical CPUs))\n` +
    `  --no-build            Skip cargo build if native binary is missing\n` +
    `  -h, --help            Show this message\n`);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function defaultThreads() {
  const maxThreads = Math.max(1, Math.min(8, cpus().length));
  return uniqueSorted([1, maxThreads]);
}

function createIncompressibleBuffer(sizeBytes) {
  const buffer = Buffer.allocUnsafe(sizeBytes);
  let state = 0xA5A5A5A5;
  for (let index = 0; index < sizeBytes; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buffer[index] = state & 0xFF;
  }
  return buffer;
}

function createTextLikeBuffer(sizeBytes) {
  const sentence = Buffer.from(
    'rom-weaver benchmark payload line: fast extract, stable ratios, deterministic throughput.\n',
    'utf8',
  );
  const buffer = Buffer.alloc(sizeBytes);
  for (let offset = 0; offset < sizeBytes; offset += sentence.length) {
    sentence.copy(buffer, offset, 0, Math.min(sentence.length, sizeBytes - offset));
  }
  return buffer;
}

async function ensureFixture(path, sizeBytes, buildBytes) {
  try {
    const existing = await stat(path);
    if (existing.size === sizeBytes) {
      return;
    }
  } catch {
    // Missing fixture; regenerate.
  }

  const bytes = buildBytes(sizeBytes);
  await writeFile(path, bytes);
}

function runNative(binaryPath, args) {
  const result = spawnSync(binaryPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `native command failed (${result.status}): ${binaryPath} ${args.join(' ')}\n${result.stderr || result.stdout}`,
    );
  }
}

async function runWasm(runner, args) {
  const result = await runner.runJson(args);
  if (!result.ok || result.exitCode !== 0) {
    const terminal = result.events?.at?.(-1);
    throw new Error(
      `wasm command failed (${result.exitCode}): ${args.join(' ')}\n${JSON.stringify(terminal ?? result)}`,
    );
  }
}

function toMiBPerSecond(bytes, seconds) {
  return bytes / MIB / seconds;
}

async function verifyExtractedMatches(sourcePath, extractedPath) {
  const [source, extracted] = await Promise.all([readFile(sourcePath), readFile(extractedPath)]);
  if (!source.equals(extracted)) {
    throw new Error(`extracted payload mismatch: ${extractedPath}`);
  }
}

async function runMatrix({ runtime, codecs, threads, fixtures, workDir, nativeBin, wasmRunner }) {
  const rows = [];

  for (const fixture of fixtures) {
    const sourceName = basename(fixture.path);
    for (const threadCount of threads) {
      for (const codec of codecs) {
        const artifactDir = join(workDir, runtime, fixture.name, `threads-${threadCount}`);
        const archivePath = join(artifactDir, `${codec}.7z`);
        const extractDir = join(artifactDir, `${codec}-extract`);
        const codecValue = codec === 'store' ? codec : `${codec}:6`;

        await mkdir(artifactDir, { recursive: true });
        await rm(archivePath, { force: true });
        await rm(extractDir, { recursive: true, force: true });

        const compressArgs = [
          'compress',
          fixture.path,
          '--format',
          '7z',
          '--output',
          archivePath,
          '--codec',
          codecValue,
          '--threads',
          String(threadCount),
        ];

        let status = 'succeeded';
        let failureMessage = null;
        let compressSeconds = null;
        let extractSeconds = null;
        let archiveSize = null;

        try {
          const compressStart = performance.now();
          if (runtime === 'native') {
            runNative(nativeBin, compressArgs);
          } else {
            await runWasm(wasmRunner, compressArgs);
          }
          compressSeconds = (performance.now() - compressStart) / 1000;

          archiveSize = (await stat(archivePath)).size;
          const extractArgs = [
            'extract',
            archivePath,
            '--select',
            sourceName,
            '--out-dir',
            extractDir,
            '--threads',
            String(threadCount),
          ];

          const extractStart = performance.now();
          if (runtime === 'native') {
            runNative(nativeBin, extractArgs);
          } else {
            await runWasm(wasmRunner, extractArgs);
          }
          extractSeconds = (performance.now() - extractStart) / 1000;

          const extractedPath = join(extractDir, sourceName);
          await verifyExtractedMatches(fixture.path, extractedPath);
        } catch (error) {
          status = 'failed';
          failureMessage = error instanceof Error ? error.message : String(error);
        }

        rows.push({
          runtime,
          profile: fixture.name,
          codec,
          threads: threadCount,
          status,
          error: failureMessage,
          source_bytes: fixture.sizeBytes,
          archive_bytes: archiveSize,
          ratio: archiveSize === null ? null : archiveSize / fixture.sizeBytes,
          compress_seconds: compressSeconds,
          extract_seconds: extractSeconds,
          compress_mib_per_s:
            compressSeconds === null ? null : toMiBPerSecond(fixture.sizeBytes, compressSeconds),
          extract_mib_per_s:
            extractSeconds === null ? null : toMiBPerSecond(fixture.sizeBytes, extractSeconds),
        });
      }
    }
  }

  return rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const threads = options.threads && options.threads.length > 0
    ? uniqueSorted(options.threads)
    : defaultThreads();

  const fixtureBytes = options.sizeMiB * MIB;
  const benchRoot = resolve(REPO_ROOT, 'target/bench-7z-wave');
  const fixturesDir = join(benchRoot, 'fixtures');

  await mkdir(fixturesDir, { recursive: true });
  await ensureFixture(join(fixturesDir, 'incompressible.bin'), fixtureBytes, createIncompressibleBuffer);
  await ensureFixture(join(fixturesDir, 'text-like.bin'), fixtureBytes, createTextLikeBuffer);

  const fixtures = [
    { name: 'incompressible', path: join(fixturesDir, 'incompressible.bin'), sizeBytes: fixtureBytes },
    { name: 'text_like', path: join(fixturesDir, 'text-like.bin'), sizeBytes: fixtureBytes },
  ];

  if (!existsSync(options.nativeBin)) {
    if (options.noBuild) {
      throw new Error(`native binary not found at ${options.nativeBin} (and --no-build was set)`);
    }
    const build = spawnSync('cargo', ['build', '-p', 'rom-weaver-cli'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (build.status !== 0) {
      throw new Error(`cargo build failed with exit code ${build.status ?? 'unknown'}`);
    }
  }

  const wasmRunner = createRomWeaverWasiRunner();
  let rows;
  try {
    const nativeRows = await runMatrix({
      runtime: 'native',
      codecs: options.codecs,
      threads,
      fixtures,
      workDir: benchRoot,
      nativeBin: options.nativeBin,
      wasmRunner,
    });
    const wasmRows = await runMatrix({
      runtime: 'wasm',
      codecs: options.codecs,
      threads,
      fixtures,
      workDir: benchRoot,
      nativeBin: options.nativeBin,
      wasmRunner,
    });
    rows = [...nativeRows, ...wasmRows];
  } finally {
    if (typeof wasmRunner.dispose === 'function') {
      await wasmRunner.dispose();
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      logical_cpus: cpus().length,
    },
    config: {
      codecs: options.codecs,
      threads,
      profile_size_mib: options.sizeMiB,
      native_bin: options.nativeBin,
    },
    rows,
  };

  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`wrote benchmark JSON: ${options.output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
