import type { RomWeaverProgressEvent, RomWeaverRunJsonEvent } from "../../wasm/index.ts";

type RomWeaverRuntimeProgressStatus = RomWeaverProgressEvent["status"];
type RomWeaverRuntimeProgressLabel = RomWeaverProgressEvent["label"];
type RomWeaverRuntimeProgressPercent = RomWeaverProgressEvent["percent"];
type RomWeaverRuntimeProgressDetails = RomWeaverProgressEvent["details"];
type RomWeaverRuntimeProgressFormat = RomWeaverProgressEvent["format"];
type RomWeaverRuntimeProgressElapsedMs = RomWeaverProgressEvent["elapsed_ms"];
type RomWeaverRuntimeProgressEffectiveThreads = RomWeaverProgressEvent["effective_threads"];

const RUNNING_PROGRESS_STATUS: RomWeaverRuntimeProgressStatus = "running";
const FAILED_PROGRESS_STATUS: RomWeaverRuntimeProgressStatus = "failed";
const TERMINAL_PROGRESS_STATUSES: ReadonlySet<RomWeaverRuntimeProgressStatus> = new Set<RomWeaverRuntimeProgressStatus>(
  ["succeeded", FAILED_PROGRESS_STATUS],
);

const getRomWeaverRunEventStatus = (event: RomWeaverRunJsonEvent): RomWeaverRuntimeProgressStatus => event.status;

const getRomWeaverRunEventLabel = (event: RomWeaverRunJsonEvent): RomWeaverRuntimeProgressLabel => event.label;

const getRomWeaverRunEventPercent = (event: RomWeaverRunJsonEvent): RomWeaverRuntimeProgressPercent => event.percent;

const getRomWeaverRunEventDetails = (event: RomWeaverRunJsonEvent): RomWeaverRuntimeProgressDetails => event.details;

const getRomWeaverRunEventFormat = (event: RomWeaverRunJsonEvent): RomWeaverRuntimeProgressFormat => event.format;

const getRomWeaverRunEventElapsedMs = (event: RomWeaverRunJsonEvent): RomWeaverRuntimeProgressElapsedMs =>
  event.elapsed_ms;

const getRomWeaverRunEventEffectiveThreads = (event: RomWeaverRunJsonEvent): RomWeaverRuntimeProgressEffectiveThreads =>
  event.effective_threads;

const isRomWeaverFailedRunEvent = (event: RomWeaverRunJsonEvent): boolean =>
  getRomWeaverRunEventStatus(event) === FAILED_PROGRESS_STATUS;

const isRomWeaverLiveRunEvent = (event: RomWeaverRunJsonEvent): boolean =>
  getRomWeaverRunEventStatus(event) === RUNNING_PROGRESS_STATUS;

const isRomWeaverTerminalRunEvent = (event: RomWeaverRunJsonEvent): boolean =>
  TERMINAL_PROGRESS_STATUSES.has(getRomWeaverRunEventStatus(event));

export {
  getRomWeaverRunEventDetails,
  getRomWeaverRunEventEffectiveThreads,
  getRomWeaverRunEventElapsedMs,
  getRomWeaverRunEventFormat,
  getRomWeaverRunEventLabel,
  getRomWeaverRunEventPercent,
  isRomWeaverFailedRunEvent,
  isRomWeaverLiveRunEvent,
  isRomWeaverTerminalRunEvent,
};
