import assert from 'node:assert/strict';
import test from 'node:test';

import { commandArgsToRunRequest } from './command-run-request.mjs';

const request = (type, args) => ({ type, args });
const patchRequest = (type, args) => request('patch', { type, args });

const CASES = [
  {
    name: 'compress',
    args: ['-vv', '--dep-trace', 'compress', 'one.bin', 'two.bin', '--output', 'out.7z', '--codec', 'lzma2', '--threads', 'auto'],
    expected: {
      command: request('compress', {
        input: ['one.bin', 'two.bin'],
        output: 'out.7z',
        codec: ['lzma2'],
        threads: 'auto',
      }),
      output: { log_level: 'debug', dep_trace: true },
    },
  },
  {
    name: 'extract',
    args: ['extract', 'game.zip', '--out-dir', 'out', '--select', 'disc', '--split-bin', '--no-overwrite'],
    expected: request('extract', {
      input: 'game.zip',
      output: 'out',
      select: ['disc'],
      split_bin: true,
      force: false,
    }),
  },
  {
    name: 'checksum',
    args: ['checksum', 'game.bin', '--algo', 'crc32', '--start', '4', '--length', '16', '--patch-filter'],
    expected: request('checksum', {
      input: 'game.bin',
      algo: ['crc32'],
      filter: ['patch'],
      start: 4,
      length: 16,
    }),
  },
  {
    name: 'patch create',
    args: ['patch', 'create', '--original', 'old.bin', '--modified', 'new.bin', '--format', 'bps', '--output', 'change.bps'],
    expected: patchRequest('create', {
      original: 'old.bin',
      modified: 'new.bin',
      format: 'bps',
      output: 'change.bps',
    }),
  },
  {
    name: 'patch apply',
    args: ['patch', 'apply', '--input', 'game.bin', '--patch', 'one.bps', '--patch=two.ips', '--output', 'patched.bin', '--repair-checksum'],
    expected: patchRequest('apply', {
      input: 'game.bin',
      patches: ['one.bps', 'two.ips'],
      output: 'patched.bin',
      repair_checksum: true,
    }),
  },
  {
    name: 'patch validate',
    args: ['patch', 'validate', '--input', 'game.bin', '--patch', 'change.bps', '--validate-with-size', '1024', '--validate-with-min-size', '512'],
    expected: patchRequest('validate', {
      input: 'game.bin',
      patches: ['change.bps'],
      expect_in: ['size=1024', 'min-size=512'],
    }),
  },
];

test('maps every CLI command shape to a typed run request', async (t) => {
  for (const { name, args, expected } of CASES) {
    await t.test(name, () => assert.deepEqual(commandArgsToRunRequest(args), expected));
  }
});

test('only includes JSON output when requested by the caller', () => {
  const args = ['--json', 'checksum', 'game.bin'];
  const command = request('checksum', { input: 'game.bin', algo: [] });

  assert.deepEqual(commandArgsToRunRequest(args), command);
  assert.deepEqual(commandArgsToRunRequest(args, { includeJson: true }), {
    command,
    output: { json: true },
  });
});
