export * from './generated/rom-weaver-format-metadata.ts';
export * from './rom-weaver-types.d.ts';
export * from './rom-weaver-command.ts';
import type {
  RomWeaverBrowserOpfsOptions,
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunResult,
} from './rom-weaver-types.d.ts';

export interface RomWeaverBrowserOpfsRunner {
  dispose(): Promise<void>;
  fs: null;
  mode: 'browser-opfs';
  opfsGuestPath: string;
  opfsHandle: unknown;
  run(commandOrRequest: RomWeaverRunInput, options?: RomWeaverBrowserOpfsRunOptions): Promise<RomWeaverRunResult>;
  runJson<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>(
    commandOrRequest: RomWeaverRunInput,
    options?: RomWeaverRunJsonOptions<TEvent, TTraceEvent> & RomWeaverBrowserOpfsRunOptions,
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
  runtimeMounts: string[];
  threaded: boolean;
  wasmUrl: string | null;
  workGuestPath: string;
  writableRoots: string[];
}

export function createRomWeaverBrowserOpfs(
  options?: RomWeaverBrowserOpfsOptions,
): Promise<RomWeaverBrowserOpfsRunner>;
