import {
  createMonotonicProgressEmitter,
  extractProgressPercents,
  hasUsableIntermediateProgress,
  mapBytesToPercentRange,
  yieldProgress,
} from "../../../shared/wasm-tool-runtime-utils.ts";
import type { SevenZipCliProgressResult, SevenZipRunResult } from "./types.ts";

type ProgressCallback = (progress: {
  label?: string;
  percent?: number | null;
  [key: string]: RuntimeValue | undefined;
}) => void;

export { createMonotonicProgressEmitter, hasUsableIntermediateProgress };

export const SEVEN_ZIP_PROGRESS_SWITCHES = ["-bsp2", "-bso0", "-bse2"];
export const SEVEN_ZIP_REPLAY_FRAME_DELAY_MS = 16;

const SEVEN_ZIP_PROGRESS_PATTERN = /(?:^|\s)(\d{1,3})%/g;
const SEVEN_ZIP_LIVE_PROGRESS_PATTERN = /(\d{1,3})%/g;
const SEVEN_ZIP_REPLAY_MIN_PERCENT_DELTA = 5;

export const inspectSevenZipCliProgress = (result: SevenZipRunResult): SevenZipCliProgressResult => {
  const stdoutPercents = extractProgressPercents(result.stdout, SEVEN_ZIP_PROGRESS_PATTERN);
  const stderrPercents = extractProgressPercents(result.stderr, SEVEN_ZIP_PROGRESS_PATTERN);
  if (hasUsableIntermediateProgress(stdoutPercents))
    return { percents: stdoutPercents, stderrPercents, stdoutPercents, stream: "stdout", useful: true };
  if (hasUsableIntermediateProgress(stderrPercents))
    return { percents: stderrPercents, stderrPercents, stdoutPercents, stream: "stderr", useful: true };
  return { percents: [], stderrPercents, stdoutPercents, stream: null, useful: false };
};

export const createSevenZipStderrProgressParser = (onProgress: (percent: number) => void) => {
  let buffer = "";
  let lastPercent = -1;

  const emitFromText = (text: string) => {
    SEVEN_ZIP_LIVE_PROGRESS_PATTERN.lastIndex = 0;
    let match = SEVEN_ZIP_LIVE_PROGRESS_PATTERN.exec(text);
    while (match) {
      const parsedPercent = parseInt(match[1] || "", 10);
      if (Number.isFinite(parsedPercent)) {
        const percent = Math.max(0, Math.min(100, parsedPercent));
        if (percent > lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
      match = SEVEN_ZIP_LIVE_PROGRESS_PATTERN.exec(text);
    }
  };

  const flush = () => {
    if (buffer) emitFromText(buffer);
    buffer = "";
  };

  return {
    push: (value: number | string) => {
      const text = typeof value === "number" ? String.fromCharCode(value & 0xff) : String(value || "");
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          flush();
          continue;
        }
        buffer += char;
        if (char === "%") emitFromText(buffer);
        if (buffer.length > 4096) buffer = buffer.slice(-1024);
      }
    },
    reset: () => {
      buffer = "";
      lastPercent = -1;
    },
  };
};

export const emitSevenZipProgressSequence = async (
  onProgress: ProgressCallback | undefined,
  label: string,
  percents: number[],
  options?: { startPercent?: number; endPercent?: number; progressSource?: string; progressStream?: string | null },
) => {
  if (!(onProgress && percents.length)) return false;
  const emitter = createMonotonicProgressEmitter({ onProgress }, label, {
    baseFields: {
      ...(options?.progressSource ? { progressSource: options.progressSource } : {}),
      ...(options?.progressStream ? { progressStream: options.progressStream } : {}),
    },
    minIntervalMs: 0,
    minPercentDelta: 0,
  });
  const startPercent = typeof options?.startPercent === "number" ? options.startPercent : 0;
  const endPercent = typeof options?.endPercent === "number" ? options.endPercent : 100;
  const normalizedPercents: number[] = [];
  let lastRoundedPercent = -1;
  for (let index = 0; index < percents.length; index += 1) {
    const percent = percents[index];
    if (typeof percent !== "number") continue;
    const mappedPercent = mapBytesToPercentRange(percent, 100, startPercent, endPercent);
    const roundedPercent = Math.floor(mappedPercent);
    const isFinalPercent = index === percents.length - 1;
    if (roundedPercent <= lastRoundedPercent) continue;
    if (
      !isFinalPercent &&
      lastRoundedPercent >= 0 &&
      roundedPercent - lastRoundedPercent < SEVEN_ZIP_REPLAY_MIN_PERCENT_DELTA
    )
      continue;
    lastRoundedPercent = roundedPercent;
    normalizedPercents.push(mappedPercent);
  }
  for (let index = 0; index < normalizedPercents.length; index += 1) {
    const nextPercent = normalizedPercents[index];
    if (typeof nextPercent !== "number") continue;
    emitter.emit(nextPercent);
    if (index < normalizedPercents.length - 1) await yieldProgress(SEVEN_ZIP_REPLAY_FRAME_DELAY_MS);
  }
  return emitter.hasIntermediate();
};
