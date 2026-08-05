import { Gamepad2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { loadEmulatorRom } from "./components/emulator-load-rom.ts";
import { UnifiedDropZone } from "./components/ds/unified-drop-zone.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { getEmulatorJsCore } from "./components/emulatorjs.ts";
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
  onOpenStorage?: () => void;
};

const EmulatorTestView = ({ onOpenStorage }: EmulatorTestViewProps) => {
  const { currentGameId, entries } = useEmulatorSession();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
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
    const handleVisibilityChange = () => sendVisibility(document.hidden ? "visibility-pause" : "visibility-resume");
    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (document.hidden) sendVisibility("visibility-pause");
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [currentIdentity]);

  useEffect(() => {
    if (!currentGame) return;
    setError(hasWebgl2() ? "" : WEBGL2_ERROR);
  }, [currentGame]);

  useEffect(() => {
    if (!currentGame || currentGame.objectUrl || !currentGame.artifact) return;
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
            core,
            fileName: loaded.fileName,
            id,
            objectUrl: URL.createObjectURL(loaded.blob),
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
  return (
    <div className="emulator-test-view">
      <section aria-labelledby="emulator-player-title" className="card emulator-player">
        <div className="emulator-player-head">
          <div>
            <p className="eyebrow mono">TEST BENCH</p>
            <h1 id="emulator-player-title">Play a ROM in EmulatorJS</h1>
          </div>
          {currentGame ? <span className="emulator-player-game mono">{currentGame.fileName}</span> : null}
        </div>
        {error ? (
          <p className="emulatorjs-error" role="alert">
            {error}
          </p>
        ) : currentGame && currentCore && currentGame.objectUrl && currentIdentity ? (
          <div className="emulator-player-frame">
            <iframe
              allow="autoplay; fullscreen; gamepad"
              allowFullScreen
              key={currentGame.id}
              ref={iframeRef}
              referrerPolicy="no-referrer"
              srcDoc={createEmulatorDocument(dataUrl, currentGame.objectUrl, currentIdentity.gameName, currentCore, {
                gameId: currentIdentity.gameId,
                gameLabel: currentIdentity.gameLabel,
              })}
              title={`EmulatorJS test for ${currentGame.fileName}`}
            />
          </div>
        ) : currentGame && currentCore && preparing ? (
          <p className="emulator-player-empty">Preparing the ROM…</p>
        ) : currentGame ? (
          <p className="emulator-player-empty">No emulator core for this system.</p>
        ) : entries.length ? (
          <p className="emulator-player-empty">Choose a game from Session outputs to start playing.</p>
        ) : (
          <div className="emulator-player-empty">
            <Gamepad2 aria-hidden="true" />
            <p>No game is loaded.</p>
            <a className="btn ghost slim" href="apply">
              Patch a ROM first
            </a>
          </div>
        )}
      </section>

      <UnifiedDropZone
        accept={getFileInputAcceptAttributes().unifiedRom}
        addLabel="Choose another ROM"
        heroLabel="Drop a ROM or choose a file"
        heroLabelCoarse="Choose a ROM file"
        id="emulator-test-input"
        inputId="emulator-test-file-input"
        onFiles={(files) => void handleFiles(files)}
        supported={[
          { extensions: ROM_FILE_EXTENSIONS, label: "ROMs" },
          { extensions: ["zip", "7z"], label: "Archives" },
        ]}
        title="Load a game"
      />

      <section aria-labelledby="emulator-session-title" className="emulator-session">
        <div className="emulator-session-head">
          <div>
            <p className="eyebrow mono">SESSION</p>
            <h2 id="emulator-session-title">Session outputs</h2>
          </div>
          <span className="mono">{entries.length}</span>
        </div>
        {onOpenStorage ? (
          <button className="btn ghost slim emulator-saves-link" onClick={onOpenStorage} type="button">
            Manage saved states and SRAM
          </button>
        ) : null}
        {entries.length ? (
          <div className="cards emulator-session-list">
            {entries.map((entry) => (
              <EmulatorSessionOutput current={entry.id === currentGameId} entry={entry} key={entry.id} />
            ))}
          </div>
        ) : (
          <p className="emulator-session-empty">
            Outputs from the Apply tab and local ROMs will stay here for this session.
          </p>
        )}
      </section>
      {busy ? (
        <p aria-live="polite" className="emulatorjs-note">
          Preparing the ROM…
        </p>
      ) : null}
    </div>
  );
};

export { EmulatorTestView };
