import type {
  RomWeaverProgressEvent,
  RomWeaverRunJsonOptions,
} from '../rom-weaver-types.d.ts';

export interface WorkerClientRunJsonOptions<TEvent = RomWeaverProgressEvent, TTraceEvent = unknown>
  extends Omit<RomWeaverRunJsonOptions<TEvent, TTraceEvent>, 'onEvent' | 'onNonJsonLine' | 'onTraceEvent' | 'onTraceNonJsonLine'> {
  onEvent?: (event: TEvent) => void;
  onNonJsonLine?: (line: string) => void;
  onTraceEvent?: (event: TTraceEvent) => void;
  onTraceNonJsonLine?: (line: string) => void;
  [key: string]: unknown;
}
