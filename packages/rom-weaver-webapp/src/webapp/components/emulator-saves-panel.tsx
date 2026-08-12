import { Download, RefreshCw, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { triggerBrowserDownload } from "../../platform/browser/browser-download.ts";
import {
  createEmulatorSaveExport,
  deleteEmulatorSave,
  importEmulatorSave,
  listEmulatorSaves,
  type EmulatorSaveRecord,
} from "../../storage/browser/emulator-saves.ts";

const formatSaveSize = (value?: Uint8Array) => (value ? formatByteSize(value.byteLength) : "none");

const EmulatorSavesPanel = ({ active = true }: { active?: boolean }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [saves, setSaves] = useState<EmulatorSaveRecord[]>([]);
  const [loading, setLoading] = useState(false);
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
    if (active) void refresh();
  }, [active, refresh]);

  const reportActionError = (reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
  };

  const exportSave = (save: EmulatorSaveRecord) => {
    const exported = createEmulatorSaveExport(save);
    void triggerBrowserDownload(exported.blob, exported.fileName, { interactive: true }).catch(reportActionError);
  };

  return (
    <section aria-labelledby="emulator-saves-title" className="emulator-saves-panel">
      <div className="emulator-saves-heading">
        <div>
          <h3 className="dlg-section-title" id="emulator-saves-title">
            Emulator saves
          </h3>
          <p>Save states and SRAM, matched to each ROM by SHA-1.</p>
        </div>
        <div className="emulator-saves-actions">
          <button
            aria-label="Refresh emulator saves"
            className="btn slim ghost"
            onClick={() => void refresh()}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={loading ? "spin" : undefined} />
          </button>
          <button className="btn slim ghost" onClick={() => inputRef.current?.click()} type="button">
            <Upload aria-hidden="true" /> Import save
          </button>
          <input
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file)
                void importEmulatorSave(file)
                  .then(refresh)
                  .catch((reason) => setError(String(reason)));
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
      {loading || saves.length ? null : (
        <div className="emulator-saves-empty">
          <strong>No emulator saves yet</strong>
          <span>Play a ROM in Test, or import a rom-weaver save.</span>
        </div>
      )}
      {saves.length ? (
        <ul className="emulator-saves-list">
          {saves.map((save) => (
            <li className="emulator-save-row" key={save.gameId}>
              <div className="emulator-save-info">
                <strong>{save.label}</strong>
                <span className="emulator-save-sha">SHA-1 {save.gameId}</span>
                <span className="emulator-save-sizes">
                  State: {formatSaveSize(save.state)} · SRAM: {formatSaveSize(save.sram)}
                </span>
              </div>
              <div className="emulator-save-actions">
                <button className="btn slim ghost" onClick={() => exportSave(save)} type="button">
                  <Download aria-hidden="true" /> Export
                </button>
                <button
                  className="btn slim ghost"
                  onClick={() => void deleteEmulatorSave(save.gameId).then(refresh).catch(reportActionError)}
                  type="button"
                >
                  <Trash2 aria-hidden="true" /> Delete
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
