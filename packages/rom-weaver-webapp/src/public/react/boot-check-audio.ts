import { createLogger } from "../../lib/logging.ts";

const logger = createLogger("boot-check-audio");

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;
type AudioWindow = Window & typeof globalThis & { webkitAudioContext?: AudioContextConstructor };

let pending: AudioContext | null = null;

const closeQuietly = (context: AudioContext) => {
  if (context.state === "closed") return;
  void context.close().catch((error) => {
    logger.warn("Boot check audio context cleanup failed", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
  });
};

/**
 * Create the boot check's AudioContext while the Apply click is still a user
 * action. The emulator core stops after a few frames while its context is
 * suspended. Chromium resumes a context in any frame of a page that the user
 * has clicked, but WebKit resumes only a context created or resumed during
 * the click itself. Callers MUST call this synchronously from the click.
 */
const prepareBootCheckAudioContext = (): void => {
  if (typeof window === "undefined") return;
  const audioWindow = window as AudioWindow;
  const AudioContextClass = audioWindow.AudioContext || audioWindow.webkitAudioContext;
  if (!AudioContextClass) return;
  // A queued Apply starts later without a click, so keep the context that
  // the click made instead of replacing it with one WebKit leaves suspended.
  if (pending && pending.state !== "closed") {
    void pending.resume().catch(() => undefined);
    return;
  }
  try {
    pending = new AudioContextClass();
    void pending.resume().catch(() => undefined);
    logger.trace("Prepared the boot check audio context", { state: pending.state });
  } catch (error) {
    pending = null;
    logger.warn("Boot check audio context preparation failed", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
  }
};

/** Hand over the prepared context. The caller owns it and MUST close it. */
const takeBootCheckAudioContext = (): AudioContext | null => {
  const context = pending;
  pending = null;
  return context && context.state !== "closed" ? context : null;
};

/**
 * Give back a context that an aborted boot check never handed to a player,
 * so the next check can use it. A context a player used MUST be closed instead.
 */
const restoreBootCheckAudioContext = (context: AudioContext): void => {
  if (context.state === "closed") return;
  if (pending && pending !== context) {
    closeQuietly(context);
    return;
  }
  pending = context;
};

/** Close a prepared context that no boot check will use. */
const releaseBootCheckAudioContext = (): void => {
  if (pending) closeQuietly(pending);
  pending = null;
};

export {
  closeQuietly as closeBootCheckAudioContext,
  prepareBootCheckAudioContext,
  releaseBootCheckAudioContext,
  restoreBootCheckAudioContext,
  takeBootCheckAudioContext,
};
