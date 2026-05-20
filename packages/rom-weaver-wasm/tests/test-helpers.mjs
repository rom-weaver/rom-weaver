import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const zipPath = join(dir, 'archive.zip');
  const zipExtractDir = join(dir, 'zip-extract');
  const sevenZPath = join(dir, 'archive.7z');
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

  await writeFile(originalPath, Buffer.from('abcdefgh', 'utf8'));
  await writeFile(modifiedPath, Buffer.from('a1XYZf!!!', 'utf8'));

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
    join(dir, 'archive-lzma.7z'),
    '--codec',
    'lzma',
    '--threads',
    '1',
  ]);
  assertFailedWithLabel(
    sevenZLzmaResult,
    /7z codec `lzma` is not available on wasm/i,
    '7z lzma codec should fail with a structured wasm validation error',
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
