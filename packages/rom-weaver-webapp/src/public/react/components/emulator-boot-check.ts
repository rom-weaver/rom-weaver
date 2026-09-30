import { createLogger } from "../../../lib/logging.ts";
import { createEmulatorDocument, createEmulatorGameIdentity } from "./emulator-document.ts";

const logger = createLogger("emulator-boot-check");

/** A frame counts as a picture when its colours are not one flat fill. */
const MIN_MINORITY_RATIO = 0.001;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_FRAMES = 60;
const POLL_INTERVAL_MS = 100;
const SAMPLE_INTERVAL_MS = 250;
/**
 * The least time a capture gets once the core has drawn enough frames, so a
 * check that reaches its frames just before the deadline still takes a sample.
 */
const MIN_CAPTURE_MS = 1_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type FramePixels = {
  data: ArrayLike<number>;
  height: number;
  width: number;
};

type BootFrameSummary = {
  /** Number of distinct RGB values in the frame. */
  distinct: number;
  /** The most common RGB value, as 0xRRGGBB. */
  dominant: number;
  /** Share of pixels that are not the dominant colour, from 0 to 1. */
  minorityRatio: number;
};

/**
 * `blank` means the game ran and drew nothing, or the emulator refused it.
 * `timeout` means the check ran out of time before it could judge a frame.
 * `error` means the check itself failed, for example on an unreadable frame.
 */
type BootCheckOutcome =
  | { frames: number; samples: number; status: "boots"; summary: BootFrameSummary }
  | { frames: number; reason: "blank-frame" | "failed-to-start"; samples: number; status: "blank" }
  | { frames: number; loaded: boolean; status: "timeout" }
  | { detail: string; frames: number; status: "error" };

type EmulatorGameManager = {
  getFrameNum?: () => number;
  screenshot?: () => Promise<ArrayBufferLike | Uint8Array>;
};

type EmulatorInstance = {
  failedToStart?: boolean;
  gameManager?: EmulatorGameManager;
};

type EmulatorWindow = Window & { EJS_emulator?: EmulatorInstance };

type BootCheckFrame = HTMLIFrameElement & { romWeaverAudioContext?: AudioContext | null };

type BootCheckOptions = {
  /**
   * A context created during the Apply click. The player uses it instead of
   * its own, which WebKit would leave suspended. The caller keeps ownership.
   */
  audioContext?: AudioContext | null;
  /** SHA-1 of the ROM, used to name the game the way the Test player does. */
  checksum: string;
  core: string;
  dataUrl: string;
  fileName: string;
  /** Where the hidden player goes. Defaults to `document.body`. */
  host?: HTMLElement;
  minFrames?: number;
  rom: Blob;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const summarizeFrameColors = ({ data, height, width }: FramePixels): BootFrameSummary => {
  const pixels = width * height;
  if (!pixels) return { distinct: 0, dominant: 0, minorityRatio: 0 };
  const counts = new Map<number, number>();
  for (let offset = 0; offset + 2 < data.length; offset += 4) {
    const rgb = ((data[offset] ?? 0) << 16) | ((data[offset + 1] ?? 0) << 8) | (data[offset + 2] ?? 0);
    counts.set(rgb, (counts.get(rgb) || 0) + 1);
  }
  let dominant = 0;
  let dominantCount = 0;
  for (const [rgb, count] of counts) {
    if (count <= dominantCount) continue;
    dominant = rgb;
    dominantCount = count;
  }
  return { distinct: counts.size, dominant, minorityRatio: 1 - dominantCount / pixels };
};

/** A booted game draws something: more than one colour, and not a single stray pixel. */
const isBootFrame = (summary: BootFrameSummary): boolean =>
  summary.distinct > 1 && summary.minorityRatio > MIN_MINORITY_RATIO;

const isPng = (bytes: Uint8Array): boolean =>
  bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value);

const decodePng = async (bytes: Uint8Array): Promise<FramePixels> => {
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser gave no 2D canvas to read the emulator frame.");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
};

const abortError = () => Object.assign(new Error("The boot check was cancelled."), { name: "AbortError" });

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Settle with `work`, or with `null` after `ms`. The timer and the abort
 * listener are removed as soon as either side settles.
 */
const withDeadline = <T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | null> =>
  new Promise<T | null>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });

const readFrameCount = (emulator: EmulatorInstance | undefined): number => {
  try {
    return emulator?.gameManager?.getFrameNum?.() ?? 0;
  } catch {
    return 0;
  }
};

type SampleOptions = {
  /** `Date.now()` value after which no new sample starts. */
  deadline: number;
  decode: (png: Uint8Array) => Promise<FramePixels>;
  emulatorOf: () => EmulatorInstance | undefined;
  minCaptureMs?: number;
  minFrames: number;
  pollIntervalMs?: number;
  sampleIntervalMs?: number;
  signal?: AbortSignal;
};

/**
 * Wait for the core to draw `minFrames` frames, then capture and classify
 * frames until one shows a picture. A game can show a flat screen for a
 * moment while it starts, so one flat frame is not a verdict: `blank-frame`
 * needs every frame sampled before the deadline to be flat.
 */
const sampleBootFrames = async ({
  deadline,
  decode,
  emulatorOf,
  minCaptureMs = MIN_CAPTURE_MS,
  minFrames,
  pollIntervalMs = POLL_INTERVAL_MS,
  sampleIntervalMs = SAMPLE_INTERVAL_MS,
  signal,
}: SampleOptions): Promise<BootCheckOutcome> => {
  let frames = 0;
  let samples = 0;
  let loaded = false;
  while (Date.now() < deadline) {
    const emulator = emulatorOf();
    if (emulator) loaded = true;
    if (emulator?.failedToStart) return { frames, reason: "failed-to-start", samples, status: "blank" };
    frames = readFrameCount(emulator);
    const screenshot = emulator?.gameManager?.screenshot;
    if (!(emulator && frames >= minFrames && screenshot)) {
      await sleep(pollIntervalMs, signal);
      continue;
    }
    // EmulatorJS polls its filesystem forever for the screenshot file, so
    // every capture is bounded.
    const captureMs = Math.max(minCaptureMs, deadline - Date.now());
    const captured = await withDeadline(Promise.resolve(screenshot.call(emulator.gameManager)), captureMs, signal);
    if (!captured) break;
    const png = captured instanceof Uint8Array ? captured : new Uint8Array(captured);
    if (!isPng(png)) return { detail: "The captured frame is not a PNG.", frames, status: "error" };
    const summary = summarizeFrameColors(await decode(png));
    samples += 1;
    logger.trace("Boot check sampled a frame", { frames, samples, ...summary });
    if (isBootFrame(summary)) return { frames, samples, status: "boots", summary };
    if (Date.now() >= deadline) break;
    await sleep(Math.min(sampleIntervalMs, Math.max(0, deadline - Date.now())), signal);
  }
  if (samples > 0) return { frames, reason: "blank-frame", samples, status: "blank" };
  return { frames, loaded, status: "timeout" };
};

/**
 * The player needs a real layout box: a browser does not run animation
 * frames for an iframe with `display: none`, so the core would never advance.
 * The box is transparent, inert, and behind the page instead.
 */
const createHiddenFrame = (): BootCheckFrame => {
  const iframe: BootCheckFrame = document.createElement("iframe");
  iframe.className = "emulator-boot-check-frame";
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("inert", "");
  iframe.tabIndex = -1;
  iframe.title = "Boot check";
  iframe.style.cssText =
    "position:fixed;left:0;top:0;width:256px;height:240px;border:0;opacity:0;pointer-events:none;z-index:-1";
  return iframe;
};

/**
 * Boot a ROM in a hidden EmulatorJS player and classify its frames with
 * `sampleBootFrames`. The player is always
 * removed before this returns or throws. An abort rejects with `AbortError`.
 */
const runEmulatorBootCheck = async ({
  audioContext,
  checksum,
  core,
  dataUrl,
  fileName,
  host,
  minFrames = DEFAULT_MIN_FRAMES,
  rom,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: BootCheckOptions): Promise<BootCheckOutcome> => {
  if (signal?.aborted) throw abortError();
  const { gameId, gameName } = createEmulatorGameIdentity({ checksum, fileName });
  const gameUrl = URL.createObjectURL(rom);
  const iframe = createHiddenFrame();
  const deadline = Date.now() + timeoutMs;
  let frames = 0;
  logger.trace("Boot check started", { core, fileName, minFrames, timeoutMs });
  try {
    iframe.romWeaverAudioContext = audioContext ?? null;
    iframe.srcdoc = createEmulatorDocument(dataUrl, gameUrl, gameName, core, { gameId, headless: true });
    (host || document.body).append(iframe);
    const emulatorOf = () => (iframe.contentWindow as EmulatorWindow | null)?.EJS_emulator;
    const outcome = await sampleBootFrames({ deadline, decode: decodePng, emulatorOf, minFrames, signal });
    frames = outcome.frames;
    logger.debug("Boot check finished", { core, fileName, ...outcome });
    return outcome;
  } finally {
    iframe.romWeaverAudioContext = null;
    iframe.remove();
    URL.revokeObjectURL(gameUrl);
    logger.trace("Boot check player removed", { core, fileName, frames });
  }
};

export type { BootCheckOutcome };
export { isBootFrame, runEmulatorBootCheck, sampleBootFrames, summarizeFrameColors };
