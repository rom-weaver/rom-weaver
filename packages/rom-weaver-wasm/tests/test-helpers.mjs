import { expect } from 'vitest';
import { createBrowserWorkerClient } from '../src/workers/browser-worker-client.mjs';

const OPFS_GUEST_ROOT = '/work';
const TEXT_ENCODER = new TextEncoder();

const VCDIFF_SOURCE_FIXTURE_URL = new URL('../../../tests/fixtures/vcdiff/secondary-source.bin', import.meta.url);
const VCDIFF_PATCH_FIXTURE_URL = new URL('../../../tests/fixtures/vcdiff/secondary-djw.xdelta', import.meta.url);
const VCDIFF_TARGET_FIXTURE_URL = new URL('../../../tests/fixtures/vcdiff/secondary-target.bin', import.meta.url);

let fixtureBytesPromise = null;

export async function withTempFixture(run, options = {}) {
  const {
    prefix = 'rom-weaver-wasm-test-',
    sourceFileName = 'input.bin',
    sourceContents = 'rom-weaver wasm test fixture',
    clientOptions = {},
    initOptions = {},
  } = options;

  if (typeof navigator.storage?.persist === 'function') {
    try {
      await navigator.storage.persist();
    } catch {
      // best-effort only
    }
  }

  const root = await navigator.storage.getDirectory();
  const fixtureName = `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fixtureHandle = await root.getDirectoryHandle(fixtureName, { create: true });
  const worker = createBrowserWorkerClient(clientOptions);

  try {
    const init = await worker.init({
      wasmUrl: new URL('../rom-weaver-cli.wasm', import.meta.url).href,
      opfsHandle: fixtureHandle,
      workGuestPath: OPFS_GUEST_ROOT,
      runtimeMounts: [OPFS_GUEST_ROOT],
      ...initOptions,
    });
    expect(init.mode).toBe('browser-opfs');

    const sourcePath = joinGuestPath(OPFS_GUEST_ROOT, sourceFileName);
    await writeGuestFile(fixtureHandle, sourcePath, toBytes(sourceContents));

    const fixtures = await loadVcdiffFixtures();
    const vcdiffSourcePath = joinGuestPath(OPFS_GUEST_ROOT, 'fixtures', 'secondary-source.bin');
    const vcdiffPatchPath = joinGuestPath(OPFS_GUEST_ROOT, 'fixtures', 'secondary-djw.xdelta');
    const vcdiffTargetPath = joinGuestPath(OPFS_GUEST_ROOT, 'fixtures', 'secondary-target.bin');
    await writeGuestFile(fixtureHandle, vcdiffSourcePath, fixtures.source);
    await writeGuestFile(fixtureHandle, vcdiffPatchPath, fixtures.patch);
    await writeGuestFile(fixtureHandle, vcdiffTargetPath, fixtures.target);

    await run({
      dir: OPFS_GUEST_ROOT,
      workDir: OPFS_GUEST_ROOT,
      init,
      sourcePath,
      worker,
      opfsHandle: fixtureHandle,
      fixtures: {
        vcdiffSourcePath,
        vcdiffPatchPath,
        vcdiffTargetPath,
      },
    });
  } finally {
    try {
      worker.terminate();
    } catch {
      // ignore best-effort cleanup failures
    }
    await removeFixtureDirectory(root, fixtureName);
  }
}

export function getTerminalEvent(result) {
  expect(Array.isArray(result.events)).toBe(true);
  expect(result.events.length).toBeGreaterThan(0);
  return result.events.at(-1);
}

export function assertRunJsonSucceeded(result, options = {}) {
  const { command } = options;
  const terminal = getTerminalEvent(result);
  const failureMessage = [
    `expected ${command ?? 'command'} to succeed`,
    `exitCode=${result.exitCode}`,
    `ok=${result.ok}`,
    `label=${JSON.stringify(terminal?.label ?? '')}`,
    `details=${JSON.stringify(terminal?.details ?? null)}`,
    `stderr=${JSON.stringify(result.stderr ?? '')}`,
    `error=${JSON.stringify(errorMessage(result.error))}`,
    `stack=${JSON.stringify(errorStack(result.error))}`,
  ].join(' ');
  expect(result.exitCode, failureMessage).toBe(0);
  expect(result.ok, failureMessage).toBe(true);
  expect(terminal.status).toBe('succeeded');
  if (typeof command === 'string') {
    expect(terminal.command).toBe(command);
  }
  return terminal;
}

function errorMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error);
}

function errorStack(error) {
  if (error && typeof error === 'object' && typeof error.stack === 'string') return error.stack;
  return '';
}

export function assertFailedWithLabel(result, labelPattern, context) {
  expect(result.ok, `${context} should fail in the current wasm matrix`).toBe(false);
  expect(result.exitCode, `${context} should not exit with code 0`).not.toBe(0);
  const terminal = getTerminalEvent(result);
  expect(terminal.status).toBe('failed');
  expect(String(terminal.label || '')).toMatch(labelPattern);
}

export async function runProgressMatrix({ runJson, opfsHandle, dir, sourcePath, appliedOutputName }) {
  const archivePath = joinGuestPath(OPFS_GUEST_ROOT, 'archive.gz');
  const extractDir = joinGuestPath(OPFS_GUEST_ROOT, 'extract');
  const originalPath = joinGuestPath(dir, 'original.bin');
  const modifiedPath = joinGuestPath(dir, 'modified.bin');
  const patchPath = joinGuestPath(OPFS_GUEST_ROOT, 'update.ips');
  const appliedPath = joinGuestPath(OPFS_GUEST_ROOT, appliedOutputName ?? 'applied-output.bin');

  await writeGuestFile(opfsHandle, originalPath, toBytes('abcdefgh'));
  await writeGuestFile(opfsHandle, modifiedPath, toBytes('a1XYZf!!!'));

  const compressEvents = [];
  const compressResult = await runJson(
    ['compress', sourcePath, '--format', 'gz', '--output', archivePath, '--threads', '1'],
    {
      onEvent(event) {
        compressEvents.push(event);
      },
    },
  );
  assertRunJsonSucceeded(compressResult, { command: 'compress' });
  expect(
    compressEvents.some(
      (event) => event.command === 'compress' && event.status === 'running' && event.format === 'gz',
    ),
  ).toBe(true);

  const extractEvents = [];
  const extractResult = await runJson(
    ['extract', archivePath, '--out-dir', extractDir, '--threads', '1'],
    {
      onEvent(event) {
        extractEvents.push(event);
      },
    },
  );
  assertRunJsonSucceeded(extractResult, { command: 'extract' });
  expect(
    extractEvents.some(
      (event) => event.command === 'extract' && event.status === 'running' && event.format === 'gz',
    ),
  ).toBe(true);

  const patchCreateResult = await runJson([
    'patch-create',
    '--original',
    originalPath,
    '--modified',
    modifiedPath,
    '--format',
    'ips',
    '--output',
    patchPath,
    '--threads',
    '1',
  ]);
  assertRunJsonSucceeded(patchCreateResult, { command: 'patch-create' });

  const patchApplyEvents = [];
  const patchApplyResult = await runJson(
    [
      'patch-apply',
      '--input',
      originalPath,
      '--patch',
      patchPath,
      '--output',
      appliedPath,
      '--compress-format',
      'gz',
      '--threads',
      '1',
    ],
    {
      onEvent(event) {
        patchApplyEvents.push(event);
      },
    },
  );
  assertRunJsonSucceeded(patchApplyResult, { command: 'patch-apply' });
  expect(
    patchApplyEvents.some(
      (event) => event.command === 'patch-apply' && event.status === 'running' && event.format === 'IPS',
    ),
  ).toBe(true);
  expect(
    patchApplyEvents.some(
      (event) => event.command === 'patch-apply'
        && event.status === 'running'
        && event.stage === 'compress'
        && typeof event.format === 'string'
        && event.format.length > 0,
    ),
  ).toBe(true);
}

export async function runPatchMatrix({ runJson, opfsHandle, dir, sourcePath, fixtures }) {
  const chdSourcePath = joinGuestPath(dir, 'chd-source.bin');
  const chdPath = joinGuestPath(OPFS_GUEST_ROOT, 'archive.chd');
  const chdExtractDir = joinGuestPath(OPFS_GUEST_ROOT, 'chd-extract');
  const zipPath = joinGuestPath(OPFS_GUEST_ROOT, 'archive.zip');
  const zipExtractDir = joinGuestPath(OPFS_GUEST_ROOT, 'zip-extract');
  const sevenZPath = joinGuestPath(OPFS_GUEST_ROOT, 'archive.7z');
  const sevenZLzmaPath = joinGuestPath(OPFS_GUEST_ROOT, 'archive-lzma.7z');
  const sevenZLzma2Path = joinGuestPath(OPFS_GUEST_ROOT, 'archive-lzma2.7z');
  const sevenZLzmaExtractDir = joinGuestPath(OPFS_GUEST_ROOT, '7z-lzma-extract');
  const sevenZLzma2ExtractDir = joinGuestPath(OPFS_GUEST_ROOT, '7z-lzma2-extract');
  const originalPath = joinGuestPath(dir, 'original.bin');
  const modifiedPath = joinGuestPath(dir, 'modified.bin');
  const ipsPath = joinGuestPath(OPFS_GUEST_ROOT, 'update.ips');
  const upsPath = joinGuestPath(OPFS_GUEST_ROOT, 'update.ups');
  const rupPath = joinGuestPath(OPFS_GUEST_ROOT, 'update.rup');
  const bpsPath = joinGuestPath(OPFS_GUEST_ROOT, 'update.bps');
  const appliedIpsPath = joinGuestPath(OPFS_GUEST_ROOT, 'applied-ips.bin');
  const appliedBpsPath = joinGuestPath(OPFS_GUEST_ROOT, 'applied-bps.bin');
  const appliedUpsPath = joinGuestPath(OPFS_GUEST_ROOT, 'applied-ups.bin');
  const appliedRupPath = joinGuestPath(OPFS_GUEST_ROOT, 'applied-rup.bin');
  const appliedXdeltaPath = joinGuestPath(OPFS_GUEST_ROOT, 'applied-xdelta.bin');

  const chdSource = new Uint8Array(64 * 1024);
  for (let index = 0; index < chdSource.length; index += 1) {
    chdSource[index] = index % 251;
  }
  await writeGuestFile(opfsHandle, chdSourcePath, chdSource);
  await writeGuestFile(opfsHandle, originalPath, toBytes('abcdefgh'));
  await writeGuestFile(opfsHandle, modifiedPath, toBytes('a1XYZf!!!'));

  assertRunJsonSucceeded(
    await runJson([
      'compress',
      chdSourcePath,
      '--format',
      'chd',
      '--output',
      chdPath,
      '--threads',
      '1',
    ]),
    { command: 'compress' },
  );
  assertRunJsonSucceeded(await runJson(['inspect', chdPath, '--list']), { command: 'inspect' });
  assertRunJsonSucceeded(
    await runJson([
      'extract',
      chdPath,
      '--out-dir',
      chdExtractDir,
      '--threads',
      '1',
    ]),
    { command: 'extract' },
  );

  assertRunJsonSucceeded(
    await runJson([
      'compress',
      sourcePath,
      '--format',
      'zip',
      '--output',
      zipPath,
      '--threads',
      '1',
    ]),
    { command: 'compress' },
  );
  assertRunJsonSucceeded(await runJson(['inspect', zipPath, '--list']), { command: 'inspect' });
  assertRunJsonSucceeded(
    await runJson([
      'extract',
      zipPath,
      '--out-dir',
      zipExtractDir,
      '--threads',
      '1',
    ]),
    { command: 'extract' },
  );

  for (const [format, patchPath] of [
    ['ips', ipsPath],
    ['ups', upsPath],
    ['rup', rupPath],
    ['bps', bpsPath],
  ]) {
    assertRunJsonSucceeded(
      await runJson([
        'patch-create',
        '--original',
        originalPath,
        '--modified',
        modifiedPath,
        '--format',
        format,
        '--output',
        patchPath,
        '--threads',
        '1',
      ]),
      { command: 'patch-create' },
    );
  }

  for (const [patchPath, outputPath] of [
    [ipsPath, appliedIpsPath],
    [upsPath, appliedUpsPath],
    [bpsPath, appliedBpsPath],
    [rupPath, appliedRupPath],
  ]) {
    assertRunJsonSucceeded(
      await runPatchApplyNoCompress(runJson, {
        inputPath: originalPath,
        patchPath,
        outputPath,
      }),
      { command: 'patch-apply' },
    );
  }

  assertRunJsonSucceeded(
    await runJson([
      'compress',
      sourcePath,
      '--format',
      '7z',
      '--output',
      sevenZPath,
      '--threads',
      '1',
    ]),
    { command: 'compress' },
  );
  assertRunJsonSucceeded(
    await runJson([
      'compress',
      sourcePath,
      '--format',
      '7z',
      '--output',
      sevenZLzmaPath,
      '--codec',
      'lzma',
      '--threads',
      '1',
    ]),
    { command: 'compress' },
  );
  assertRunJsonSucceeded(
    await runJson([
      'compress',
      sourcePath,
      '--format',
      '7z',
      '--output',
      sevenZLzma2Path,
      '--codec',
      'lzma2',
      '--threads',
      '1',
    ]),
    { command: 'compress' },
  );

  assertRunJsonSucceeded(
    await runJson([
      'extract',
      sevenZLzmaPath,
      '--out-dir',
      sevenZLzmaExtractDir,
      '--threads',
      '1',
    ]),
    { command: 'extract' },
  );
  assertRunJsonSucceeded(
    await runJson([
      'extract',
      sevenZLzma2Path,
      '--out-dir',
      sevenZLzma2ExtractDir,
      '--threads',
      '1',
    ]),
    { command: 'extract' },
  );

  assertRunJsonSucceeded(
    await runPatchApplyNoCompress(runJson, {
      inputPath: fixtures.vcdiffSourcePath,
      patchPath: fixtures.vcdiffPatchPath,
      outputPath: appliedXdeltaPath,
    }),
    { command: 'patch-apply' },
  );
}

export async function runFullFormatMatrix({ runJson, opfsHandle, dir, fixtures }) {
  const archiveSourcePath = joinGuestPath(dir, 'all-format-source.bin');
  const archiveSource = new Uint8Array(8192);
  for (let index = 0; index < archiveSource.length; index += 1) {
    archiveSource[index] = index % 251;
  }
  archiveSource[archiveSource.length - 1] = 0;
  await writeGuestFile(opfsHandle, archiveSourcePath, archiveSource);

  const containerRoundTripFormats = [
    'zip',
    'zipx',
    '7z',
    'tar',
    'tar.gz',
    'tar.bz2',
    'tar.xz',
    'gz',
    'bz2',
    'xz',
    'zst',
    'cso',
    'chd',
    'z3ds',
  ];
  for (const format of containerRoundTripFormats) {
    const archivePath = joinGuestPath(OPFS_GUEST_ROOT, `roundtrip-${formatToken(format)}.${containerSuffix(format)}`);
    assertRunJsonSucceeded(
      await runJson([
        'compress',
        archiveSourcePath,
        '--format',
        format,
        '--output',
        archivePath,
        '--threads',
        '1',
      ]),
      { command: 'compress' },
    );

    const extractDir = joinGuestPath(OPFS_GUEST_ROOT, `roundtrip-${formatToken(format)}-extract`);
    assertRunJsonSucceeded(
      await runJson([
        'extract',
        archivePath,
        '--out-dir',
        extractDir,
        '--threads',
        '1',
      ]),
      { command: 'extract' },
    );
  }

  const containerCompressFailureExpectations = new Map([
    ['rar', /rar create is not supported/i],
    ['pbp', /pbp create is not supported/i],
    ['gcz', /gcz compression is not supported/i],
    ['wbfs', /failed to open input/i],
    ['wia', /failed to open input/i],
    ['tgc', /failed to open input/i],
    ['nfs', /nfs compression is not supported/i],
    ['rvz', /failed to open input/i],
    ['xiso', /create is not supported|trim-only/i],
  ]);
  for (const [format, pattern] of containerCompressFailureExpectations.entries()) {
    const archivePath = joinGuestPath(OPFS_GUEST_ROOT, `compress-${formatToken(format)}.${containerSuffix(format)}`);
    const compressResult = await runJson([
      'compress',
      archiveSourcePath,
      '--format',
      format,
      '--output',
      archivePath,
      '--threads',
      '1',
    ]);
    assertFailedByPattern(compressResult, pattern, `compress ${format}`);
  }

  const containerExtractFailureExpectations = new Map([
    ['rar', /archive is invalid|unsupported archive signature/i],
    ['tar', /failed to read entire block|unrecognized archive format|archive is invalid/i],
    ['tar.gz', /invalid gzip header|unrecognized archive format|archive is invalid/i],
    ['tar.bz2', /bz2 header missing|unrecognized archive format|archive is invalid/i],
    ['tar.xz', /invalid xz magic bytes|unrecognized archive format|archive is invalid/i],
    ['pbp', /too small to be a pbp container/i],
    ['gcz', /failed to open gcz source/i],
    ['wbfs', /failed to open wbfs source/i],
    ['wia', /failed to open wia source/i],
    ['tgc', /failed to open tgc source/i],
    ['nfs', /failed to open nfs source/i],
    ['rvz', /failed to open rvz source/i],
    ['xiso', /xiso extract is not supported yet|not an Xbox XDVDFS image|not an XDVDFS volume/i],
  ]);
  for (const [format, pattern] of containerExtractFailureExpectations.entries()) {
    const sourcePath = joinGuestPath(dir, `extract-${formatToken(format)}.${containerSuffix(format)}`);
    await writeGuestFile(opfsHandle, sourcePath, toBytes('not-a-real-container'));
    const outDir = joinGuestPath(OPFS_GUEST_ROOT, `extract-${formatToken(format)}-out`);
    const extractResult = await runJson([
      'extract',
      sourcePath,
      '--out-dir',
      outDir,
      '--threads',
      '1',
    ]);
    assertFailedByPattern(extractResult, pattern, `extract ${format}`);
  }

  const originalPath = joinGuestPath(dir, 'all-format-original.bin');
  const modifiedPath = joinGuestPath(dir, 'all-format-modified.bin');
  const original = new Uint8Array(4096);
  for (let index = 0; index < original.length; index += 1) {
    original[index] = index % 251;
  }
  const modified = new Uint8Array(original);
  for (let index = 0; index < 300; index += 1) {
    modified[100 + index] = (modified[100 + index] + 17) % 256;
  }
  await writeGuestFile(opfsHandle, originalPath, original);
  await writeGuestFile(opfsHandle, modifiedPath, modified);

  const patchFormats = [
    'ips',
    'ips32',
    'solid',
    'bps',
    'ups',
    'vcdiff',
    'xdelta',
    'gdiff',
    'hdiffpatch',
    'aps',
    'apsgba',
    'ninja1',
    'rup',
    'ppf',
    'pat',
    'ebp',
    'bdf',
    'bsp',
    'mod',
    'dldi',
    'dps',
  ];

  const applyFailureExpectations = new Map([
    ['apsgba', /i\/o error: unsupported|source rom checksum mismatch|validation failed/i],
    ['ppf', /i\/o error: unsupported|source rom checksum mismatch|validation failed/i],
    ['pat', /i\/o error: unsupported|source rom checksum mismatch|validation failed/i],
    ['mod', /i\/o error: unsupported|source rom checksum mismatch|validation failed/i],
    ['dps', /i\/o error: unsupported|source rom checksum mismatch|validation failed/i],
  ]);
  const createUnsupportedExpectations = new Map([
    ['hdiffpatch', /creation is disabled/i],
    ['ninja1', /not currently supported/i],
    ['bsp', /creation is not implemented/i],
  ]);
  const createFailureExpectations = new Map([
    ['aps', /i\/o error: unsupported|validation failed/i],
    ['bdf', /i\/o error: unsupported|validation failed/i],
    ['dldi', /i\/o error: unsupported|validation failed/i],
  ]);

  for (const format of patchFormats) {
    const extension = patchExtension(format);
    expect(typeof extension).toBe('string');
    const patchPath = joinGuestPath(OPFS_GUEST_ROOT, `patch-${format}.${extension}`);
    const createResult = await runJson([
      'patch-create',
      '--original',
      originalPath,
      '--modified',
      modifiedPath,
      '--format',
      format,
      '--output',
      patchPath,
      '--threads',
      '1',
    ]);

    if (createResult.ok) {
      const { applyResult } = await runCreatedPatchApply(runJson, {
        format,
        createResult,
        originalPath,
        patchPath,
      });
      if (applyResult.ok) {
        assertRunJsonSucceeded(applyResult, { command: 'patch-apply' });
        continue;
      }

      if (applyFailureExpectations.has(format)) {
        assertFailedByPattern(
          applyResult,
          applyFailureExpectations.get(format),
          `patch-apply ${format}`,
        );
        continue;
      }

      throw new Error(
        `patch-apply ${format} unexpectedly failed: ${String(getTerminalEvent(applyResult).label || applyResult.stderr || '')}`,
      );
    }

    if (createUnsupportedExpectations.has(format)) {
      assertFailedByPattern(
        createResult,
        createUnsupportedExpectations.get(format),
        `patch-create ${format}`,
      );
      expect(getTerminalEvent(createResult).status).toBe('unsupported');
      continue;
    }

    const createFailurePattern = createFailureExpectations.get(format) ?? applyFailureExpectations.get(format);
    if (createFailurePattern) {
      assertFailedByPattern(createResult, createFailurePattern, `patch-create ${format}`);
      continue;
    }

    throw new Error(
      `patch-create ${format} unexpectedly failed: ${String(getTerminalEvent(createResult).label || createResult.stderr || '')}`,
    );
  }

  const xdeltaApplyPath = joinGuestPath(OPFS_GUEST_ROOT, 'fixture-applied-xdelta.bin');
  assertRunJsonSucceeded(
    await runPatchApplyNoCompress(runJson, {
      inputPath: fixtures.vcdiffSourcePath,
      patchPath: fixtures.vcdiffPatchPath,
      outputPath: xdeltaApplyPath,
    }),
    { command: 'patch-apply' },
  );

  const vcdiffPatchPath = joinGuestPath(OPFS_GUEST_ROOT, 'fixture-secondary.vcdiff');
  await runJson([
    'patch-create',
    '--original',
    fixtures.vcdiffSourcePath,
    '--modified',
    fixtures.vcdiffTargetPath,
    '--format',
    'gdiff',
    '--output',
    vcdiffPatchPath,
    '--threads',
    '1',
  ]);
  const vcdiffApplyPath = joinGuestPath(OPFS_GUEST_ROOT, 'fixture-applied-vcdiff.bin');
  assertRunJsonSucceeded(
    await runPatchApplyNoCompress(runJson, {
      inputPath: fixtures.vcdiffSourcePath,
      patchPath: fixtures.vcdiffPatchPath,
      outputPath: vcdiffApplyPath,
    }),
    { command: 'patch-apply' },
  );
}

async function runPatchApplyNoCompress(runJson, { inputPath, patchPath, outputPath }) {
  return runJson([
    'patch-apply',
    '--input',
    inputPath,
    '--patch',
    patchPath,
    '--output',
    outputPath,
    '--threads',
    '1',
    '--no-compress',
  ]);
}

async function runCreatedPatchApply(runJson, { format, createResult, originalPath, patchPath }) {
  expect(createResult.ok, `patch-create ${format} should succeed`).toBe(true);
  expect(getTerminalEvent(createResult).status).toBe('succeeded');
  const applyPath = joinGuestPath(OPFS_GUEST_ROOT, `patch-applied-${format}.bin`);
  const applyResult = await runPatchApplyNoCompress(runJson, {
    inputPath: originalPath,
    patchPath,
    outputPath: applyPath,
  });
  return { applyPath, applyResult };
}

function assertFailedByPattern(result, pattern, context) {
  expect(result.ok, `${context} should fail in the current wasm matrix`).toBe(false);
  expect(result.exitCode, `${context} should not exit with code 0`).not.toBe(0);
  const terminal = getTerminalEvent(result);
  const label = String(terminal.label || '');
  const stderr = String(result.stderr || '');
  const matches = pattern.test(label) || pattern.test(stderr);
  expect(matches, `${context} should match ${pattern}; label=${JSON.stringify(label)} stderr=${JSON.stringify(stderr)}`).toBe(true);
}

function formatToken(value) {
  return value.replace(/[^a-z0-9]+/gi, '-');
}

function containerSuffix(format) {
  switch (format) {
    case 'tar.gz':
      return 'tar.gz';
    case 'tar.bz2':
      return 'tar.bz2';
    case 'tar.xz':
      return 'tar.xz';
    default:
      return format;
  }
}

function patchExtension(format) {
  const map = {
    ips: 'ips',
    ips32: 'ips32',
    solid: 'solid',
    bps: 'bps',
    ups: 'ups',
    vcdiff: 'vcdiff',
    xdelta: 'xdelta',
    gdiff: 'gdiff',
    hdiffpatch: 'hpatchz',
    aps: 'aps',
    apsgba: 'apsgba',
    ninja1: 'n1',
    rup: 'rup',
    ppf: 'ppf',
    pat: 'pat',
    ebp: 'ebp',
    bdf: 'bsdiff',
    bsp: 'bsp',
    mod: 'mod',
    dldi: 'dldi',
    dps: 'dps',
  };
  return map[format];
}

async function loadVcdiffFixtures() {
  if (fixtureBytesPromise === null) {
    fixtureBytesPromise = Promise.all([
      fetchBytes(VCDIFF_SOURCE_FIXTURE_URL),
      fetchBytes(VCDIFF_PATCH_FIXTURE_URL),
      fetchBytes(VCDIFF_TARGET_FIXTURE_URL),
    ]).then(([source, patch, target]) => ({ source, patch, target }));
  }

  return fixtureBytesPromise;
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch fixture ${url}: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function toBytes(value) {
  if (typeof value === 'string') {
    return TEXT_ENCODER.encode(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new TypeError('expected string, Uint8Array, or ArrayBuffer');
}

export function joinGuestPath(...parts) {
  const tokens = [];
  for (const part of parts) {
    const value = String(part);
    for (const token of value.split('/')) {
      if (token.length === 0) {
        continue;
      }
      tokens.push(token);
    }
  }
  return `/${tokens.join('/')}`;
}

function pathBasename(path) {
  const normalized = String(path).replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index < 0) {
    return normalized;
  }
  return normalized.slice(index + 1);
}

function pathDirname(path) {
  const normalized = String(path).replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) {
    return '/';
  }
  return normalized.slice(0, index);
}

function toGuestRelativePath(guestPath) {
  const normalized = String(guestPath);
  if (normalized === OPFS_GUEST_ROOT) {
    return '';
  }

  const prefix = `${OPFS_GUEST_ROOT}/`;
  if (!normalized.startsWith(prefix)) {
    throw new Error(`guest path must start with ${prefix}: ${guestPath}`);
  }

  return normalized.slice(prefix.length);
}

function splitRelativePath(relativePath) {
  if (relativePath.length === 0) {
    return [];
  }
  return relativePath.split('/').filter((token) => token.length > 0);
}

async function getOrCreateDirectoryHandle(rootHandle, relativeDirectoryPath) {
  const segments = splitRelativePath(relativeDirectoryPath);
  let current = rootHandle;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

async function getGuestFileHandle(rootHandle, guestPath, { create = false } = {}) {
  const relativePath = toGuestRelativePath(guestPath);
  const fileName = pathBasename(relativePath);
  const parentPath = pathDirname(relativePath);
  const parentHandle = await getOrCreateDirectoryHandle(rootHandle, parentPath === '/' ? '' : parentPath);
  return parentHandle.getFileHandle(fileName, { create });
}

export async function ensureGuestFile(rootHandle, guestPath) {
  await getGuestFileHandle(rootHandle, guestPath, { create: true });
}

export async function writeGuestFile(rootHandle, guestPath, contents) {
  const fileHandle = await getGuestFileHandle(rootHandle, guestPath, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(contents);
  await writable.close();
}

export async function writeGuestPatternFile(rootHandle, guestPath, byteLength, options = {}) {
  const {
    chunkSizeBytes = 1024 * 1024,
    phaseShift = 0,
    mutateFromOffset = null,
    mutateAdd = 0,
  } = options;

  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new TypeError('byteLength must be a non-negative integer');
  }
  if (!Number.isInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new TypeError('chunkSizeBytes must be a positive integer');
  }
  if (!Number.isInteger(phaseShift)) {
    throw new TypeError('phaseShift must be an integer');
  }
  if (!(mutateFromOffset === null || (Number.isInteger(mutateFromOffset) && mutateFromOffset >= 0))) {
    throw new TypeError('mutateFromOffset must be null or a non-negative integer');
  }
  if (!Number.isInteger(mutateAdd)) {
    throw new TypeError('mutateAdd must be an integer');
  }

  const fileHandle = await getGuestFileHandle(rootHandle, guestPath, { create: true });
  const writable = await fileHandle.createWritable();
  let writeError = null;

  try {
    const chunk = new Uint8Array(Math.max(1, Math.min(chunkSizeBytes, byteLength)));
    let offset = 0;

    while (offset < byteLength) {
      const size = Math.min(chunk.length, byteLength - offset);
      for (let index = 0; index < size; index += 1) {
        const absoluteOffset = offset + index;
        let value = (absoluteOffset + phaseShift) % 251;
        if (mutateFromOffset !== null && absoluteOffset >= mutateFromOffset) {
          value = (value + mutateAdd) % 251;
        }
        chunk[index] = value;
      }
      await writable.write(chunk.subarray(0, size));
      offset += size;
    }
  } catch (error) {
    writeError = error;
    try {
      await writable.abort();
    } catch {
      // ignore abort failures; original error is more relevant
    }
    throw error;
  } finally {
    if (writeError === null) {
      await writable.close();
    }
  }
}

export async function getGuestFileSize(rootHandle, guestPath) {
  const fileHandle = await getGuestFileHandle(rootHandle, guestPath);
  const file = await fileHandle.getFile();
  return file.size;
}

async function removeFixtureDirectory(rootHandle, directoryName) {
  try {
    await rootHandle.removeEntry(directoryName, { recursive: true });
  } catch {
    // ignore best-effort cleanup failures
  }
}
