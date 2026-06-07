import { describe, expect, it } from 'vitest';
import {
  clampRomWeaverBrowserThreadRequest,
  collectRomWeaverRunInputPaths,
  createRomWeaverCommand,
  getRomWeaverCommandLabel,
  normalizeRomWeaverRunRequest,
  readRomWeaverRequestedThreadCount,
  withRomWeaverDefaultThreads,
} from '../src/rom-weaver-command.ts';

describe('rom-weaver command boundary helpers', () => {
  it('builds nested patch commands and preserves patch labels', () => {
    const command = createRomWeaverCommand('patch-apply', {
      input: '/work/original.bin',
      output: '/work/output.bin',
      patches: ['/work/update.bps'],
    });

    expect(command).toEqual({
      type: 'patch',
      args: {
        type: 'apply',
        args: {
          input: '/work/original.bin',
          output: '/work/output.bin',
          patches: ['/work/update.bps'],
        },
      },
    });
    expect(getRomWeaverCommandLabel(command)).toBe('patch-apply');
  });

  it('normalizes run requests and collects command plus known input paths', () => {
    const request = normalizeRomWeaverRunRequest(
      {
        command: createRomWeaverCommand('patch-apply', {
          input: '/work/original.bin',
          output: '/work/output.bin',
          patches: ['/work/update.bps', '--not-a-path'],
        }),
        output: { trace: true },
      },
      { json: true },
    );

    expect(request.output).toEqual({ json: true, trace: true });
    expect(collectRomWeaverRunInputPaths(request, { knownInputPaths: ['/work/sidecar.bin'] })).toEqual([
      '/work/original.bin',
      '/work/update.bps',
      '/work/sidecar.bin',
    ]);
  });

  it('injects and clamps browser thread defaults only for threaded commands', () => {
    const request = normalizeRomWeaverRunRequest(
      createRomWeaverCommand('compress', {
        input: ['/work/source.bin'],
        output: '/work/archive.zip',
      }),
    );
    const withDefault = withRomWeaverDefaultThreads(request, 12);
    const clamped = clampRomWeaverBrowserThreadRequest(withDefault, {
      autoThreads: 4,
      defaultThreads: 12,
      maxThreads: 8,
    });

    expect(clamped.command.args.threads).toBe(8);
    expect(readRomWeaverRequestedThreadCount(clamped, { maxThreads: 8 })).toBe(8);

    const listRequest = normalizeRomWeaverRunRequest(
      createRomWeaverCommand('list', { source: '/work/archive.zip' }),
    );
    expect(withRomWeaverDefaultThreads(listRequest, 4)).toBe(listRequest);
  });
});
