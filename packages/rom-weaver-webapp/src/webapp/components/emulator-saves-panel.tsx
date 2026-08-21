import { Download, RefreshCw, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { triggerBrowserDownload } from "../../platform/browser/browser-download.ts";
import { DropdownSelect } from "../../public/react/components/ds/dropdown-select.tsx";
import {
  createEmulatorSaveExport,
  deleteEmulatorSave,
  importEmulatorSave,
  importEmulatorSavePart,
  listEmulatorSaves,
  type EmulatorSaveRecord,
} from "../../storage/browser/emulator-saves.ts";
import { compressEmulatorSaveExport, extractEmulatorSaveExport } from "../../storage/browser/emulator-save-export.ts";

const formatSaveSize = (value?: Uint8Array) => (value ? formatByteSize(value.byteLength) : "none");

type ReadyEmulatorSaveExport = {
  blob: Blob;
  fileName: string;
  gameId: string;
};

const EmulatorSavesPanel = ({ active = true }: { active?: boolean }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [saves, setSaves] = useState<EmulatorSaveRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [readyExport, setReadyExport] = useState<ReadyEmulatorSaveExport | null>(null);
  const [pendingImport, setPendingImport] = useState<{
    file: File;
    kind: "combined" | "sram" | "state";
  } | null>(null);
  const [importSha1, setImportSha1] = useState("");
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

  const exportSave = async (save: EmulatorSaveRecord) => {
    setExportingId(save.gameId);
    setError("");
    const cached = readyExport?.gameId === save.gameId ? readyExport : undefined;
    try {
      const exported = cached || (await compressEmulatorSaveExport(createEmulatorSaveExport(save)));
      try {
        await triggerBrowserDownload(exported.blob, exported.fileName, { interactive: true });
        setReadyExport(null);
      } catch (reason) {
        setReadyExport({ ...exported, gameId: save.gameId });
        throw reason;
      }
    } catch (reason) {
      reportActionError(reason);
    } finally {
      setExportingId(null);
    }
  };

  const beginImport = () => {
    inputRef.current?.click();
  };

  const importSelectedFile = (file: File) => {
    let kind: "combined" | "sram" | "state" = "sram";
    if (/\.(json|zip)$/i.test(file.name) || file.type === "application/zip") kind = "combined";
    else if (/\.(state|ss\d*|savestate)$/i.test(file.name)) kind = "state";
    setImportSha1("");
    setPendingImport({ file, kind });
  };

  const submitImport = async () => {
    if (!pendingImport) return;
    setError("");
    try {
      if (pendingImport.kind === "combined") {
        const source =
          /\.zip$/i.test(pendingImport.file.name) || pendingImport.file.type === "application/zip"
            ? await extractEmulatorSaveExport(pendingImport.file)
            : pendingImport.file;
        await importEmulatorSave(source);
      } else {
        await importEmulatorSavePart({ data: pendingImport.file, part: pendingImport.kind, sha1: importSha1 });
      }
      setPendingImport(null);
      setImportSha1("");
      await refresh();
    } catch (reason) {
      reportActionError(reason);
    }
  };

  return (
    <section aria-labelledby="emulator-saves-title" className="emulator-saves-panel">
      <div className="emulator-saves-heading">
        <div>
          <h3 className="dlg-section-title" id="emulator-saves-title">
            Emulator saves
          </h3>
          <p>Each backup can hold both a save state and SRAM. Matching to the same ROM is automatic.</p>
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
          <button className="btn slim ghost" onClick={beginImport} type="button">
            <Upload aria-hidden="true" /> Import save
          </button>
          <input
            accept="application/json,application/zip,.json,.zip,*/*"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) importSelectedFile(file);
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
      {pendingImport ? (
        <form
          className="emulator-save-import-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitImport();
          }}
        >
          <div>
            <strong>Import {pendingImport.file.name}</strong>
            <span>Choose the file type. Raw saves also need the ROM SHA-1.</span>
          </div>
          <label htmlFor="emulator-save-import-kind">File type</label>
          <DropdownSelect
            className="select"
            id="emulator-save-import-kind"
            onChange={(event) =>
              setPendingImport((current) =>
                current ? { ...current, kind: event.currentTarget.value as "combined" | "sram" | "state" } : current,
              )
            }
            value={pendingImport.kind}
          >
            <option value="combined">rom-weaver exported save</option>
            <option value="sram">SRAM</option>
            <option value="state">Save state</option>
          </DropdownSelect>
          {pendingImport.kind === "combined" ? null : (
            <>
              <label htmlFor="emulator-save-import-sha1">ROM SHA-1</label>
              <input
                autoComplete="off"
                className="input mono"
                id="emulator-save-import-sha1"
                onChange={(event) => setImportSha1(event.currentTarget.value)}
                spellCheck="false"
                value={importSha1}
              />
            </>
          )}
          <div className="emulator-save-import-actions">
            <button
              className="btn slim primary"
              disabled={pendingImport.kind !== "combined" && !importSha1.trim()}
              type="submit"
            >
              Import
            </button>
            <button
              className="btn slim ghost"
              onClick={() => {
                setPendingImport(null);
                setImportSha1("");
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
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
                <span className="emulator-save-sha">ROM fingerprint · SHA-1 {save.gameId}</span>
                <span className="emulator-save-sizes">
                  State: {formatSaveSize(save.state)} · SRAM: {formatSaveSize(save.sram)}
                </span>
              </div>
              <div className="emulator-save-actions">
                <button
                  aria-busy={exportingId === save.gameId}
                  className="btn slim ghost"
                  disabled={exportingId !== null}
                  onClick={() => void exportSave(save)}
                  type="button"
                >
                  <Download aria-hidden="true" /> {readyExport?.gameId === save.gameId ? "Download" : "Export"}
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
