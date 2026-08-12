import { createLogger } from "../../lib/logging.ts";
import { isAppleMobileWebKit } from "../../platform/shared/webkit-runtime.ts";

const EMULATOR_AUDIO_SAMPLE_RATE = 48_000;
const logger = createLogger("emulator-audio-context");

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;
type PreparedAudioContext = {
  context: AudioContext;
  gameName?: string;
};
type EmulatorAudioBridge = {
  hasPrepared: (gameName: string) => boolean;
  takePrepared: (gameName: string, options?: AudioContextOptions) => AudioContext | null;
};
type EmulatorAudioWindow = Window &
  typeof globalThis & {
    __romWeaverEmulatorAudio?: EmulatorAudioBridge;
    webkitAudioContext?: AudioContextConstructor;
  };
type NavigatorWithAudioSession = Navigator & {
  audioSession?: { type: string };
};

let activeContexts = new Map<string, AudioContext>();
let pendingContext: PreparedAudioContext | null = null;
let startRequestHandler: ((gameName?: string) => boolean) | null = null;

const closeContext = (context: AudioContext, gameName?: string) => {
  if (context.state === "closed") return;
  void context.close().catch((error) => {
    logger.warn("Emulator audio context cleanup failed", {
      gameName,
      message: error instanceof Error ? error.message : String(error || ""),
    });
  });
};

const closePendingContext = () => {
  if (!pendingContext) return;
  closeContext(pendingContext.context, pendingContext.gameName);
  pendingContext = null;
};

const isAppleMobileRuntime = (windowObject: Window) =>
  isAppleMobileWebKit({
    maxTouchPoints: windowObject.navigator.maxTouchPoints,
    platform: windowObject.navigator.platform,
    userAgent: windowObject.navigator.userAgent,
  });

const getAudioContextConstructor = (windowObject: Window): AudioContextConstructor | null => {
  const audioWindow = windowObject as EmulatorAudioWindow;
  return audioWindow.AudioContext || audioWindow.webkitAudioContext || null;
};

const configurePlaybackAudioSession = (navigatorObject: Navigator) => {
  try {
    const audioSession = (navigatorObject as NavigatorWithAudioSession).audioSession;
    if (!audioSession || audioSession.type === "playback") return;
    // WebKit defaults Web Audio to ambient, which silent mode mutes. Emulator audio MUST use playback.
    // https://bugs.webkit.org/show_bug.cgi?id=237322
    audioSession.type = "playback";
    logger.trace("Configured the iOS audio session for EmulatorJS playback");
  } catch (error) {
    logger.warn("Emulator audio session configuration failed", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
  }
};

const resumeContext = (context: AudioContext, gameName?: string) => {
  if (context.state === "closed" || context.state === "running") return;
  const resume = () =>
    context.resume().catch((error) => {
      logger.warn("Emulator audio context resume failed", {
        gameName,
        message: error instanceof Error ? error.message : String(error || ""),
      });
    });
  if (context.state === "interrupted") {
    // WebKit can leave a context interrupted after iOS loses focus. The context MUST suspend before it resumes.
    // https://bugs.webkit.org/show_bug.cgi?id=276016
    void context
      .suspend()
      .catch((error) => {
        logger.warn("Interrupted emulator audio context suspend failed", {
          gameName,
          message: error instanceof Error ? error.message : String(error || ""),
        });
      })
      .then(resume);
    return;
  }
  void resume();
};

const prepareEmulatorAudioContext = (gameName?: string): boolean => {
  if (typeof window === "undefined" || !isAppleMobileRuntime(window)) return false;
  configurePlaybackAudioSession(window.navigator);

  if (gameName) {
    const active = activeContexts.get(gameName);
    if (active && active.state !== "closed") {
      closePendingContext();
      resumeContext(active, gameName);
      return true;
    }
    for (const [activeGameName, context] of activeContexts) {
      closeContext(context, activeGameName);
      activeContexts.delete(activeGameName);
    }
  }

  if (pendingContext) {
    let canReuse = pendingContext.gameName === gameName;
    if (!gameName) canReuse = true;
    if (!pendingContext.gameName) canReuse = true;
    if (canReuse) {
      if (gameName) pendingContext.gameName = gameName;
      resumeContext(pendingContext.context, pendingContext.gameName);
      return true;
    }
  }

  closePendingContext();
  const AudioContextClass = getAudioContextConstructor(window);
  if (!AudioContextClass) return false;

  try {
    // WebKit authorizes Web Audio for the AudioContext document. The parent MUST create it during the user action.
    // https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp
    const context = new AudioContextClass({ latencyHint: "interactive", sampleRate: EMULATOR_AUDIO_SAMPLE_RATE });
    pendingContext = { context, gameName };
    resumeContext(context, gameName);
    logger.trace("Prepared parent-owned EmulatorJS audio context", {
      gameName,
      sampleRate: context.sampleRate,
      state: context.state,
    });
    return true;
  } catch (error) {
    logger.warn("Emulator audio context preparation failed", {
      gameName,
      message: error instanceof Error ? error.message : String(error || ""),
    });
    return false;
  }
};

const hasPreparedEmulatorAudioContext = (gameName: string): boolean =>
  Boolean(pendingContext && (!pendingContext.gameName || pendingContext.gameName === gameName));

const takePreparedEmulatorAudioContext = (gameName: string, options?: AudioContextOptions): AudioContext | null => {
  if (!pendingContext || (pendingContext.gameName && pendingContext.gameName !== gameName)) return null;
  const { context } = pendingContext;
  if (options?.sampleRate && context.sampleRate !== options.sampleRate) {
    logger.warn("Prepared EmulatorJS audio context has an incompatible sample rate", {
      actualSampleRate: context.sampleRate,
      gameName,
      requestedSampleRate: options.sampleRate,
    });
    closePendingContext();
    return null;
  }

  pendingContext = null;
  activeContexts.set(gameName, context);
  logger.trace("EmulatorJS claimed the parent-owned audio context", {
    gameName,
    sampleRate: context.sampleRate,
  });
  return context;
};

const disposeEmulatorAudioContext = (gameName: string) => {
  const active = activeContexts.get(gameName);
  if (active) {
    closeContext(active, gameName);
    activeContexts.delete(gameName);
  }
  if (pendingContext?.gameName === gameName) closePendingContext();
};

const disposeAllEmulatorAudioContexts = () => {
  closePendingContext();
  for (const [gameName, context] of activeContexts) closeContext(context, gameName);
  activeContexts = new Map();
};

const registerEmulatorStartRequestHandler = (handler: (gameName?: string) => boolean) => {
  startRequestHandler = handler;
  return () => {
    if (startRequestHandler === handler) startRequestHandler = null;
  };
};

const requestEmulatorStartFromUserAction = (gameName?: string): boolean => startRequestHandler?.(gameName) ?? false;

if (typeof window !== "undefined") {
  const audioWindow = window as EmulatorAudioWindow;
  audioWindow.__romWeaverEmulatorAudio = {
    hasPrepared: hasPreparedEmulatorAudioContext,
    takePrepared: takePreparedEmulatorAudioContext,
  };
  window.addEventListener("pagehide", disposeAllEmulatorAudioContexts, { once: true });
}

export {
  disposeAllEmulatorAudioContexts,
  disposeEmulatorAudioContext,
  prepareEmulatorAudioContext,
  registerEmulatorStartRequestHandler,
  requestEmulatorStartFromUserAction,
};
