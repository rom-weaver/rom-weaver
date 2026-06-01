import type {
  RomWeaverBrowserOpfsOptions,
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunResult,
} from './rom-weaver-types.d.ts';

interface RomWeaverBrowserOpfsRunnerBase {
  run(commandOrRequest: RomWeaverRunInput, options?: RomWeaverBrowserOpfsRunOptions): Promise<RomWeaverRunResult>;
  runJson<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>(
    commandOrRequest: RomWeaverRunInput,
    options?: RomWeaverRunJsonOptions<TEvent, TTraceEvent> & RomWeaverBrowserOpfsRunOptions,
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
}

export interface RomWeaverBrowserOpfsRunner extends RomWeaverBrowserOpfsRunnerBase {
  mode: 'browser-opfs';
  fs: null;
  opfsHandle: unknown;
  opfsGuestPath: string;
  workGuestPath: string;
  runtimeMounts: string[];
  threaded: boolean;
  wasmUrl: string | null;
  writableRoots: string[];
}

export function createRomWeaverBrowserOpfs(
  options?: RomWeaverBrowserOpfsOptions,
): Promise<RomWeaverBrowserOpfsRunner>;
