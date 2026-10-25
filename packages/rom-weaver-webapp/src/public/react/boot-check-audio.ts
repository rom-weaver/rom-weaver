import { createLogger } from "../../lib/logging.ts";

const logger = createLogger("boot-check-audio");

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;
type AudioWindow = Window & typeof globalThis & { webkitAudioContext?: AudioContextConstructor };

/**
 * A boot check runs only after a user asked for it with a click: the Apply
 * button with the option on, or ticking the option under an Apply result.
 * That click arms one check for the form it came from and, where the browser
 * allows, makes the AudioContext the hidden player needs. Hidden workflow
 * panels stay mounted, so the owner keeps another form from taking the check.
 * Turning the option on in Settings arms nothing, so an existing result is
 * not checked until the next Apply.
 */
let armed: { owner: string | undefined } | null = null;
let pending: AudioContext | null = null;

const closeQuietly = (context: AudioContext) => {
  if (context.state === "closed") return;
  void context.close().catch((error) => {
    logger.warn("Boot check audio context cleanup failed", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
  });
};

const createContext = (): AudioContext | null => {
  if (typeof window === "undefined") return null;
  const audioWindow = window as AudioWindow;
  const AudioContextClass = audioWindow.AudioContext || audioWindow.webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    const context = new AudioContextClass();
    void context.resume().catch(() => undefined);
    logger.trace("Prepared the boot check audio context", { state: context.state });
    return context;
  } catch (error) {
    logger.warn("Boot check audio context preparation failed", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
    return null;
  }
};

/**
 * Arm the next boot check and create its AudioContext. The emulator core
 * stops after a few frames while its context is suspended. Chromium resumes a
 * context in any frame of a page that the user has clicked, but WebKit
 * resumes only a context created or resumed during the click itself, so
 * callers MUST call this synchronously from the click.
 */
const prepareBootCheckAudioContext = (owner?: string): void => {
  armed = { owner };
  // A queued Apply starts later without a click, so keep the context that
  // the click made instead of replacing it with one WebKit leaves suspended.
  if (pending && pending.state !== "closed") {
    void pending.resume().catch(() => undefined);
    return;
  }
  pending = createContext();
};

/**
 * Take the armed check. Returns null when no click in this owner's form armed
 * one. Otherwise the caller owns the returned context, which can be null when
 * the browser has no Web Audio, and MUST close it or give it back.
 */
const takeBootCheckAudioContext = (owner?: string): { context: AudioContext | null } | null => {
  if (!armed || armed.owner !== owner) return null;
  armed = null;
  const context = pending && pending.state !== "closed" ? pending : null;
  pending = null;
  return { context };
};

/**
 * Re-arm a check that was cancelled before it finished, so a remounted view
 * can run it again. Pass the context only when no player used it; a context
 * a player used is closed here instead.
 */
const restoreBootCheckAudioContext = (
  owner: string | undefined,
  context: AudioContext | null,
  unused: boolean,
): void => {
  armed = { owner };
  if (!context) return;
  if (!unused || context.state === "closed" || (pending && pending !== context)) {
    closeQuietly(context);
    return;
  }
  pending = context;
};

/**
 * Disarm the owner's check and close its context: Apply failed, or the option
 * went off. A check that another form armed stays armed.
 */
const releaseBootCheckAudioContext = (owner?: string): void => {
  if (armed && armed.owner !== owner) return;
  armed = null;
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
