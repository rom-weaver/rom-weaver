import { Download, RefreshCw, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { triggerBrowserDownload } from "../../platform/browser/browser-download.ts";
import {
  createEmulatorSaveExport,
  deleteEmulatorSave,
  importEmulatorSave,
  listEmulatorSaves,
  readEmulatorSave,
  subscribeEmulatorSaves,
  type EmulatorSaveRecord,
} from "../../storage/browser/emulator-saves.ts";

type EmulatorSavesPanelProps = {
  active?: boolean;
};

const formatSaveSize = (value: Uint8Array | undefined) => (value ? formatByteSize(value.byteLength) : "none");

const EmulatorSavesPanel = ({ active = true }: EmulatorSavesPanelProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [saves, setSaves] = useState<EmulatorSaveRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyGameId, setBusyGameId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setSaves(await listEmulatorSaves());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    void refresh();
    return subscribeEmulatorSaves(() => void refresh());
  }, [active, refresh]);

  const exportSave = async (save: EmulatorSaveRecord) => {
    setBusyGameId(save.gameId);
    setError("");
    try {
      const exported = createEmulatorSaveExport((await readEmulatorSave(save.gameId)) || save);
      await triggerBrowserDownload(exported.blob, exported.fileName, { interactive: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyGameId(null);
    }
  };

  const deleteSave = async (save: EmulatorSaveRecord) => {
    setBusyGameId(save.gameId);
    setError("");
    try {
      await deleteEmulatorSave(save.gameId);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyGameId(null);
    }
  };

  const importSave = async (file: File) => {
    setLoading(true);
    setError("");
    try {
      await importEmulatorSave(file);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    }
  };

  return (
    <section aria-labelledby="emulator-saves-title" className="emulator-saves-panel">
      <div className="emulator-saves-heading">
        <div>
          <h3 id="emulator-saves-title">EmulatorJS saves</h3>
          <p>Save states and SRAM stay on this device and can move with an export file.</p>
        </div>
        <div className="emulator-saves-actions">
          <button
            aria-label="Refresh EmulatorJS saves"
            className="btn slim ghost"
            disabled={loading}
            onClick={() => void refresh()}
            title="Refresh EmulatorJS saves"
            type="button"
          >
            <RefreshCw aria-hidden="true" className={loading ? "spin" : undefined} />
          </button>
          <button className="btn slim ghost" disabled={loading} onClick={() => inputRef.current?.click()} type="button">
            <Upload aria-hidden="true" />
            Import saves
          </button>
          <input
            accept="application/json,.json"
            className="visually-hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void importSave(file);
            }}
            ref={inputRef}
            type="file"
          />
        </div>
      </div>
      {error ? (
        <p className="emulator-saves-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading && !saves.length ? <p aria-live="polite">Reading EmulatorJS saves…</p> : null}
      {loading || saves.length || error ? null : <p className="emulator-saves-empty">No saved states or SRAM yet.</p>}
      {saves.length ? (
        <ul className="emulator-saves-list">
          {saves.map((save) => (
            <li className="emulator-save-row" key={save.gameId}>
              <div className="emulator-save-info">
                <strong>{save.label}</strong>
                <span>
                  State: {formatSaveSize(save.state)} · SRAM: {formatSaveSize(save.sram)}
                </span>
              </div>
              <div className="emulator-save-actions">
                <button
                  className="btn slim ghost"
                  disabled={busyGameId === save.gameId}
                  onClick={() => void exportSave(save)}
                  type="button"
                >
                  <Download aria-hidden="true" />
                  Export
                </button>
                <button
                  className="btn slim ghost"
                  disabled={busyGameId === save.gameId}
                  onClick={() => void deleteSave(save)}
                  type="button"
                >
                  <Trash2 aria-hidden="true" />
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};

export { EmulatorSavesPanel };
