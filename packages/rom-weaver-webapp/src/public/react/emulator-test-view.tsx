import { ArrowLeft, Maximize, Minimize } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  createProgressViewModel,
  createProgressViewModelFromEvent,
  formatByteSize,
  type ProgressViewModel,
} from "../../presentation/workflow-presentation.ts";
import { configureEmulatorSaveStorage, ensureEmulatorSaveBridge } from "../../storage/browser/emulator-saves.ts";
import { resolveAssetUrl } from "./asset-url.ts";
import { addEntry, disposeEntry, prepareEntry, useEmulatorSession } from "./emulator-session-store.ts";
import { createEmulatorDocument, createEmulatorGameIdentity } from "./components/emulator-document.ts";
import { FileProgress, Notice } from "./components/ds/feedback.tsx";
import { prefersReducedMotion } from "./components/ds/flat-transition.ts";
import { GhostSteps } from "./components/ds/ghost-steps.tsx";
import { StepSection } from "./components/ds/layout.tsx";
import {
  SampleTutorial,
  SampleTutorialStart,
  type SampleTutorialStep,
  useGuidedSampleStart,
} from "./components/ds/sample-tutorial.tsx";
import { UnifiedDropZone } from "./components/ds/unified-drop-zone.tsx";
import { loadEmulatorRom } from "./components/emulator-load-rom.ts";
import { getEmulatorJsAspectRatio, getEmulatorJsCore } from "./components/emulatorjs.ts";
import { ROM_FILE_EXTENSIONS } from "./file-classification.ts";
import { getFileInputAcceptAttributes } from "./file-input-accept.ts";
import {
  disposeEmulatorAudioContext,
  prepareEmulatorAudioContext,
  registerEmulatorStartRequestHandler,
} from "./emulator-audio-context.ts";
import { GUIDED_SAMPLE_HREFS } from "./guided-sample-start.ts";
import { useRomWeaverAssetBaseUrl, useRomWeaverSettings } from "./settings-context.tsx";

const WEBGL2_ERROR = "EmulatorJS testing requires a browser with WebGL 2.";
const TEST_SAMPLE_ASSET = "hello-world.nes";

const TEST_SAMPLE_TUTORIAL_STEPS: readonly SampleTutorialStep[] = [
  {
    actions: [
      ["drop", "Choose another ROM"],
      ["remove", "Stop and unload"],
    ],
    body: "The sample is a tiny homebrew NES ROM. Test also accepts your local ROMs and supported archives.",
    target: ".emulator-test-view .unified-drop-step",
    title: "Load a game",
  },
  {
    actions: [["play", "Emulator controls"]],
    body: "Start the game inside the player. Use its menu for controls, save states, and SRAM saves.",
    placement: "top",
    target: "#emulator-test-player",
    title: "Play the sample",
  },
];

let localEntryCounter = 0;

const hasWebgl2 = () => {
  if (typeof document === "undefined") return true;
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
};

const createLocalEntryId = (fileName: string) => {
  localEntryCounter += 1;
  return `local-${Date.now()}-${localEntryCounter}-${fileName}`;
};

type EmulatorError = { blocksPlayer?: boolean; detail: string; summary: string };

const errorDetail = (reason: unknown, fallback: string) =>
  reason instanceof Error && reason.message.trim() ? reason.message : fallback;

const isCoarsePointer = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

const progressValue = (progress: ProgressViewModel) => {
  if (progress.throughputText) return progress.throughputText;
  return progress.percent === null ? "working" : `${progress.percent}%`;
};

const hasActiveUserGesture = () => typeof navigator !== "undefined" && navigator.userActivation?.isActive === true;

type EmulatorTestViewProps = {
  /** False while another workflow tab is shown; the running game pauses until the view returns. */
  active?: boolean;
};

const EmulatorTestView = ({ active = true }: EmulatorTestViewProps) => {
  const { currentGameId, entries } = useEmulatorSession();
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  const settings = useRomWeaverSettings();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadAbortControllerRef = useRef<AbortController | null>(null);
  const sampleAbortControllerRef = useRef<AbortController | null>(null);
  const playerFrameRef = useRef<HTMLDivElement>(null);
  const fullscreenDialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EmulatorError | null>(null);
  const [loadProgress, setLoadProgress] = useState<ProgressViewModel | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [sampleError, setSampleError] = useState("");
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleTutorialActive, setSampleTutorialActive] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const currentGame = entries.find((entry) => entry.id === currentGameId) || null;
  const currentIdentity = useMemo(
    () =>
      currentGame?.checksum
        ? createEmulatorGameIdentity({
            checksum: currentGame.checksum,
          })
        : null,
    [currentGame],
  );
  const currentGameName = currentIdentity?.gameName;
  const dataUrl =
    typeof document === "undefined" ? "/emulatorjs/data/" : new URL("emulatorjs/data/", document.baseURI).href;

  useEffect(() => {
    ensureEmulatorSaveBridge();
  }, []);

  useLayoutEffect(() => {
    configureEmulatorSaveStorage(settings.emulatorSaveStorageEnabled !== false);
  }, [settings.emulatorSaveStorageEnabled]);

  useEffect(
    () =>
      registerEmulatorStartRequestHandler((requestedGameName) => {
        if (!currentIdentity || (requestedGameName && requestedGameName !== currentIdentity.gameName)) return false;
        if (!prepareEmulatorAudioContext(currentIdentity.gameName)) return false;
        const startButton = iframeRef.current?.contentDocument?.querySelector<HTMLElement>(".ejs_start_button");
        startButton?.click();
        return true;
      }),
    [currentIdentity],
  );

  useEffect(() => {
    if (!currentGameName) return undefined;
    return () => disposeEmulatorAudioContext(currentGameName);
  }, [currentGameName]);

  useEffect(() => {
    if (!currentIdentity) return undefined;
    const sendVisibility = (kind: "visibility-pause" | "visibility-resume") => {
      iframeRef.current?.contentWindow?.postMessage(
        { gameId: currentIdentity.gameName, kind, source: "rom-weaver-emulator" },
        "*",
      );
    };
    const hidden = () => document.hidden || !active;
    const handleVisibilityChange = () => sendVisibility(hidden() ? "visibility-pause" : "visibility-resume");
    document.addEventListener("visibilitychange", handleVisibilityChange);
    // Leaving for another workflow tab hides the panel without a visibility
    // event, so the active flip drives the same pause/resume the tab switch does.
    handleVisibilityChange();
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [currentIdentity, active]);

  useEffect(() => {
    if (!currentGame) return;
    if (hasWebgl2()) return;
    setError({
      blocksPlayer: true,
      detail: "Enable hardware acceleration, or use a browser that supports WebGL 2.",
      summary: WEBGL2_ERROR,
    });
  }, [currentGame]);

  // Each mount gets its own object URL: EmulatorJS revokes the game URL it is
  // handed after reading it, so a URL stored on the entry would be dead by the
  // second play.
  const currentBlob = currentGame?.blob || null;
  const [gameUrl, setGameUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!currentBlob || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      setGameUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(currentBlob);
    setGameUrl(url);
    return () => {
      setGameUrl(null);
      URL.revokeObjectURL(url);
    };
  }, [currentBlob]);

  useEffect(() => {
    if (!currentGame || currentGame.blob || !currentGame.artifact) return;
    let cancelled = false;
    setPreparing(true);
    void prepareEntry(currentGame.id)
      .catch((reason) => {
        if (!cancelled) {
          setError({
            detail: errorDetail(reason, "The retained ROM could not be read."),
            summary: `Could not open ${currentGame.fileName}.`,
          });
          disposeEntry(currentGame.id);
        }
        return null;
      })
      .finally(() => {
        if (!cancelled) setPreparing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentGame]);

  useEffect(() => {
    const dialog = fullscreenDialogRef.current;
    if (!dialog || typeof dialog.showModal !== "function") return undefined;
    // The top layer is what escapes the panel's `overflow: clip`; a plain fixed
    // player is clipped away by it. The dialog wraps the player at all times so
    // opening it never reparents the iframe, which would reload the game.
    if (pseudoFullscreen && !dialog.open) dialog.showModal();
    if (!pseudoFullscreen && dialog.open) dialog.close();
    const handleClose = () => setPseudoFullscreen(false);
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [pseudoFullscreen]);

  useEffect(() => {
    if (typeof document === "undefined" || !pseudoFullscreen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [pseudoFullscreen]);

  // Leaving the game must not strand the page in the pseudo-fullscreen state.
  useEffect(() => {
    if (!currentGame) setPseudoFullscreen(false);
  }, [currentGame]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const handleFullscreenChange = () => setFullscreen(document.fullscreenElement === playerFrameRef.current);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (typeof document === "undefined") return;
    const frame = playerFrameRef.current;
    // iOS WebKit exposes the Fullscreen API on <video> only, so requesting it on
    // the player throws and the button does nothing. Fall back to filling the
    // viewport ourselves there.
    if (!frame || typeof frame.requestFullscreen !== "function") {
      setPseudoFullscreen((active) => !active);
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void frame.requestFullscreen().catch(() => undefined);
  }, []);

  const handleFiles = useCallback(
    async (files: File[], prepareAudio = true): Promise<boolean> => {
      const file = files[0];
      if (!file || busy) return false;
      if (!hasWebgl2()) {
        setError({
          blocksPlayer: true,
          detail: "Enable hardware acceleration, or use a browser that supports WebGL 2.",
          summary: WEBGL2_ERROR,
        });
        return false;
      }
      const abortController = new AbortController();
      loadAbortControllerRef.current = abortController;
      setBusy(true);
      setError(null);
      setLoadProgress(
        createProgressViewModel({
          fallbackLabel: `Preparing ${file.name}...`,
          hasProgress: true,
          percent: null,
          stage: "decompress",
        }),
      );
      try {
        const loaded = await loadEmulatorRom(file, file.name, {
          onProgress: (progress) => {
            if (abortController.signal.aborted || loadAbortControllerRef.current !== abortController) return;
            setLoadProgress(
              createProgressViewModelFromEvent(progress, {
                fallbackLabel: `Extracting ${file.name}...`,
                hasProgress: true,
              }),
            );
          },
          signal: abortController.signal,
        });
        if (abortController.signal.aborted || loadAbortControllerRef.current !== abortController) return false;
        const core = getEmulatorJsCore(undefined, loaded.fileName);
        if (!core) {
          setError({
            detail: "No emulator core is available for this file. Choose a supported ROM.",
            summary: `Cannot play ${loaded.fileName}.`,
          });
          return false;
        }
        const entry = {
          blob: loaded.blob,
          checksum: loaded.checksum,
          core,
          fileName: loaded.fileName,
          id: createLocalEntryId(loaded.fileName),
          sizeBytes: loaded.blob.size,
          source: "local" as const,
        };
        if (prepareAudio) prepareEmulatorAudioContext(createEmulatorGameIdentity(entry).gameName);
        addEntry(entry);
        return true;
      } catch (reason) {
        if (abortController.signal.aborted || loadAbortControllerRef.current !== abortController) return false;
        setError({
          detail: errorDetail(reason, "The ROM could not be prepared for the emulator."),
          summary: `Could not load ${file.name}.`,
        });
        return false;
      } finally {
        if (loadAbortControllerRef.current === abortController) {
          loadAbortControllerRef.current = null;
          setLoadProgress(null);
          setBusy(false);
        }
      }
    },
    [busy],
  );

  const cancelSampleLoad = useCallback(() => {
    const sampleAbortController = sampleAbortControllerRef.current;
    if (!sampleAbortController) return;
    sampleAbortController.abort();
    sampleAbortControllerRef.current = null;
    loadAbortControllerRef.current?.abort();
    loadAbortControllerRef.current = null;
    setBusy(false);
    setLoadProgress(null);
    setSampleLoading(false);
  }, []);

  const loadTestSample = useCallback(
    async (prepareAudio: boolean) => {
      cancelSampleLoad();
      const abortController = new AbortController();
      sampleAbortControllerRef.current = abortController;
      setSampleLoading(true);
      setSampleError("");
      try {
        const response = await fetch(resolveAssetUrl(assetBaseUrl, TEST_SAMPLE_ASSET), {
          signal: abortController.signal,
        });
        if (abortController.signal.aborted || sampleAbortControllerRef.current !== abortController) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const file = new File([await response.blob()], TEST_SAMPLE_ASSET, { type: "application/octet-stream" });
        if (abortController.signal.aborted || sampleAbortControllerRef.current !== abortController) return;
        const playable = await handleFiles([file], prepareAudio);
        if (abortController.signal.aborted) return;
        if (!playable) setSampleTutorialActive(false);
      } catch {
        if (abortController.signal.aborted) return;
        setSampleTutorialActive(false);
        setSampleError("Could not load the sample. Try again.");
      } finally {
        if (sampleAbortControllerRef.current === abortController) {
          sampleAbortControllerRef.current = null;
          setSampleLoading(false);
        }
      }
    },
    [assetBaseUrl, cancelSampleLoad, handleFiles],
  );

  const startTestSample = useCallback(() => {
    const prepareAudio = hasActiveUserGesture();
    if (prepareAudio) prepareEmulatorAudioContext();
    setSampleTutorialActive(true);
    void loadTestSample(prepareAudio);
  }, [loadTestSample]);

  const closeTestSample = useCallback(() => {
    cancelSampleLoad();
    setSampleTutorialActive(false);
  }, [cancelSampleLoad]);

  useGuidedSampleStart("test", startTestSample, closeTestSample);

  const currentCore = currentGame
    ? currentGame.core || getEmulatorJsCore(currentGame.platform, currentGame.fileName)
    : null;
  const webglBlocked = error?.blocksPlayer === true;
  const canPlay = Boolean(currentGame && currentCore && gameUrl && currentIdentity && !webglBlocked);
  const workflowEmpty = !(currentGame || busy);
  const showPlayer = Boolean(currentGame);
  const sampleTutorialReady = !sampleLoading && currentGame?.fileName === TEST_SAMPLE_ASSET;

  const scrolledGameRef = useRef<string | null>(null);
  useEffect(() => {
    if (!(active && canPlay && currentGame && isCoarsePointer())) return undefined;
    if (scrolledGameRef.current === currentGame.id) return undefined;
    scrolledGameRef.current = currentGame.id;
    const frame = requestAnimationFrame(() => {
      const player = playerFrameRef.current;
      if (typeof player?.scrollIntoView !== "function") return;
      player.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "center",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, canPlay, currentGame]);

  useEffect(() => {
    if (!(active && error)) return undefined;
    const frame = requestAnimationFrame(() => {
      const notice = document.getElementById("emulator-test-error");
      if (typeof notice?.scrollIntoView !== "function") return;
      notice.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "nearest",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, error]);

  useEffect(
    () => () => {
      sampleAbortControllerRef.current?.abort();
      sampleAbortControllerRef.current = null;
      loadAbortControllerRef.current?.abort();
      loadAbortControllerRef.current = null;
    },
    [],
  );

  const stopGame = () => {
    loadAbortControllerRef.current?.abort();
    loadAbortControllerRef.current = null;
    if (currentGame) disposeEntry(currentGame.id);
    setBusy(false);
    setError(null);
    setLoadProgress(null);
  };

  return (
    <div className="emulator-test-view">
      {sampleTutorialActive ? (
        <SampleTutorial
          loadingBody="RomWeaver is loading a tiny homebrew NES ROM for the Test guide."
          onClose={closeTestSample}
          ready={sampleTutorialReady}
          steps={TEST_SAMPLE_TUTORIAL_STEPS}
        />
      ) : null}
      <UnifiedDropZone
        accept={getFileInputAcceptAttributes().unifiedRom}
        addLabel="Choose another ROM"
        afterDropZone={
          loadProgress ? (
            <div aria-live="polite" className="emulator-load-progress">
              <FileProgress
                indeterminate={loadProgress.indeterminate}
                label={loadProgress.label || "Preparing the ROM..."}
                percent={loadProgress.visualPercent}
                value={progressValue(loadProgress)}
              />
            </div>
          ) : workflowEmpty ? (
            <SampleTutorialStart
              downloadHref={resolveAssetUrl(assetBaseUrl, TEST_SAMPLE_ASSET)}
              downloadLabel="Download the sample ROM"
              downloadName={TEST_SAMPLE_ASSET}
              error={sampleError}
              guideHref={GUIDED_SAMPLE_HREFS.test}
              label="Start guided Test"
              loading={sampleLoading}
              onStart={startTestSample}
              startAction="play"
            />
          ) : undefined
        }
        beforeDropZone={
          error ? (
            <Notice
              id="emulator-test-error"
              level="error"
              onDismiss={error.blocksPlayer ? undefined : () => setError(null)}
            >
              <b>{error.summary}</b> {error.detail}
            </Notice>
          ) : undefined
        }
        big={workflowEmpty}
        disabled={busy || sampleLoading}
        heroLabel="Drop a ROM or choose a file"
        heroLabelCoarse="Choose a ROM file"
        id="emulator-test-input"
        info={<p>Choosing another ROM stops and replaces the current game.</p>}
        inputId="emulator-test-file-input"
        lead={{ line1: "ui.hero.testThesis", line2: "ui.hero.testThesis2" }}
        multiple={false}
        onBrowseStart={() => prepareEmulatorAudioContext()}
        onDropStart={() => prepareEmulatorAudioContext()}
        onFiles={(files) => void handleFiles(files)}
        supported={[
          { extensions: ROM_FILE_EXTENSIONS, label: "ROMs" },
          { extensions: ["zip", "7z"], label: "Archives" },
        ]}
        title="Load a game"
      />

      {showPlayer ? (
        <>
          <StepSection
            headerExtra={
              <div className="emulator-player-actions">
                {currentGame?.source === "apply" ? (
                  <a className="btn ghost slim" href="apply">
                    <ArrowLeft aria-hidden="true" /> Back to Apply
                  </a>
                ) : null}
                <button aria-label="Stop and unload game" className="btn ghost slim" onClick={stopGame} type="button">
                  Stop
                </button>
                {canPlay ? (
                  <>
                    <button
                      aria-label={fullscreen || pseudoFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                      className="btn ghost slim emulator-fullscreen-btn"
                      onClick={toggleFullscreen}
                      type="button"
                    >
                      {fullscreen || pseudoFullscreen ? (
                        <Minimize aria-hidden="true" />
                      ) : (
                        <Maximize aria-hidden="true" />
                      )}
                    </button>
                  </>
                ) : null}
              </div>
            }
            id="emulator-test-player"
            meta={
              currentGame ? (
                <>
                  <span className="emulator-current-game" title={currentGame.fileName}>
                    {currentGame.fileName}
                  </span>
                  <span>{formatByteSize(currentGame.sizeBytes)}</span>
                  {currentGame.checksum ? (
                    <span className="emulator-current-checksum" title={`ROM SHA-1: ${currentGame.checksum}`}>
                      SHA-1 {currentGame.checksum.slice(0, 12)}…
                    </span>
                  ) : null}
                </>
              ) : undefined
            }
            num="0x02"
            title="Play"
          >
            <div className="card emulator-player">
              {currentGame && currentCore && gameUrl && currentIdentity && !webglBlocked ? (
                <dialog className="emulator-fullscreen-dialog" ref={fullscreenDialogRef}>
                  <div
                    className={
                      pseudoFullscreen ? "emulator-player-frame is-pseudo-fullscreen" : "emulator-player-frame"
                    }
                    ref={playerFrameRef}
                    style={{ "--emulator-aspect": getEmulatorJsAspectRatio(currentCore) } as CSSProperties}
                  >
                    <iframe
                      allow="autoplay; fullscreen; gamepad"
                      allowFullScreen
                      key={`${currentGame.id}:${gameUrl}`}
                      ref={iframeRef}
                      referrerPolicy="no-referrer"
                      srcDoc={createEmulatorDocument(dataUrl, gameUrl, currentIdentity.gameName, currentCore, {
                        gameId: currentIdentity.gameId,
                        gameLabel: currentGame.fileName,
                      })}
                      title={`EmulatorJS test for ${currentGame.fileName}`}
                    />
                    {pseudoFullscreen ? (
                      <button
                        aria-label="Exit fullscreen"
                        className="btn ghost slim emulator-pseudo-exit"
                        onClick={() => setPseudoFullscreen(false)}
                        type="button"
                      >
                        <Minimize aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </dialog>
              ) : currentGame && currentCore && preparing ? (
                <div className="emulator-player-loading">
                  <FileProgress indeterminate label="Preparing the ROM..." value="working" />
                </div>
              ) : currentGame && !webglBlocked ? (
                <div className="emulator-player-loading" />
              ) : null}
            </div>
          </StepSection>
        </>
      ) : (
        <GhostSteps steps={[{ num: "0x02", title: "Play" }]} />
      )}
    </div>
  );
};

export { EmulatorTestView };
