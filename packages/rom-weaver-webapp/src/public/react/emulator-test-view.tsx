import { ArrowLeft, Gamepad2, Maximize, Minimize } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { ensureEmulatorSaveBridge } from "../../storage/browser/emulator-saves.ts";
import {
  addEntry,
  disposeEntry,
  prepareEntry,
  setCurrentGame,
  useEmulatorSession,
  type EmulatorSessionEntry,
} from "./emulator-session-store.ts";
import { createEmulatorDocument, createEmulatorGameIdentity } from "./components/emulator-document.ts";
import { GhostSteps } from "./components/ds/ghost-steps.tsx";
import { StepSection } from "./components/ds/layout.tsx";
import { UnifiedDropZone } from "./components/ds/unified-drop-zone.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { loadEmulatorRom } from "./components/emulator-load-rom.ts";
import { getEmulatorJsAspectRatio, getEmulatorJsCore } from "./components/emulatorjs.ts";
import { ROM_FILE_EXTENSIONS } from "./file-classification.ts";
import { getFileInputAcceptAttributes } from "./file-input-accept.ts";

const WEBGL2_ERROR = "EmulatorJS testing requires a browser with WebGL 2.";
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

const EmulatorSessionOutput = ({ entry, current }: { entry: EmulatorSessionEntry; current: boolean }) => {
  const core = entry.core || getEmulatorJsCore(entry.platform, entry.fileName);
  const reason = core ? "" : "No emulator core for this system";
  return (
    <FileCard
      className={core ? "emulator-session-entry" : "emulator-session-entry is-disabled"}
      meta={
        <>
          <span className="fsize mono">{formatByteSize(entry.sizeBytes)}</span>
          <span className="meta-fmt">{entry.source === "apply" ? "Applied output" : "Local file"}</span>
          {entry.platform ? <span className="meta-fmt">{entry.platform}</span> : null}
        </>
      }
      name={<span className="nm">{entry.fileName}</span>}
      onRemove={() => disposeEntry(entry.id)}
      removeLabel={`Remove ${entry.fileName}`}
      menu={
        <button
          aria-describedby={reason ? `emulator-session-reason-${entry.id}` : undefined}
          aria-pressed={current}
          className="btn ghost slim"
          disabled={!core}
          onClick={() => setCurrentGame(entry.id)}
          type="button"
        >
          Play
        </button>
      }
    >
      {reason ? (
        <p className="emulator-session-reason" id={`emulator-session-reason-${entry.id}`}>
          {reason}
        </p>
      ) : null}
    </FileCard>
  );
};

type EmulatorTestViewProps = {
  /** False while another workflow tab is shown; the running game pauses until the view returns. */
  active?: boolean;
};

const EmulatorTestView = ({ active = true }: EmulatorTestViewProps) => {
  const { currentGameId, entries } = useEmulatorSession();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerFrameRef = useRef<HTMLDivElement>(null);
  const fullscreenDialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const currentGame = entries.find((entry) => entry.id === currentGameId) || null;
  const currentIdentity = useMemo(
    () =>
      currentGame
        ? createEmulatorGameIdentity({
            checksum: currentGame.checksum,
            fileName: currentGame.fileName,
            sizeBytes: currentGame.sizeBytes,
          })
        : null,
    [currentGame],
  );
  const dataUrl =
    typeof document === "undefined" ? "/emulatorjs/data/" : new URL("emulatorjs/data/", document.baseURI).href;

  useEffect(() => {
    ensureEmulatorSaveBridge();
  }, []);

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
    setError(hasWebgl2() ? "" : WEBGL2_ERROR);
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
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not read the retained ROM.");
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

  const handleFiles = useCallback(async (files: File[]) => {
    if (!hasWebgl2()) {
      setError(WEBGL2_ERROR);
      return;
    }
    setBusy(true);
    setError("");
    let lastPlayableId: string | null = null;
    try {
      for (const file of files) {
        try {
          const loaded = await loadEmulatorRom(file, file.name);
          const id = createLocalEntryId(loaded.fileName);
          const core = getEmulatorJsCore(undefined, loaded.fileName);
          addEntry({
            blob: loaded.blob,
            core,
            fileName: loaded.fileName,
            id,
            sizeBytes: loaded.blob.size,
            source: "local",
          });
          if (core) lastPlayableId = id;
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "Could not prepare the ROM for EmulatorJS.");
        }
      }
      if (lastPlayableId) setCurrentGame(lastPlayableId);
    } finally {
      setBusy(false);
    }
  }, []);

  const currentCore = currentGame
    ? currentGame.core || getEmulatorJsCore(currentGame.platform, currentGame.fileName)
    : null;
  const canPlay = Boolean(currentGame && currentCore && gameUrl && currentIdentity);
  const workflowEmpty = !(entries.length || error || busy);

  return (
    <div className="emulator-test-view">
      <UnifiedDropZone
        accept={getFileInputAcceptAttributes().unifiedRom}
        addLabel="Choose another ROM"
        afterDropZone={
          entries.length ? (
            <div className="cards emulator-session-list">
              {entries.map((entry) => (
                <EmulatorSessionOutput current={entry.id === currentGameId} entry={entry} key={entry.id} />
              ))}
            </div>
          ) : undefined
        }
        big={workflowEmpty}
        heroLabel="Drop a ROM or choose a file"
        heroLabelCoarse="Choose a ROM file"
        id="emulator-test-input"
        info={<p>Loaded games and Apply outputs stay listed here for this session.</p>}
        inputId="emulator-test-file-input"
        lead={{ line1: "ui.hero.testThesis", line2: "ui.hero.testThesis2" }}
        onFiles={(files) => void handleFiles(files)}
        supported={[
          { extensions: ROM_FILE_EXTENSIONS, label: "ROMs" },
          { extensions: ["zip", "7z"], label: "Archives" },
        ]}
        title="Load a game"
      />

      {workflowEmpty ? (
        <GhostSteps steps={[{ num: "0x02", title: "Play" }]} />
      ) : (
        <>
          <StepSection
            headerExtra={
              <div className="emulator-player-actions">
                <a className="btn ghost slim" href="apply">
                  <ArrowLeft aria-hidden="true" /> Back to Apply
                </a>
                {canPlay ? (
                  <>
                    <button className="btn ghost slim" onClick={() => setCurrentGame(null)} type="button">
                      Stop
                    </button>
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
            meta={currentGame ? currentGame.fileName : undefined}
            num="0x02"
            title="Play"
          >
            <div className="card emulator-player">
              {error ? (
                <p className="emulatorjs-error" role="alert">
                  {error}
                </p>
              ) : currentGame && currentCore && gameUrl && currentIdentity ? (
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
                <p className="emulator-player-empty">Preparing the ROM…</p>
              ) : currentGame ? (
                <p className="emulator-player-empty">No emulator core for this system.</p>
              ) : entries.length ? (
                <p className="emulator-player-empty">Choose a game from the list above to start playing.</p>
              ) : (
                <div className="emulator-player-empty">
                  <Gamepad2 aria-hidden="true" />
                  <p>No game is loaded.</p>
                  <a className="btn ghost slim" href="apply">
                    Patch a ROM first
                  </a>
                </div>
              )}
            </div>
          </StepSection>
        </>
      )}
      {busy ? (
        <p aria-live="polite" className="emulatorjs-note">
          Preparing the ROM…
        </p>
      ) : null}
    </div>
  );
};

export { EmulatorTestView };
