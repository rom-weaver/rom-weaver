import { useCallback, useEffect, useRef, useState } from "react";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import {
  deleteKeptRom,
  listKeptRoms,
  readKeptRom,
  type KeptRom,
  type KeptRomPlayback,
} from "../../storage/browser/kept-roms.ts";
import { requestPersistentStorage } from "../../storage/browser/persistent-storage.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import { StorageFullRecovery } from "./storage-full-recovery.tsx";

const KeptRomsPanel = ({
  active = true,
  onPlay,
  disabled = false,
  onPlayStart,
}: {
  active?: boolean;
  disabled?: boolean;
  onPlay?: (source: KeptRomPlayback) => Promise<unknown>;
  onPlayStart?: () => AbortSignal;
}) => {
  const localizer = useUiLocalizer();
  const [roms, setRoms] = useState<KeptRom[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [persistence, setPersistence] = useState<"granted" | "denied" | null>(null);
  const actionRef = useRef(false);
  const revisionRef = useRef(0);
  const mountedRef = useRef(true);
  const playbackAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      playbackAbortRef.current?.abort();
    };
  }, []);
  const refresh = useCallback(async () => {
    const revision = ++revisionRef.current;
    try {
      const next = await listKeptRoms();
      if (revision === revisionRef.current) setRoms(next);
    } catch (reason) {
      if (revision === revisionRef.current) setError(String(reason));
    }
  }, []);
  useEffect(() => {
    if (!active) {
      playbackAbortRef.current?.abort();
      return;
    }
    void refresh();
    const changed = () => void refresh();
    window.addEventListener("rom-weaver-kept-roms-changed", changed);
    window.addEventListener("focus", changed);
    return () => {
      revisionRef.current += 1;
      window.removeEventListener("rom-weaver-kept-roms-changed", changed);
      window.removeEventListener("focus", changed);
    };
  }, [active, refresh]);

  const run = async (action: () => Promise<unknown>) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      if (mountedRef.current) await refresh();
    } catch (reason) {
      if (mountedRef.current && (reason as { name?: string } | null)?.name !== "AbortError") setError(String(reason));
    } finally {
      actionRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };
  const titleId = onPlay ? "test-kept-roms-title" : "storage-kept-roms-title";
  return (
    <section aria-labelledby={titleId} aria-busy={busy} className="emulator-saves-panel">
      <div className="emulator-saves-heading">
        <div>
          <h3 className="dlg-section-title" id={titleId}>
            {localizer.message("ui.keptRoms.title")}
          </h3>
          <p>{localizer.message("ui.keptRoms.description")}</p>
        </div>
        {onPlay ? null : (
          <button
            className="btn slim ghost"
            disabled={busy}
            type="button"
            onClick={() =>
              void run(async () => {
                setPersistence((await requestPersistentStorage()) ? "granted" : "denied");
              })
            }
          >
            {localizer.message("ui.keptRoms.protect")}
          </button>
        )}
      </div>
      {persistence ? <p role="status">{localizer.message(`ui.keptRoms.persistence.${persistence}`)}</p> : null}
      {error ? (
        <p className="emulator-saves-error" role="status">
          {error}
          <StorageFullRecovery message={error} />
        </p>
      ) : null}
      {roms.length ? (
        <ul className="emulator-saves-list">
          {roms.map((rom) => (
            <li className="emulator-save-row" key={rom.gameId}>
              <div className="emulator-save-info">
                <strong>{rom.fileName}</strong>
                <span className="emulator-save-sha">SHA-1: {rom.gameId}</span>
                <span>
                  {formatByteSize(rom.size)}
                  {rom.status === "ready" ? "" : ` · ${localizer.message(`ui.keptRoms.${rom.status}`)}`}
                </span>
              </div>
              <div className="emulator-save-actions">
                {onPlay ? (
                  <button
                    className="btn slim ghost"
                    disabled={disabled || busy || rom.status !== "ready"}
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        const controller = new AbortController();
                        playbackAbortRef.current = controller;
                        const parentSignal = onPlayStart?.();
                        const signal = parentSignal
                          ? AbortSignal.any([controller.signal, parentSignal])
                          : controller.signal;
                        let source: KeptRomPlayback | undefined;
                        let accepted = false;
                        try {
                          source = await readKeptRom(rom.gameId, signal);
                          if (signal.aborted) return;
                          accepted = (await onPlay(source)) !== false;
                        } finally {
                          if (!accepted) await source?.dispose().catch(() => undefined);
                          if (playbackAbortRef.current === controller) playbackAbortRef.current = null;
                        }
                      })
                    }
                  >
                    {localizer.message("ui.keptRoms.play")}
                  </button>
                ) : null}
                <button
                  className="btn slim ghost"
                  disabled={disabled || busy}
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await deleteKeptRom(rom.gameId);
                      window.dispatchEvent(new Event("rom-weaver-kept-roms-changed"));
                    })
                  }
                >
                  {localizer.message(onPlay ? "ui.keptRoms.remove" : "ui.keptRoms.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p>{localizer.message("ui.keptRoms.empty")}</p>
      )}
    </section>
  );
};

export { KeptRomsPanel };
