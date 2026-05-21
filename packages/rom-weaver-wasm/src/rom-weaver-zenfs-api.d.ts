import type {
  RomWeaverProgressEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunResult,
  RomWeaverZenFsBrowserOptions,
  RomWeaverZenFsBrowserRunOptions,
} from './rom-weaver-types.d.ts';

interface RomWeaverZenFsRunnerBase {
  run(args?: unknown[], options?: RomWeaverZenFsBrowserRunOptions): Promise<RomWeaverRunResult>;
  runJson<TEvent = RomWeaverProgressEvent, TTraceEvent = unknown>(
    args?: unknown[],
    options?: RomWeaverRunJsonOptions<TEvent, TTraceEvent>,
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
}

export interface RomWeaverZenFsBrowserRunner extends RomWeaverZenFsRunnerBase {
  mode: 'browser';
  fs: unknown;
  opfsHandle: unknown;
  scratchHandle: unknown;
  opfsGuestPath: string;
  scratchGuestPath: string;
  scratchNamespace: string;
  runtimeMounts: string[];
}

export function createRomWeaverZenFsBrowser(
  options?: RomWeaverZenFsBrowserOptions,
): Promise<RomWeaverZenFsBrowserRunner>;

export function syncZenFsToWasmerDirectory(..._args: unknown[]): Promise<never>;
export function syncWasmerDirectoryToZenFs(..._args: unknown[]): Promise<never>;
