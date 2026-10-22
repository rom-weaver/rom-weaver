import { describeAgentSource, useAgentWorkflow } from "../../webapp/agent/workflow-registry.ts";
import { ArrowLeft, Maximize, Minimize, Save, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  createProgressViewModel,
  createProgressViewModelFromEvent,
  formatByteSize,
  type ProgressViewModel,
} from "../../presentation/workflow-presentation.ts";
import {
  clearPendingTestSave,
  configureEmulatorSaveStorage,
  loadDroppedSram,
  registerEmulatorSaveBridge,
  readImportBytes,
  readPendingTestSaves,
  setEmulatorSavePreview,
  stagePendingTestSave,
  type PendingTestSave,
} from "../../storage/browser/emulator-saves.ts";
import { bumpOfflineWarmupPriority } from "../../webapp/pwa/offline-warmup-client.ts";
import { resolveAssetUrl } from "./asset-url.ts";
import {
  addEntry,
  disposeEntry,
  prepareEntry,
  restartCurrentGameWithSave,
  useEmulatorSession,
  type EmulatorSessionEntry,
} from "./emulator-session-store.ts";
import { createEmulatorDocument, createEmulatorGameIdentity } from "./components/emulator-document.ts";
import { join } from "./components/ds/cx.ts";
import { FileProgress, Notice } from "./components/ds/feedback.tsx";
import { prefersReducedMotion } from "./components/ds/flat-transition.ts";
import { GhostSteps } from "./components/ds/ghost-steps.tsx";
import { ChecksumRow } from "./components/ds/checksum-list.tsx";
import { StepSection } from "./components/ds/layout.tsx";
import {
  SampleTutorial,
  SampleTutorialStart,
  type SampleTutorialStep,
  useGuidedSampleStart,
} from "./components/ds/sample-tutorial.tsx";
import { UnifiedDropZone } from "./components/ds/unified-drop-zone.tsx";
import { loadEmulatorRom } from "./components/emulator-load-rom.ts";
import {
  FDS_BIOS_ISSUE_URL,
  getEmulatorJsAspectRatio,
  getEmulatorJsCore,
  getSaveFileCore,
  hasFdsDiskSignature,
  requiresUnsuppliedBios,
} from "./components/emulatorjs.ts";
import { isSaveFileName } from "./drop-destination.ts";
import { ROM_FILE_EXTENSIONS } from "./file-classification.ts";
import { getFileInputAcceptAttributes } from "./file-input-accept.ts";
import {
  disposeEmulatorAudioContext,
  prepareEmulatorAudioContext,
  registerEmulatorStartRequestHandler,
} from "./emulator-audio-context.ts";
import { resolveGuidedSampleHref } from "./guided-sample-start.ts";
import { useRomWeaverAssetBaseUrl, useRomWeaverSettings, useUiLocalizer } from "./settings-context.tsx";
import type { PageFileDrop } from "./public-types.ts";
import { usePageDropForwarder } from "./workflow-form-effects.ts";
import { WORKFLOW_GUIDES } from "./workflow-guides.ts";

const WEBGL2_ERROR = "EmulatorJS testing requires a browser with WebGL 2.";
const TEST_SAMPLE_ASSET = "hello-world.nes";

const getTestSampleTutorialSteps = (localizer: ReturnType<typeof useUiLocalizer>): readonly SampleTutorialStep[] => [
  {
    actions: [
      ["drop", localizer.message("ui.test.tutorial.chooseRom")],
      ["remove", localizer.message("ui.test.tutorial.unload")],
    ],
    body: localizer.message("ui.test.tutorial.load.body"),
    target: ".emulator-test-view .unified-drop-step",
    title: localizer.message("ui.test.tutorial.load.title"),
  },
  {
    actions: [["play", localizer.message("ui.test.tutorial.controls")]],
    body: localizer.message("ui.test.tutorial.play.body"),
    placement: "top",
    target: "#emulator-test-player",
    title: localizer.message("ui.test.tutorial.play.title"),
    tryIt: localizer.message("ui.test.tutorial.play.tryIt"),
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
  /** Files dropped on the page or routed here from another tab. */
  pageDrop?: PageFileDrop | null;
};

const EmulatorTestView = ({ active = true, pageDrop }: EmulatorTestViewProps) => {
  const { currentGameId, entries } = useEmulatorSession();
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  const localizer = useUiLocalizer();
  const settings = useRomWeaverSettings();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadAbortControllerRef = useRef<AbortController | null>(null);
  const sampleAbortControllerRef = useRef<AbortController | null>(null);
  const playerFrameRef = useRef<HTMLDivElement>(null);
  const fullscreenDialogRef = useRef<HTMLDialogElement>(null);
  const pendingReadRevisionRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EmulatorError | null>(null);
  const [loadProgress, setLoadProgress] = useState<ProgressViewModel | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [sampleError, setSampleError] = useState("");
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleTutorialActive, setSampleTutorialActive] = useState(false);
  const [pendingSave, setPendingSave] = useState<PendingTestSave>();
  // The game whose dropped save plays as a preview, so its in-game progress is not stored.
  const [previewOnlyGameId, setPreviewOnlyGameId] = useState<string>();
  const [ignoredSaves, setIgnoredSaves] = useState<{ names: string[]; used: string }>();
  const [saveLoadResult, setSaveLoadResult] = useState<{
    gameName: string;
    revision: number;
    status: "loaded" | "failed";
  }>();
  const [fullscreen, setFullscreen] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const currentGame = entries.find((entry) => entry.id === currentGameId) || null;
  const currentIdentity = useMemo(
    () =>
      currentGame?.checksum
        ? createEmulatorGameIdentity({
            checksum: currentGame.checksum,
            core: currentGame.core,
            fileName: currentGame.fileName,
          })
        : null,
    [currentGame],
  );
  const saveId = currentIdentity?.saveId;
  const loadedGameRef = useRef<
    { game: EmulatorSessionEntry; identity: NonNullable<typeof currentIdentity> } | undefined
  >(undefined);
  loadedGameRef.current = currentGame && currentIdentity ? { game: currentGame, identity: currentIdentity } : undefined;
  const registerPlayerFrame = useCallback(
    (frame: HTMLIFrameElement | null) => {
      iframeRef.current = frame;
      if (!(frame && saveId)) return undefined;
      const unregister = registerEmulatorSaveBridge(frame, saveId);
      return () => {
        unregister();
        iframeRef.current = null;
      };
    },
    [saveId],
  );
  const currentGameName = currentIdentity?.gameName;
  const dataUrl =
    typeof document === "undefined" ? "/emulatorjs/data/" : new URL("emulatorjs/data/", document.baseURI).href;

  useEffect(() => {
    // The test view is about to pull EmulatorJS assets; move them to the front
    // of the offline warm-up so its low-priority queue works for, not against,
    // this session.
    bumpOfflineWarmupPriority({ kind: "emulatorjs" });
  }, []);

  useEffect(() => {
    if (!active) return;
    let current = true;
    const revision = pendingReadRevisionRef.current;
    void readPendingTestSaves()
      .then(([save]) => {
        if (current && revision === pendingReadRevisionRef.current) setPendingSave(save);
      })
      .catch((reason) => {
        if (current && revision === pendingReadRevisionRef.current) {
          setError({
            detail: errorDetail(reason, "The saved upload could not be read."),
            summary: "Could not load the saved upload.",
          });
        }
      });
    return () => {
      current = false;
    };
  }, [active]);

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
        { gameId: currentIdentity.saveId, kind, source: "rom-weaver-emulator" },
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
  const savePreviewRevision = currentGame?.savePreviewRevision ?? 0;
  useEffect(() => {
    if (!currentIdentity) return undefined;
    if (!savePreviewRevision) return undefined;
    const handleSaveLoad = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!event.data || typeof event.data !== "object") return;
      const message = event.data as { source?: unknown; gameId?: unknown; kind?: unknown };
      if (message.source !== "rom-weaver-emulator" || message.gameId !== currentIdentity.saveId) return;
      if (message.kind !== "sram-loaded" && message.kind !== "sram-load-failed") return;
      setSaveLoadResult({
        gameName: currentIdentity.gameName,
        revision: savePreviewRevision,
        status: message.kind === "sram-loaded" ? "loaded" : "failed",
      });
    };
    window.addEventListener("message", handleSaveLoad);
    return () => window.removeEventListener("message", handleSaveLoad);
  }, [currentIdentity, savePreviewRevision]);
  const saveLoadStatus =
    saveLoadResult?.gameName === currentIdentity?.gameName && saveLoadResult?.revision === savePreviewRevision
      ? saveLoadResult.status
      : undefined;
  let saveLoadMessage = "Waiting for EmulatorJS to load the save bytes.";
  if (saveLoadStatus === "loaded") {
    saveLoadMessage =
      previewOnlyGameId === currentGame?.id
        ? "Save loaded and game restarted as a preview: progress in it is not stored. Import it in Saves & storage to keep it."
        : "Save loaded and game restarted. Check the game's Continue menu.";
  } else if (saveLoadStatus === "failed") {
    saveLoadMessage = "EmulatorJS could not load the save bytes. Try a save made by this game.";
  }
  const [gameUrlState, setGameUrlState] = useState<{ url: string; revision: number } | null>(null);
  useEffect(() => {
    if (!currentBlob || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      setGameUrlState(null);
      return undefined;
    }
    const url = URL.createObjectURL(currentBlob);
    setGameUrlState({ revision: savePreviewRevision, url });
    return () => {
      setGameUrlState(null);
      URL.revokeObjectURL(url);
    };
  }, [currentBlob, savePreviewRevision]);
  const gameUrl = gameUrlState?.revision === savePreviewRevision ? gameUrlState.url : null;

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
    async (files: File[], prepareAudio = true, save?: File, keepHeldSave = false): Promise<boolean> => {
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
        if (loaded.blob.size === 0) {
          if (currentGameId) disposeEntry(currentGameId);
          setError({
            detail: "The file is empty (0 bytes). Choose a ROM that has data.",
            summary: `Cannot play ${loaded.fileName}.`,
          });
          return false;
        }
        const core = getEmulatorJsCore(loaded.platform, loaded.fileName);
        if (!core) {
          // The new pick replaces the session even when it cannot play, so drop the previous game's player.
          if (currentGameId) disposeEntry(currentGameId);
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
          platform: loaded.platform,
          sizeBytes: loaded.blob.size,
          source: "local" as const,
        };
        const cancelled = () => abortController.signal.aborted || loadAbortControllerRef.current !== abortController;
        const held = await readPendingTestSaves();
        if (cancelled()) return false;
        pendingReadRevisionRef.current += 1;
        setPendingSave(held[0]);
        // A held save names its system by platform (Save editor) or, for a raw drop, by file extension. One that
        // names neither yields to a save dropped with this ROM and to the guided sample.
        const heldFits = (candidate: PendingTestSave) => {
          const heldCore = candidate.platform
            ? getEmulatorJsCore(candidate.platform)
            : getSaveFileCore(candidate.fileName);
          const systemFits = heldCore ? heldCore === core : !(candidate.platform || save || keepHeldSave);
          return (
            systemFits && (!candidate.romSha1 || candidate.romSha1.toLowerCase() === loaded.checksum.toLowerCase())
          );
        };
        // A save dropped with the ROM wins; a fitting held save then stays held for a later load.
        const matched = save ? undefined : held.find(heldFits);
        // A save the visitor dropped is theirs to keep, so it is stored. The Save editor's copy stays a
        // preview: it is a test of an edit, not a replacement. The file is read before anything changes, so
        // an unreadable save fails the load without losing the held save.
        let droppedBytes: Uint8Array | undefined;
        if (matched) droppedBytes = matched.platform ? undefined : matched.bytes;
        else if (save) droppedBytes = await readImportBytes(save);
        if (cancelled()) return false;
        const identity = createEmulatorGameIdentity(entry);
        // Stored before the player mounts so it boots once, with the save already in place.
        const droppedOutcome = droppedBytes
          ? await loadDroppedSram(identity.saveId, droppedBytes, loaded.fileName)
          : undefined;
        if (cancelled()) return false;
        if (matched) await clearPendingTestSave(matched.slot);
        if (cancelled()) return false;
        if (prepareAudio) prepareEmulatorAudioContext(identity.gameName);
        const previewBytes =
          droppedOutcome === "preview" ? droppedBytes : matched?.platform ? matched.bytes : undefined;
        addEntry({ ...entry, ...(droppedBytes || previewBytes ? { savePreviewRevision: 1 } : {}) });
        // Replacing the current game with the same ROM clears that ROM's preview, so it is set after addEntry.
        if (previewBytes) setEmulatorSavePreview(identity.saveId, previewBytes);
        setPreviewOnlyGameId(droppedOutcome === "preview" ? entry.id : undefined);
        const remaining = held.find((candidate) => candidate !== matched);
        setPendingSave(remaining);
        const shown = held[0];
        const shownCore = shown?.platform
          ? getEmulatorJsCore(shown.platform)
          : shown && getSaveFileCore(shown.fileName);
        if (shown && shown !== matched && shownCore && !save) {
          setError({
            detail: shown.romSha1
              ? "Choose the ROM linked to the uploaded save."
              : "Choose a ROM for the save's game system.",
            summary: `${loaded.fileName} does not match ${shown.fileName}.`,
          });
        }
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
    [busy, currentGameId],
  );
  // A drop can carry a ROM and its battery save together; the save rides along with the ROM.
  // A save dropped alone waits for the next ROM, like a save the Save editor hands over. It survives a
  // reload only while save storage is on.
  const applySaveToCurrentGame = useCallback(
    async (save: File): Promise<boolean> => {
      const game = loadedGameRef.current?.game;
      const identity = loadedGameRef.current?.identity;
      if (!(game?.core && identity) || busy) return false;
      const saveCore = getSaveFileCore(save.name);
      if (saveCore && saveCore !== game.core) return false;
      const bytes = await readImportBytes(save);
      const outcome = await loadDroppedSram(identity.saveId, bytes, game.fileName);
      if (loadedGameRef.current?.game.id !== game.id) return true;
      setPreviewOnlyGameId(outcome === "preview" ? game.id : undefined);
      restartCurrentGameWithSave(game.id);
      return true;
    },
    [busy],
  );
  const handleDroppedFiles = useCallback(
    (files: File[]) => {
      const saves = files.filter((file) => isSaveFileName(file.name));
      const [save] = saves;
      const roms = files.filter((file) => !isSaveFileName(file.name));
      setIgnoredSaves(
        save && saves.length > 1 ? { names: saves.slice(1).map((file) => file.name), used: save.name } : undefined,
      );
      if (save && !roms.length) {
        // A save dropped alone plays in the game already loaded when it fits; otherwise it waits for the next ROM.
        void (async () => {
          try {
            if (await applySaveToCurrentGame(save)) return;
            const staged = await stagePendingTestSave({ data: save, fileName: save.name, slot: "dropped" });
            pendingReadRevisionRef.current += 1;
            setPendingSave(staged);
          } catch (reason) {
            setError({
              detail: errorDetail(reason, "The save could not be loaded."),
              summary: `Could not load ${save.name}.`,
            });
          }
        })();
        return;
      }
      void handleFiles(roms, true, save);
    },
    [applySaveToCurrentGame, handleFiles],
  );
  const handledPageDropIdRef = useRef<number | null>(null);
  usePageDropForwarder(pageDrop, handleDroppedFiles, handledPageDropIdRef);

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
        const playable = await handleFiles([file], prepareAudio, undefined, true);
        if (abortController.signal.aborted) return;
        if (!playable) setSampleTutorialActive(false);
      } catch {
        if (abortController.signal.aborted) return;
        setSampleTutorialActive(false);
        setSampleError("Couldn't load the practice files. Check your connection and try again.");
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
  // Every route into Test ends at currentGame, so this one check covers pickers, archives, URL sessions and Apply.
  // Apply can hand over a headerless FDS image under any output name, so the bytes decide as well.
  const [fdsBytes, setFdsBytes] = useState<{ blob: Blob; isFds: boolean } | null>(null);
  useEffect(() => {
    if (!currentBlob) {
      setFdsBytes(null);
      return undefined;
    }
    let cancelled = false;
    void hasFdsDiskSignature(currentBlob)
      .catch(() => false)
      .then((isFds) => {
        if (!cancelled) setFdsBytes({ blob: currentBlob, isFds });
      });
    return () => {
      cancelled = true;
    };
  }, [currentBlob]);
  const fdsChecking = Boolean(currentBlob && fdsBytes?.blob !== currentBlob);
  const missingBios = Boolean(
    currentGame && (requiresUnsuppliedBios(currentGame) || (fdsBytes?.blob === currentBlob && fdsBytes?.isFds)),
  );
  const canPlay = Boolean(
    currentGame && currentCore && gameUrl && currentIdentity && !webglBlocked && !missingBios && !fdsChecking,
  );
  useEffect(() => {
    if (missingBios) {
      setPseudoFullscreen(false);
      return undefined;
    }
    if (!canPlay) return undefined;
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
  }, [canPlay, missingBios, pseudoFullscreen]);

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

  const discardPendingSave = async () => {
    try {
      await clearPendingTestSave(pendingSave?.slot);
      pendingReadRevisionRef.current += 1;
      // A save held in the other slot becomes the one shown.
      setPendingSave((await readPendingTestSaves())[0]);
    } catch (reason) {
      setError({
        detail: errorDetail(reason, "The saved upload could not be removed."),
        summary: "Could not remove the saved upload.",
      });
    }
  };

  const getAgentStartButton = () => {
    const button = iframeRef.current?.contentDocument?.querySelector<HTMLElement>(".ejs_start_button");
    return button?.getClientRects().length ? button : null;
  };
  const getAgentPlayerState = () => {
    const frame = iframeRef.current?.contentWindow as (Window & { __romWeaverGameStarted?: boolean }) | null;
    return { started: frame?.__romWeaverGameStarted === true, startReady: Boolean(getAgentStartButton()) };
  };
  useAgentWorkflow("test", {
    getState: () => ({
      source: describeAgentSource(currentGame?.blob),
      game: currentGame
        ? { id: currentGame.id, name: currentGame.fileName, size: currentGame.sizeBytes, core: currentCore }
        : null,
      busy,
      preparing,
      error,
      progress: loadProgress,
      canPlay,
      missingBios,
      player: getAgentPlayerState(),
      pendingSave: pendingSave ? { present: true } : null,
      saveLoadStatus,
    }),
    actions: {
      run: {
        description: "Start the loaded ROM in EmulatorJS",
        get enabled() {
          return canPlay && Boolean(getAgentStartButton());
        },
        execute: () => {
          const button = getAgentStartButton();
          if (!button) throw new Error("The emulator is not ready to start");
          button.click();
        },
      },
      stop: { description: "Stop and unload the game", enabled: Boolean(currentGame || busy), execute: stopGame },
      cancel: { description: "Cancel sample loading", enabled: sampleLoading, execute: cancelSampleLoad },
      discardSave: {
        description: "Remove the pending saved upload",
        enabled: Boolean(pendingSave),
        execute: discardPendingSave,
      },
      fullscreen: { description: "Toggle emulator fullscreen", enabled: canPlay, execute: toggleFullscreen },
    },
  });

  return (
    <div className="emulator-test-view">
      {sampleTutorialActive ? (
        <SampleTutorial
          download={{ href: resolveAssetUrl(assetBaseUrl, TEST_SAMPLE_ASSET), name: TEST_SAMPLE_ASSET }}
          loadingBody="RomWeaver is loading a tiny homebrew NES ROM for the Test guide."
          onClose={closeTestSample}
          ready={sampleTutorialReady}
          steps={getTestSampleTutorialSteps(localizer)}
        />
      ) : null}
      <UnifiedDropZone
        accept={getFileInputAcceptAttributes().unifiedRom}
        addLabel="Choose another ROM"
        afterDropZone={
          <>
            {pendingSave ? (
              <div className="drop-tray emulator-pending-save">
                <div className="drop-tray-row">
                  <span className="drop-tray-label">
                    <Save aria-hidden="true" /> Save to load
                  </span>
                  <div className="drop-tray-control">
                    <span className="emulator-pending-file">
                      <span className="mono">{pendingSave.fileName}</span>
                      <button
                        aria-label="Discard save"
                        className="emulator-pending-discard"
                        onClick={() => void discardPendingSave()}
                        type="button"
                      >
                        <X aria-hidden="true" />
                      </button>
                    </span>
                    <p className="save-status">Add the ROM of the game that made this save.</p>
                    {pendingSave.memoryOnly ? (
                      <p className="save-status is-failed">
                        Save storage is off, so reloading or closing this page loses this save.
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
            {loadProgress ? (
              <div aria-live="polite" className="emulator-load-progress">
                <FileProgress
                  indeterminate={loadProgress.indeterminate}
                  label={loadProgress.label || "Preparing the ROM..."}
                  percent={loadProgress.visualPercent}
                  value={progressValue(loadProgress)}
                />
              </div>
            ) : null}
          </>
        }
        beforeDropZone={
          error || ignoredSaves || (currentGame && missingBios) ? (
            <>
              {ignoredSaves ? (
                <Notice id="emulator-test-ignored-saves" level="warn" onDismiss={() => setIgnoredSaves(undefined)}>
                  <b>Only one save loads at a time.</b> Used {ignoredSaves.used}; ignored{" "}
                  {ignoredSaves.names.join(", ")}.
                </Notice>
              ) : null}
              {error ? (
                <Notice
                  id="emulator-test-error"
                  level="error"
                  onDismiss={error.blocksPlayer ? undefined : () => setError(null)}
                >
                  <b>{error.summary}</b> {error.detail}
                </Notice>
              ) : null}
              {currentGame && missingBios ? (
                <Notice id="emulator-test-bios" level="error">
                  <b>{localizer.message("ui.test.fdsBios.summary", { fileName: currentGame.fileName })}</b>{" "}
                  {localizer.message("ui.test.fdsBios.detail")}{" "}
                  <a href={FDS_BIOS_ISSUE_URL} rel="noreferrer" target="_blank">
                    {localizer.message("ui.test.fdsBios.link")}
                  </a>
                </Notice>
              ) : null}
            </>
          ) : undefined
        }
        big={workflowEmpty}
        disabled={busy || sampleLoading}
        guide={WORKFLOW_GUIDES.test}
        heroLabel="Drop or click to add a ROM or archive"
        heroLabelCoarse="Tap to add a ROM or archive"
        id="emulator-test-input"
        info={<p>Choosing another ROM stops and replaces the current game.</p>}
        inputId="emulator-test-file-input"
        lead={{ line1: "ui.hero.testThesis", description: "ui.hero.testDescription" }}
        multiple={false}
        onBrowseStart={() => prepareEmulatorAudioContext()}
        onDropStart={() => prepareEmulatorAudioContext()}
        onFiles={handleDroppedFiles}
        onboarding={
          loadProgress ? null : (
            <SampleTutorialStart
              chipLabel={localizer.message("ui.tutorial.tryTest")}
              documentation={{
                href: resolveAssetUrl(assetBaseUrl, WORKFLOW_GUIDES.test.path),
                label: localizer.message(WORKFLOW_GUIDES.test.label),
              }}
              downloadHref={resolveAssetUrl(assetBaseUrl, TEST_SAMPLE_ASSET)}
              downloadLabel="Download the sample ROM"
              downloadName={TEST_SAMPLE_ASSET}
              error={sampleError}
              guideHref={resolveGuidedSampleHref(assetBaseUrl, "test")}
              label="Start a practice run"
              loading={sampleLoading}
              onStart={startTestSample}
              startAction="play"
            />
          )
        }
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
                  <a className="btn ghost slim" href="apply-patch">
                    <ArrowLeft aria-hidden="true" /> Back to Apply
                  </a>
                ) : null}
                <button aria-label="Stop and unload game" className="btn ghost slim" onClick={stopGame} type="button">
                  Stop
                </button>
                {currentGame &&
                currentCore &&
                gameUrl &&
                currentIdentity &&
                !webglBlocked &&
                !missingBios &&
                !fdsChecking ? (
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
            meta={currentGame ? <span>{formatByteSize(currentGame.sizeBytes)}</span> : undefined}
            num="0x02"
            title="Play"
          >
            <div className="card emulator-player">
              {currentGame ? (
                <div className="cks emulator-player-copy">
                  <div className="ckrows">
                    <ChecksumRow label="NAME" value={currentGame.fileName} />
                    {currentGame.checksum ? <ChecksumRow label="SHA-1" value={currentGame.checksum} /> : null}
                  </div>
                </div>
              ) : null}
              {currentGame?.savePreviewRevision ? (
                <p
                  className={join(
                    "save-status emulator-save-status",
                    saveLoadStatus === "loaded" && "is-ready",
                    saveLoadStatus === "failed" && "is-failed",
                  )}
                  role="status"
                >
                  {saveLoadMessage}
                </p>
              ) : null}
              {currentGame &&
              currentCore &&
              gameUrl &&
              currentIdentity &&
              !webglBlocked &&
              !missingBios &&
              !fdsChecking ? (
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
                      key={`${currentGame.id}:${gameUrl}:${currentGame.savePreviewRevision ?? 0}`}
                      ref={registerPlayerFrame}
                      referrerPolicy="no-referrer"
                      srcDoc={createEmulatorDocument(dataUrl, gameUrl, currentIdentity.gameName, currentCore, {
                        gameId: currentIdentity.gameId,
                        saveId: currentIdentity.saveId,
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
              ) : currentGame && currentCore && preparing && !missingBios ? (
                <div className="emulator-player-loading">
                  <FileProgress indeterminate label="Preparing the ROM..." value="working" />
                </div>
              ) : currentGame && !webglBlocked && !missingBios ? (
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
