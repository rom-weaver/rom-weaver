import { createBrowserWorkerClient } from './workers/browser-worker-client.mjs';

export const OPFS_GUEST_ROOT = '/work';

const TEXT_ENCODER = new TextEncoder();
const DEFAULT_VCDIFF_FIXTURE_URLS = {
  patch: new URL('../../../tests/fixtures/vcdiff/secondary-djw.xdelta', import.meta.url),
  source: new URL('../../../tests/fixtures/vcdiff/secondary-source.bin', import.meta.url),
  target: new URL('../../../tests/fixtures/vcdiff/secondary-target.bin', import.meta.url),
};
const DEFAULT_HDIFF_FIXTURE_URLS = {
  patch: new URL('../../../crates/rom-weaver-patches/tests/fixtures/hdiffpatch/upstream-hdiff13-zstd.hdiff', import.meta.url),
  source: new URL('../../../crates/rom-weaver-patches/tests/fixtures/hdiffpatch/source.bin', import.meta.url),
  target: new URL('../../../crates/rom-weaver-patches/tests/fixtures/hdiffpatch/target.bin', import.meta.url),
};

export async function runBrowserFullFormatMatrix(options = {}) {
  const root = await navigator.storage.getDirectory();
  const fixtureName = `${options.prefix || 'rom-weaver-browser-format-matrix-'}${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  await root.getDirectoryHandle(fixtureName, { create: true });
  const fixtureGuestRoot = joinGuestPath(OPFS_GUEST_ROOT, fixtureName);
  const worker = createBrowserWorkerClient(options.clientOptions || {});

  try {
    const init = await worker.init({
      wasmUrl: options.wasmUrl || new URL('../rom-weaver-app.wasm', import.meta.url).href,
      workGuestPath: OPFS_GUEST_ROOT,
      runtimeMounts: [OPFS_GUEST_ROOT],
      ...(options.initOptions || {}),
    });
    assert(init?.mode === 'browser-opfs', `expected browser-opfs init mode, got ${String(init?.mode)}`);

    const sourcePath = joinGuestPath(fixtureGuestRoot, options.sourceFileName || 'input.bin');
    await writeGuestFile(root, sourcePath, toBytes(options.sourceContents || 'rom-weaver format matrix fixture'));

    const fixtureBytes = await loadMatrixFixtureBytes(options);
    const fixtures = {
      hdiffPatchPath: joinGuestPath(fixtureGuestRoot, 'fixtures', 'upstream-hdiff13-zstd.hdiff'),
      hdiffSourcePath: joinGuestPath(fixtureGuestRoot, 'fixtures', 'hdiff-source.bin'),
      hdiffTargetPath: joinGuestPath(fixtureGuestRoot, 'fixtures', 'hdiff-target.bin'),
      vcdiffPatchPath: joinGuestPath(fixtureGuestRoot, 'fixtures', 'secondary-djw.xdelta'),
      vcdiffSourcePath: joinGuestPath(fixtureGuestRoot, 'fixtures', 'secondary-source.bin'),
      vcdiffTargetPath: joinGuestPath(fixtureGuestRoot, 'fixtures', 'secondary-target.bin'),
    };
    await writeGuestFile(root, fixtures.vcdiffSourcePath, fixtureBytes.vcdiff.source);
    await writeGuestFile(root, fixtures.vcdiffPatchPath, fixtureBytes.vcdiff.patch);
    await writeGuestFile(root, fixtures.vcdiffTargetPath, fixtureBytes.vcdiff.target);
    await writeGuestFile(root, fixtures.hdiffSourcePath, fixtureBytes.hdiff.source);
    await writeGuestFile(root, fixtures.hdiffPatchPath, fixtureBytes.hdiff.patch);
    await writeGuestFile(root, fixtures.hdiffTargetPath, fixtureBytes.hdiff.target);

    return await runBrowserFullFormatMatrixCore({
      dir: fixtureGuestRoot,
      fixtures,
      onEvent: options.onEvent,
      onStep: options.onStep,
      opfsHandle: root,
      runJson: (command, runOptions) => worker.runJson(command, runOptions),
      sourcePath,
    });
  } finally {
    try {
      worker.terminate();
    } catch (_error) {
      // Best-effort cleanup; the original matrix error is more relevant.
    }
    await removeFixtureDirectory(root, fixtureName);
  }
}

export async function runBrowserFullFormatMatrixCore({ runJson, opfsHandle, dir, fixtures, sourcePath, onStep, onEvent }) {
  const state = createMatrixState({ onEvent, onStep });
  const runCommand = (name, command, options = {}) =>
    runMatrixCommand(state, runJson, name, command, options);

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
    const archivePath = joinGuestPath(dir, `roundtrip-${formatToken(format)}.${containerSuffix(format)}`);
    assertRunJsonSucceeded(
      await runCommand(`compress ${format}`, command('compress', {
        format,
        input: [archiveSourcePath],
        output: archivePath,
        threads: 1,
      })),
      { command: 'compress' },
    );

    const extractDir = joinGuestPath(dir, `roundtrip-${formatToken(format)}-extract`);
    assertRunJsonSucceeded(
      await runCommand(`extract ${format}`, command('extract', {
        out_dir: extractDir,
        source: archivePath,
        threads: 1,
      })),
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
    const archivePath = joinGuestPath(dir, `compress-${formatToken(format)}.${containerSuffix(format)}`);
    const compressResult = await runCommand(`compress unsupported ${format}`, command('compress', {
      format,
      input: [archiveSourcePath],
      output: archivePath,
      threads: 1,
    }));
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
    const badSourcePath = joinGuestPath(dir, `extract-${formatToken(format)}.${containerSuffix(format)}`);
    await writeGuestFile(opfsHandle, badSourcePath, toBytes('not-a-real-container'));
    const outDir = joinGuestPath(dir, `extract-${formatToken(format)}-out`);
    const extractResult = await runCommand(`extract invalid ${format}`, command('extract', {
      out_dir: outDir,
      source: badSourcePath,
      threads: 1,
    }));
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
    assert(typeof extension === 'string', `missing patch extension for ${format}`);
    const patchPath = joinGuestPath(dir, `patch-${format}.${extension}`);
    const createResult = await runCommand(`patch-create ${format}`, command('patch-create', {
      format,
      modified: modifiedPath,
      original: originalPath,
      output: patchPath,
      threads: 1,
    }));

    if (createResult.ok) {
      const { applyResult } = await runCreatedPatchApply(runCommand, {
        createResult,
        format,
        originalPath,
        patchPath,
      });
      if (applyResult.ok) {
        assertRunJsonSucceeded(applyResult, { command: 'patch-apply' });
        continue;
      }

      if (applyFailureExpectations.has(format)) {
        assertFailedByPattern(applyResult, applyFailureExpectations.get(format), `patch-apply ${format}`);
        continue;
      }

      throw new Error(
        `patch-apply ${format} unexpectedly failed: ${String(
          getTerminalEvent(applyResult).label || applyResult.stderr || '',
        )}`,
      );
    }

    if (createUnsupportedExpectations.has(format)) {
      assertFailedByPattern(createResult, createUnsupportedExpectations.get(format), `patch-create ${format}`);
      assert(getTerminalEvent(createResult).status === 'unsupported', `patch-create ${format} should be unsupported`);
      continue;
    }

    const createFailurePattern = createFailureExpectations.get(format) ?? applyFailureExpectations.get(format);
    if (createFailurePattern) {
      assertFailedByPattern(createResult, createFailurePattern, `patch-create ${format}`);
      continue;
    }

    throw new Error(
      `patch-create ${format} unexpectedly failed: ${String(
        getTerminalEvent(createResult).label || createResult.stderr || '',
      )}`,
    );
  }

  await runHdiffApplyFixture({ dir, fixtures, opfsHandle, runCommand });
  await runBspApplyFixture({ dir, opfsHandle, runCommand });

  const xdeltaApplyPath = joinGuestPath(dir, 'fixture-applied-xdelta.bin');
  const xdeltaApplyEvents = [];
  const xdeltaApplyResult = await runPatchApplyNoCompress(
    runCommand,
    {
      inputPath: fixtures.vcdiffSourcePath,
      outputPath: xdeltaApplyPath,
      patchPath: fixtures.vcdiffPatchPath,
    },
    {
      onEvent(event) {
        xdeltaApplyEvents.push(event);
      },
    },
  );
  assertRunJsonSucceeded(xdeltaApplyResult, { command: 'patch-apply' });
  assert(
    xdeltaApplyEvents.some((event) => {
      const format = String(event?.format || '').toLowerCase();
      const percent = typeof event?.percent === 'number' ? event.percent : null;
      return (
        event.command === 'patch-apply' &&
        event.status === 'running' &&
        event.stage === 'apply' &&
        format === 'xdelta' &&
        percent !== null &&
        percent > 0 &&
        percent < 100
      );
    }),
    'xdelta patch-apply should emit a running apply progress event with a partial percent',
  );

  const vcdiffPatchPath = joinGuestPath(dir, 'fixture-secondary.vcdiff');
  await runCommand(`patch-create gdiff fixture`, command('patch-create', {
    format: 'gdiff',
    modified: fixtures.vcdiffTargetPath,
    original: fixtures.vcdiffSourcePath,
    output: vcdiffPatchPath,
    threads: 1,
  }));
  const vcdiffApplyPath = joinGuestPath(dir, 'fixture-applied-vcdiff.bin');
  assertRunJsonSucceeded(
    await runPatchApplyNoCompress(runCommand, {
      inputPath: fixtures.vcdiffSourcePath,
      outputPath: vcdiffApplyPath,
      patchPath: fixtures.vcdiffPatchPath,
    }),
    { command: 'patch-apply' },
  );

  return state.summary();
}

async function runHdiffApplyFixture({ dir, fixtures, opfsHandle, runCommand }) {
  if (!fixtures?.hdiffSourcePath || !fixtures?.hdiffPatchPath || !fixtures?.hdiffTargetPath) {
    throw new Error('hdiffpatch fixture paths are required for the full format matrix');
  }

  const outputPath = joinGuestPath(dir, 'fixture-applied-hdiffpatch.bin');
  assertRunJsonSucceeded(
    await runPatchApplyNoCompress(runCommand, {
      inputPath: fixtures.hdiffSourcePath,
      outputPath,
      patchPath: fixtures.hdiffPatchPath,
    }),
    { command: 'patch-apply' },
  );
  assertBytesEqual(
    await readGuestFile(opfsHandle, outputPath),
    await readGuestFile(opfsHandle, fixtures.hdiffTargetPath),
    'hdiffpatch apply output should match fixture target',
  );
}

async function runBspApplyFixture({ dir, opfsHandle, runCommand }) {
  const inputPath = joinGuestPath(dir, 'fixture-bsp-input.bin');
  const patchPath = joinGuestPath(dir, 'fixture-bsp-update.bsp');
  const outputPath = joinGuestPath(dir, 'fixture-applied-bsp.bin');
  await writeGuestFile(opfsHandle, inputPath, new Uint8Array([0x01, 0x02, 0x03]));
  await writeGuestFile(opfsHandle, patchPath, new Uint8Array([0x18, 0xff, 0x06, 0x00, 0x00, 0x00, 0x00]));

  assertRunJsonSucceeded(
    await runPatchApplyNoCompress(runCommand, {
      inputPath,
      outputPath,
      patchPath,
    }),
    { command: 'patch-apply' },
  );
  assertBytesEqual(
    await readGuestFile(opfsHandle, outputPath),
    new Uint8Array([0xff, 0x02, 0x03]),
    'BSP apply output should match fixture target',
  );
}

async function runPatchApplyNoCompress(runCommand, { inputPath, patchPath, outputPath }, runOptions = undefined) {
  return runCommand(`patch-apply ${pathBasename(patchPath)}`, command('patch-apply', {
    input: inputPath,
    no_compress: true,
    output: outputPath,
    patches: [patchPath],
    threads: 1,
  }), runOptions);
}

async function runCreatedPatchApply(runCommand, { format, createResult, originalPath, patchPath }) {
  assert(createResult.ok, `patch-create ${format} should succeed`);
  assert(getTerminalEvent(createResult).status === 'succeeded', `patch-create ${format} should finish succeeded`);
  const applyPath = joinGuestPath(pathDirname(patchPath), `patch-applied-${format}.bin`);
  const applyResult = await runPatchApplyNoCompress(runCommand, {
    inputPath: originalPath,
    outputPath: applyPath,
    patchPath,
  });
  return { applyPath, applyResult };
}

function command(type, args) {
  return { args, type };
}

function createMatrixState({ onEvent, onStep } = {}) {
  const steps = [];
  const startedAt = now();
  return {
    addStep(step) {
      steps.push(step);
      onStep?.(step);
    },
    emitEvent(event) {
      onEvent?.(event);
    },
    summary() {
      return {
        durationMs: Math.round(now() - startedAt),
        failedSteps: steps.filter((step) => step.status === 'failed').length,
        passedSteps: steps.filter((step) => step.status === 'succeeded').length,
        steps,
      };
    },
  };
}

async function runMatrixCommand(state, runJson, name, typedCommand, options = {}) {
  const startedAt = now();
  state.addStep({
    command: typedCommand.type,
    name,
    status: 'running',
    timestamp: new Date().toISOString(),
  });
  try {
    const result = await runJson(typedCommand, {
      ...options,
      onEvent(event) {
        state.emitEvent(event);
        options.onEvent?.(event);
      },
    });
    state.addStep({
      command: typedCommand.type,
      durationMs: Math.round(now() - startedAt),
      name,
      status: 'succeeded',
      terminalStatus: getTerminalEvent(result).status,
      timestamp: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    state.addStep({
      command: typedCommand.type,
      durationMs: Math.round(now() - startedAt),
      error: errorMessage(error),
      name,
      status: 'failed',
      timestamp: new Date().toISOString(),
    });
    throw error;
  }
}

function getTerminalEvent(result) {
  assert(Array.isArray(result?.events), 'runJson result should include events');
  assert(result.events.length > 0, 'runJson result should include at least one event');
  return result.events.at(-1);
}

function assertRunJsonSucceeded(result, options = {}) {
  const terminal = getTerminalEvent(result);
  const commandName = options.command ?? 'command';
  const failureMessage = [
    `expected ${commandName} to succeed`,
    `exitCode=${result.exitCode}`,
    `ok=${result.ok}`,
    `label=${JSON.stringify(terminal?.label ?? '')}`,
    `details=${JSON.stringify(terminal?.details ?? null)}`,
    `stderr=${JSON.stringify(result.stderr ?? '')}`,
    `error=${JSON.stringify(errorMessage(result.error))}`,
    `stack=${JSON.stringify(errorStack(result.error))}`,
  ].join(' ');
  assert(result.exitCode === 0, failureMessage);
  assert(result.ok === true, failureMessage);
  assert(terminal.status === 'succeeded', failureMessage);
  if (typeof options.command === 'string') {
    assert(terminal.command === options.command, `expected terminal command ${options.command}, got ${terminal.command}`);
  }
  return terminal;
}

function assertFailedByPattern(result, pattern, context) {
  assert(result.ok === false, `${context} should fail in the current wasm matrix`);
  assert(result.exitCode !== 0, `${context} should not exit with code 0`);
  const terminal = getTerminalEvent(result);
  const label = String(terminal.label || '');
  const stderr = String(result.stderr || '');
  const matches = pattern.test(label) || pattern.test(stderr);
  assert(matches, `${context} should match ${pattern}; label=${JSON.stringify(label)} stderr=${JSON.stringify(stderr)}`);
}

function assertBytesEqual(actual, expected, message) {
  assert(actual.byteLength === expected.byteLength, `${message}; length ${actual.byteLength} !== ${expected.byteLength}`);
  for (let index = 0; index < actual.byteLength; index += 1) {
    assert(actual[index] === expected[index], `${message}; byte ${index} ${actual[index]} !== ${expected[index]}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function errorMessage(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorStack(error) {
  if (error && typeof error === 'object' && typeof error.stack === 'string') return error.stack;
  return '';
}

function now() {
  return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

async function loadMatrixFixtureBytes(options) {
  const vcdiffUrls = normalizeFixtureUrls(options.vcdiffFixtureUrls, DEFAULT_VCDIFF_FIXTURE_URLS);
  const hdiffUrls = normalizeFixtureUrls(options.hdiffFixtureUrls, DEFAULT_HDIFF_FIXTURE_URLS);
  const [vcdiffSource, vcdiffPatch, vcdiffTarget, hdiffSource, hdiffPatch, hdiffTarget] = await Promise.all([
    loadFixtureBytes(options.vcdiffFixtures?.source, vcdiffUrls.source),
    loadFixtureBytes(options.vcdiffFixtures?.patch, vcdiffUrls.patch),
    loadFixtureBytes(options.vcdiffFixtures?.target, vcdiffUrls.target),
    loadFixtureBytes(options.hdiffFixtures?.source, hdiffUrls.source),
    loadFixtureBytes(options.hdiffFixtures?.patch, hdiffUrls.patch),
    loadFixtureBytes(options.hdiffFixtures?.target, hdiffUrls.target),
  ]);
  return {
    hdiff: {
      patch: hdiffPatch,
      source: hdiffSource,
      target: hdiffTarget,
    },
    vcdiff: {
      patch: vcdiffPatch,
      source: vcdiffSource,
      target: vcdiffTarget,
    },
  };
}

function normalizeFixtureUrls(value, defaults) {
  return {
    patch: value?.patch || defaults.patch,
    source: value?.source || defaults.source,
    target: value?.target || defaults.target,
  };
}

async function loadFixtureBytes(value, fallbackUrl) {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || typeof value === 'string') {
    return toBytes(value);
  }
  return fetchBytes(fallbackUrl);
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch fixture ${url}: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function toBytes(value) {
  if (typeof value === 'string') return TEXT_ENCODER.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('expected string, Uint8Array, or ArrayBuffer');
}

export function joinGuestPath(...parts) {
  const tokens = [];
  for (const part of parts) {
    const value = String(part);
    for (const token of value.split('/')) {
      if (token.length > 0) tokens.push(token);
    }
  }
  return `/${tokens.join('/')}`;
}

async function readGuestFile(rootHandle, guestPath) {
  const fileHandle = await getGuestFileHandle(rootHandle, guestPath);
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function writeGuestFile(rootHandle, guestPath, contents) {
  const fileHandle = await getGuestFileHandle(rootHandle, guestPath, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(contents);
  await writable.close();
}

function pathBasename(path) {
  const normalized = String(path).replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return normalized;
  return normalized.slice(index + 1);
}

function pathDirname(path) {
  const normalized = String(path).replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return '/';
  return normalized.slice(0, index);
}

function toGuestRelativePath(guestPath) {
  const normalized = String(guestPath);
  if (normalized === OPFS_GUEST_ROOT) return '';

  const prefix = `${OPFS_GUEST_ROOT}/`;
  if (!normalized.startsWith(prefix)) {
    throw new Error(`guest path must start with ${prefix}: ${guestPath}`);
  }

  return normalized.slice(prefix.length);
}

function splitRelativePath(relativePath) {
  if (relativePath.length === 0) return [];
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

async function removeFixtureDirectory(rootHandle, directoryName) {
  try {
    await rootHandle.removeEntry(directoryName, { recursive: true });
  } catch (_error) {
    // Best-effort cleanup for browsers that hold transient OPFS locks after worker termination.
  }
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
    aps: 'aps',
    apsgba: 'apsgba',
    bdf: 'bsdiff',
    bps: 'bps',
    bsp: 'bsp',
    dldi: 'dldi',
    dps: 'dps',
    ebp: 'ebp',
    gdiff: 'gdiff',
    hdiffpatch: 'hpatchz',
    ips: 'ips',
    ips32: 'ips32',
    mod: 'mod',
    ninja1: 'n1',
    pat: 'pat',
    ppf: 'ppf',
    rup: 'rup',
    solid: 'solid',
    ups: 'ups',
    vcdiff: 'vcdiff',
    xdelta: 'xdelta',
  };
  return map[format];
}

export function summarizeBrowserFormatMatrixResult(result) {
  return [
    `passed=${result?.passedSteps ?? 0}`,
    `failed=${result?.failedSteps ?? 0}`,
    `durationMs=${result?.durationMs ?? 0}`,
  ].join(' ');
}
