import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VCDIFF_SOURCE_FIXTURE_PATH = fileURLToPath(
  new URL('../../../tests/fixtures/vcdiff/secondary-source.bin', import.meta.url),
);
export const VCDIFF_PATCH_FIXTURE_PATH = fileURLToPath(
  new URL('../../../tests/fixtures/vcdiff/secondary-djw.xdelta', import.meta.url),
);
export const VCDIFF_TARGET_FIXTURE_PATH = fileURLToPath(
  new URL('../../../tests/fixtures/vcdiff/secondary-target.bin', import.meta.url),
);

export async function withTempFixture(run, options = {}) {
  const {
    prefix = 'rom-weaver-wasm-test-',
    sourceFileName = 'input.bin',
    sourceContents = 'rom-weaver wasm test fixture',
  } = options;

  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    const sourcePath = join(dir, sourceFileName);
    await writeFile(sourcePath, Buffer.from(sourceContents, 'utf8'));
    await run({ dir, sourcePath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function getTerminalEvent(result) {
  assert.ok(Array.isArray(result.events), 'runJson result must include events');
  assert.ok(result.events.length > 0, 'runJson result should include at least one progress event');
  return result.events.at(-1);
}

export function assertFailedWithLabel(result, labelPattern, context) {
  assert.equal(result.ok, false, `${context} should fail in the current wasm matrix`);
  assert.notEqual(result.exitCode, 0, `${context} should not exit with code 0`);
  const terminal = getTerminalEvent(result);
  assert.equal(terminal.status, 'failed');
  assert.match(String(terminal.label || ''), labelPattern);
}

export async function runProgressMatrix({ runJson, dir, sourcePath, appliedOutputName }) {
  const archivePath = join(dir, 'archive.gz');
  const extractDir = join(dir, 'extract');
  const originalPath = join(dir, 'original.bin');
  const modifiedPath = join(dir, 'modified.bin');
  const patchPath = join(dir, 'update.ips');
  const appliedPath = join(dir, appliedOutputName ?? 'applied-output');

  await writeFile(originalPath, Buffer.from('abcdefgh', 'utf8'));
  await writeFile(modifiedPath, Buffer.from('a1XYZf!!!', 'utf8'));

  const compressEvents = [];
  const compressResult = await runJson(
    ['compress', sourcePath, '--format', 'gz', '--output', archivePath, '--threads', '1'],
    {
      onEvent(event) {
        compressEvents.push(event);
      },
    },
  );
  assert.equal(compressResult.exitCode, 0);
  assert.equal(compressResult.ok, true);
  assert.ok(
    compressEvents.some(
      (event) => event.command === 'compress' && event.status === 'running' && event.format === 'gz',
    ),
  );

  const extractEvents = [];
  const extractResult = await runJson(
    ['extract', archivePath, '--out-dir', extractDir, '--threads', '1'],
    {
      onEvent(event) {
        extractEvents.push(event);
      },
    },
  );
  assert.equal(extractResult.exitCode, 0);
  assert.equal(extractResult.ok, true);
  assert.ok(
    extractEvents.some(
      (event) => event.command === 'extract' && event.status === 'running' && event.format === 'gz',
    ),
  );

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
  assert.equal(patchCreateResult.exitCode, 0);
  assert.equal(patchCreateResult.ok, true);

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
  assert.equal(patchApplyResult.exitCode, 0);
  assert.equal(patchApplyResult.ok, true);
  assert.ok(
    patchApplyEvents.some(
      (event) => event.command === 'patch-apply' && event.status === 'running' && event.format === 'IPS',
    ),
  );
  assert.ok(
    patchApplyEvents.some(
      (event) => event.command === 'patch-apply'
        && event.status === 'running'
        && event.stage === 'compress'
        && typeof event.format === 'string'
        && event.format.length > 0,
    ),
  );
}

export async function runPatchMatrix({ runJson, dir, sourcePath }) {
  const chdSourcePath = join(dir, 'chd-source.bin');
  const chdPath = join(dir, 'archive.chd');
  const chdExtractDir = join(dir, 'chd-extract');
  const zipPath = join(dir, 'archive.zip');
  const zipExtractDir = join(dir, 'zip-extract');
  const sevenZPath = join(dir, 'archive.7z');
  const sevenZLzmaPath = join(dir, 'archive-lzma.7z');
  const sevenZLzma2Path = join(dir, 'archive-lzma2.7z');
  const sevenZLzmaExtractDir = join(dir, '7z-lzma-extract');
  const sevenZLzma2ExtractDir = join(dir, '7z-lzma2-extract');
  const originalPath = join(dir, 'original.bin');
  const modifiedPath = join(dir, 'modified.bin');
  const ipsPath = join(dir, 'update.ips');
  const upsPath = join(dir, 'update.ups');
  const rupPath = join(dir, 'update.rup');
  const bpsPath = join(dir, 'update.bps');
  const appliedIpsPath = join(dir, 'applied-ips.bin');
  const appliedBpsPath = join(dir, 'applied-bps.bin');
  const appliedUpsPath = join(dir, 'applied-ups.bin');
  const appliedRupPath = join(dir, 'applied-rup.bin');
  const appliedXdeltaPath = join(dir, 'applied-xdelta.bin');

  const chdSource = Buffer.alloc(64 * 1024);
  for (let index = 0; index < chdSource.length; index += 1) {
    chdSource[index] = index % 251;
  }
  await writeFile(chdSourcePath, chdSource);
  await writeFile(originalPath, Buffer.from('abcdefgh', 'utf8'));
  await writeFile(modifiedPath, Buffer.from('a1XYZf!!!', 'utf8'));

  const chdCreateResult = await runJson([
    'compress',
    chdSourcePath,
    '--format',
    'chd',
    '--output',
    chdPath,
    '--threads',
    '1',
  ]);
  assert.equal(chdCreateResult.ok, true);
  assert.equal(getTerminalEvent(chdCreateResult).status, 'succeeded');

  const chdInspectResult = await runJson(['inspect', chdPath, '--list']);
  assert.equal(chdInspectResult.ok, true);
  assert.equal(getTerminalEvent(chdInspectResult).status, 'succeeded');

  const chdExtractResult = await runJson([
    'extract',
    chdPath,
    '--out-dir',
    chdExtractDir,
    '--threads',
    '1',
  ]);
  assert.equal(chdExtractResult.ok, true);
  assert.equal(getTerminalEvent(chdExtractResult).status, 'succeeded');
  const chdEntries = await readdir(chdExtractDir);
  assert.equal(chdEntries.length, 1);
  assert.deepEqual(
    await readFile(join(chdExtractDir, chdEntries[0])),
    await readFile(chdSourcePath),
  );

  const zipCompressResult = await runJson([
    'compress',
    sourcePath,
    '--format',
    'zip',
    '--output',
    zipPath,
    '--threads',
    '1',
  ]);
  assert.equal(zipCompressResult.ok, true);
  assert.equal(getTerminalEvent(zipCompressResult).status, 'succeeded');

  const zipInspectResult = await runJson(['inspect', zipPath, '--list']);
  assert.equal(zipInspectResult.ok, true);
  assert.equal(getTerminalEvent(zipInspectResult).status, 'succeeded');

  const zipExtractResult = await runJson([
    'extract',
    zipPath,
    '--out-dir',
    zipExtractDir,
    '--threads',
    '1',
  ]);
  assert.equal(zipExtractResult.ok, true);
  assert.equal(getTerminalEvent(zipExtractResult).status, 'succeeded');
  assert.deepEqual(
    await readFile(join(zipExtractDir, basename(sourcePath))),
    await readFile(sourcePath),
  );

  const ipsCreateResult = await runJson([
    'patch-create',
    '--original',
    originalPath,
    '--modified',
    modifiedPath,
    '--format',
    'ips',
    '--output',
    ipsPath,
    '--threads',
    '1',
  ]);
  assert.equal(ipsCreateResult.ok, true);

  const upsCreateResult = await runJson([
    'patch-create',
    '--original',
    originalPath,
    '--modified',
    modifiedPath,
    '--format',
    'ups',
    '--output',
    upsPath,
    '--threads',
    '1',
  ]);
  assert.equal(upsCreateResult.ok, true);

  const rupCreateResult = await runJson([
    'patch-create',
    '--original',
    originalPath,
    '--modified',
    modifiedPath,
    '--format',
    'rup',
    '--output',
    rupPath,
    '--threads',
    '1',
  ]);
  assert.equal(rupCreateResult.ok, true);

  const bpsCreateResult = await runJson([
    'patch-create',
    '--original',
    originalPath,
    '--modified',
    modifiedPath,
    '--format',
    'bps',
    '--output',
    bpsPath,
    '--threads',
    '1',
  ]);
  assert.equal(bpsCreateResult.ok, true);

  const ipsApplyResult = await runJson([
    'patch-apply',
    '--input',
    originalPath,
    '--patch',
    ipsPath,
    '--output',
    appliedIpsPath,
    '--threads',
    '1',
    '--no-compress',
  ]);
  assert.equal(ipsApplyResult.ok, true);
  assert.deepEqual(await readFile(appliedIpsPath), Buffer.from('a1XYZf!!!', 'utf8'));

  const upsApplyResult = await runJson([
    'patch-apply',
    '--input',
    originalPath,
    '--patch',
    upsPath,
    '--output',
    appliedUpsPath,
    '--threads',
    '1',
    '--no-compress',
  ]);
  assert.equal(upsApplyResult.ok, true);
  assert.deepEqual(await readFile(appliedUpsPath), Buffer.from('a1XYZf!!!', 'utf8'));

  const bpsApplyResult = await runJson([
    'patch-apply',
    '--input',
    originalPath,
    '--patch',
    bpsPath,
    '--output',
    appliedBpsPath,
    '--threads',
    '1',
    '--no-compress',
  ]);
  assert.equal(bpsApplyResult.ok, true);
  assert.deepEqual(await readFile(appliedBpsPath), Buffer.from('a1XYZf!!!', 'utf8'));

  const rupApplyResult = await runJson([
    'patch-apply',
    '--input',
    originalPath,
    '--patch',
    rupPath,
    '--output',
    appliedRupPath,
    '--threads',
    '1',
    '--no-compress',
  ]);
  assert.equal(rupApplyResult.ok, true);
  assert.deepEqual(await readFile(appliedRupPath), Buffer.from('a1XYZf!!!', 'utf8'));

  const sevenZCreateResult = await runJson([
    'compress',
    sourcePath,
    '--format',
    '7z',
    '--output',
    sevenZPath,
    '--threads',
    '1',
  ]);
  assert.equal(sevenZCreateResult.ok, true);
  assert.equal(getTerminalEvent(sevenZCreateResult).status, 'succeeded');

  const sevenZLzmaResult = await runJson([
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
  ]);
  assert.equal(sevenZLzmaResult.ok, true);
  assert.equal(getTerminalEvent(sevenZLzmaResult).status, 'succeeded');

  const sevenZLzma2Result = await runJson([
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
  ]);
  assert.equal(sevenZLzma2Result.ok, true);
  assert.equal(getTerminalEvent(sevenZLzma2Result).status, 'succeeded');

  const sevenZLzmaExtractResult = await runJson([
    'extract',
    sevenZLzmaPath,
    '--out-dir',
    sevenZLzmaExtractDir,
    '--threads',
    '1',
  ]);
  assert.equal(sevenZLzmaExtractResult.ok, true);
  assert.equal(getTerminalEvent(sevenZLzmaExtractResult).status, 'succeeded');
  assert.deepEqual(
    await readFile(join(sevenZLzmaExtractDir, basename(sourcePath))),
    await readFile(sourcePath),
  );

  const sevenZLzma2ExtractResult = await runJson([
    'extract',
    sevenZLzma2Path,
    '--out-dir',
    sevenZLzma2ExtractDir,
    '--threads',
    '1',
  ]);
  assert.equal(sevenZLzma2ExtractResult.ok, true);
  assert.equal(getTerminalEvent(sevenZLzma2ExtractResult).status, 'succeeded');
  assert.deepEqual(
    await readFile(join(sevenZLzma2ExtractDir, basename(sourcePath))),
    await readFile(sourcePath),
  );

  const xdeltaApplyResult = await runJson([
    'patch-apply',
    '--input',
    VCDIFF_SOURCE_FIXTURE_PATH,
    '--patch',
    VCDIFF_PATCH_FIXTURE_PATH,
    '--output',
    appliedXdeltaPath,
    '--threads',
    '1',
    '--no-compress',
  ]);
  assert.equal(xdeltaApplyResult.ok, true);
  assert.deepEqual(
    await readFile(appliedXdeltaPath),
    await readFile(VCDIFF_TARGET_FIXTURE_PATH),
  );
}

function assertFailedByPattern(result, pattern, context) {
  assert.equal(result.ok, false, `${context} should fail in the current wasm matrix`);
  assert.notEqual(result.exitCode, 0, `${context} should not exit with code 0`);
  const terminal = getTerminalEvent(result);
  const label = String(terminal.label || '');
  const stderr = String(result.stderr || '');
  if (!(pattern.test(label) || pattern.test(stderr))) {
    assert.fail(
      `${context} should match ${pattern}; label=${JSON.stringify(label)} stderr=${JSON.stringify(stderr)}`,
    );
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

function stripSuffix(name, suffix) {
  const normalizedSuffix = `.${suffix}`;
  if (name.endsWith(normalizedSuffix)) {
    return name.slice(0, -normalizedSuffix.length);
  }
  return name;
}

function expectedExtractPath(outDir, format, archivePath, sourcePath) {
  const archiveName = basename(archivePath);
  if (['zip', 'zipx', '7z', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz'].includes(format)) {
    return join(outDir, basename(sourcePath));
  }

  const suffix = containerSuffix(format);
  const stem = stripSuffix(archiveName, suffix);
  if (['gz', 'bz2', 'xz', 'zst'].includes(format)) {
    return join(outDir, stem);
  }
  if (format === 'cso') {
    return join(outDir, `${stem}.iso`);
  }
  if (format === 'chd') {
    return join(outDir, `${stem}.bin`);
  }
  if (format === 'z3ds') {
    return join(outDir, `${stem}.3ds`);
  }

  assert.fail(`missing expected extract path mapping for ${format}`);
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

export async function runFullFormatMatrix({ runJson, dir }) {
  const archiveSourcePath = join(dir, 'all-format-source.bin');
  const archiveSource = Buffer.alloc(8192);
  for (let index = 0; index < archiveSource.length; index += 1) {
    archiveSource[index] = index % 251;
  }
  archiveSource[archiveSource.length - 1] = 0;
  await writeFile(archiveSourcePath, archiveSource);

  const containerRoundTripFormats = [
    'zip',
    'zipx',
    '7z',
    'gz',
    'bz2',
    'xz',
    'zst',
    'cso',
    'chd',
    'z3ds',
  ];
  for (const format of containerRoundTripFormats) {
    const archivePath = join(dir, `roundtrip-${formatToken(format)}.${containerSuffix(format)}`);
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
    assert.equal(compressResult.ok, true, `compress ${format} should succeed`);
    assert.equal(getTerminalEvent(compressResult).status, 'succeeded');

    const extractDir = join(dir, `roundtrip-${formatToken(format)}-extract`);
    const extractResult = await runJson([
      'extract',
      archivePath,
      '--out-dir',
      extractDir,
      '--threads',
      '1',
    ]);
    assert.equal(extractResult.ok, true, `extract ${format} should succeed`);
    assert.equal(getTerminalEvent(extractResult).status, 'succeeded');

    const extractedPath = expectedExtractPath(extractDir, format, archivePath, archiveSourcePath);
    assert.deepEqual(await readFile(extractedPath), await readFile(archiveSourcePath));
  }

  const containerCompressFailureExpectations = new Map([
    ['rar', /rar create is not supported/i],
    ['tar', /not implemented/i],
    ['tar.gz', /not implemented/i],
    ['tar.bz2', /not implemented/i],
    ['tar.xz', /not implemented/i],
    ['pbp', /pbp create is not supported/i],
    ['gcz', /gcz compression is not supported/i],
    ['wbfs', /failed to open input/i],
    ['wia', /failed to open input/i],
    ['tgc', /failed to open input/i],
    ['nfs', /nfs compression is not supported/i],
    ['rvz', /failed to open input/i],
    ['xiso', /not registered/i],
  ]);
  for (const [format, pattern] of containerCompressFailureExpectations.entries()) {
    const archivePath = join(dir, `compress-${formatToken(format)}.${containerSuffix(format)}`);
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
    ['tar', /failed to read entire block/i],
    ['tar.gz', /invalid gzip header/i],
    ['tar.bz2', /bz2 header missing/i],
    ['tar.xz', /invalid xz magic bytes/i],
    ['pbp', /too small to be a pbp container/i],
    ['gcz', /failed to open gcz source/i],
    ['wbfs', /failed to open wbfs source/i],
    ['wia', /failed to open wia source/i],
    ['tgc', /failed to open tgc source/i],
    ['nfs', /failed to open nfs source/i],
    ['rvz', /failed to open rvz source/i],
    ['xiso', /xiso extract is not supported yet/i],
  ]);
  for (const [format, pattern] of containerExtractFailureExpectations.entries()) {
    const sourcePath = join(dir, `extract-${formatToken(format)}.${containerSuffix(format)}`);
    await writeFile(sourcePath, Buffer.from('not-a-real-container', 'utf8'));
    const outDir = join(dir, `extract-${formatToken(format)}-out`);
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

  const originalPath = join(dir, 'all-format-original.bin');
  const modifiedPath = join(dir, 'all-format-modified.bin');
  const original = Buffer.alloc(4096);
  for (let index = 0; index < original.length; index += 1) {
    original[index] = index % 251;
  }
  const modified = Buffer.from(original);
  for (let index = 0; index < 300; index += 1) {
    modified[100 + index] = (modified[100 + index] + 17) % 256;
  }
  await writeFile(originalPath, original);
  await writeFile(modifiedPath, modified);

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

  const createAndApplySuccessFormats = new Set(['ips', 'ips32', 'bps', 'ups', 'gdiff', 'rup', 'ebp']);
  const createSuccessApplyFailureExpectations = new Map([
    ['apsgba', /i\/o error: unsupported/i],
    ['ppf', /i\/o error: unsupported/i],
    ['pat', /i\/o error: unsupported/i],
    ['mod', /i\/o error: unsupported/i],
    ['dps', /i\/o error: unsupported/i],
  ]);
  const createUnsupportedExpectations = new Map([
    ['hdiffpatch', /creation is disabled/i],
    ['ninja1', /not currently supported/i],
    ['bsp', /creation is not implemented/i],
  ]);
  const createFailureExpectations = new Map([
    ['solid', /i\/o error: unsupported/i],
    ['aps', /i\/o error: unsupported/i],
    ['bdf', /i\/o error: unsupported/i],
    ['dldi', /i\/o error: unsupported/i],
    ['vcdiff', /creating VCDIFF patch/i],
    ['xdelta', /creating xdelta patch/i],
  ]);

  for (const format of patchFormats) {
    const extension = patchExtension(format);
    assert.equal(typeof extension, 'string', `missing extension mapping for ${format}`);
    const patchPath = join(dir, `patch-${format}.${extension}`);
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

    if (createAndApplySuccessFormats.has(format)) {
      assert.equal(createResult.ok, true, `patch-create ${format} should succeed`);
      assert.equal(getTerminalEvent(createResult).status, 'succeeded');
      const applyPath = join(dir, `patch-applied-${format}.bin`);
      const applyResult = await runJson([
        'patch-apply',
        '--input',
        originalPath,
        '--patch',
        patchPath,
        '--output',
        applyPath,
        '--threads',
        '1',
        '--no-compress',
      ]);
      assert.equal(applyResult.ok, true, `patch-apply ${format} should succeed`);
      assert.equal(getTerminalEvent(applyResult).status, 'succeeded');
      assert.deepEqual(await readFile(applyPath), await readFile(modifiedPath));
      continue;
    }

    if (createSuccessApplyFailureExpectations.has(format)) {
      assert.equal(createResult.ok, true, `patch-create ${format} should succeed`);
      assert.equal(getTerminalEvent(createResult).status, 'succeeded');
      const applyPath = join(dir, `patch-applied-${format}.bin`);
      const applyResult = await runJson([
        'patch-apply',
        '--input',
        originalPath,
        '--patch',
        patchPath,
        '--output',
        applyPath,
        '--threads',
        '1',
        '--no-compress',
      ]);
      assertFailedByPattern(
        applyResult,
        createSuccessApplyFailureExpectations.get(format),
        `patch-apply ${format}`,
      );
      continue;
    }

    if (createUnsupportedExpectations.has(format)) {
      assertFailedByPattern(
        createResult,
        createUnsupportedExpectations.get(format),
        `patch-create ${format}`,
      );
      assert.equal(getTerminalEvent(createResult).status, 'unsupported');
      continue;
    }

    if (createFailureExpectations.has(format)) {
      assertFailedByPattern(createResult, createFailureExpectations.get(format), `patch-create ${format}`);
      continue;
    }

    assert.fail(`unhandled patch format expectation for ${format}`);
  }

  const xdeltaApplyPath = join(dir, 'fixture-applied-xdelta.bin');
  const xdeltaApplyResult = await runJson([
    'patch-apply',
    '--input',
    VCDIFF_SOURCE_FIXTURE_PATH,
    '--patch',
    VCDIFF_PATCH_FIXTURE_PATH,
    '--output',
    xdeltaApplyPath,
    '--threads',
    '1',
    '--no-compress',
  ]);
  assert.equal(xdeltaApplyResult.ok, true, 'fixture patch-apply xdelta should succeed');
  assert.equal(getTerminalEvent(xdeltaApplyResult).status, 'succeeded');
  assert.deepEqual(
    await readFile(xdeltaApplyPath),
    await readFile(VCDIFF_TARGET_FIXTURE_PATH),
  );

  const vcdiffPatchPath = join(dir, 'fixture-secondary.vcdiff');
  await writeFile(vcdiffPatchPath, await readFile(VCDIFF_PATCH_FIXTURE_PATH));
  const vcdiffApplyPath = join(dir, 'fixture-applied-vcdiff.bin');
  const vcdiffApplyResult = await runJson([
    'patch-apply',
    '--input',
    VCDIFF_SOURCE_FIXTURE_PATH,
    '--patch',
    vcdiffPatchPath,
    '--output',
    vcdiffApplyPath,
    '--threads',
    '1',
    '--no-compress',
  ]);
  assert.equal(vcdiffApplyResult.ok, true, 'fixture patch-apply vcdiff should succeed');
  assert.equal(getTerminalEvent(vcdiffApplyResult).status, 'succeeded');
  assert.deepEqual(
    await readFile(vcdiffApplyPath),
    await readFile(VCDIFF_TARGET_FIXTURE_PATH),
  );
}
