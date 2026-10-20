import { Download, RefreshCw, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Localizer } from "../../presentation/localization/index.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
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

const formatSaveSize = (value: Uint8Array | undefined, localizer: Localizer) =>
  value ? formatByteSize(value.byteLength) : localizer.message("ui.saves.emulator.none");

type ReadyEmulatorSaveExport = {
  blob: Blob;
  fileName: string;
  gameId: string;
};

/** Save backups dropped elsewhere on the page; `id` tells two drops of the same files apart. */
type EmulatorSaveImportRequest = {
  files: File[];
  id: number;
};

const isZipFile = (file: File) => /\.zip$/i.test(file.name) || file.type === "application/zip";

const importSaveBackup = async (file: File) =>
  importEmulatorSave(isZipFile(file) ? await extractEmulatorSaveExport(file) : file);

const EmulatorSavesPanel = ({
  active = true,
  importRequest = null,
  onImportStarted,
}: {
  active?: boolean;
  importRequest?: EmulatorSaveImportRequest | null;
  /** Called once the request is taken, so a remounted panel does not import it again. */
  onImportStarted?: () => void;
}) => {
  const localizer = useUiLocalizer();
  const inputRef = useRef<HTMLInputElement>(null);
  const handledImportIdRef = useRef<number | null>(null);
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
  useEffect(() => {
    if (!importRequest || handledImportIdRef.current === importRequest.id) return;
    handledImportIdRef.current = importRequest.id;
    onImportStarted?.();
    void (async () => {
      let failure: unknown;
      for (const file of importRequest.files) {
        try {
          await importSaveBackup(file);
        } catch (reason) {
          failure ??= reason;
        }
      }
      await refresh();
      if (failure) setError(failure instanceof Error ? failure.message : String(failure));
    })();
  }, [importRequest, onImportStarted, refresh]);

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
        await importSaveBackup(pendingImport.file);
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
            {localizer.message("ui.saves.emulator.title")}
          </h3>
          <p>{localizer.message("ui.saves.emulator.description")}</p>
        </div>
        <div className="emulator-saves-actions">
          <button
            aria-label={localizer.message("ui.saves.emulator.refresh")}
            className="btn slim ghost"
            onClick={() => void refresh()}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={loading ? "spin" : undefined} />
          </button>
          <button className="btn slim ghost" onClick={beginImport} type="button">
            <Upload aria-hidden="true" /> {localizer.message("ui.saves.emulator.importSave")}
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
            <strong>{localizer.message("ui.saves.emulator.importFile", { name: pendingImport.file.name })}</strong>
            <span>{localizer.message("ui.saves.emulator.importHint")}</span>
          </div>
          <label htmlFor="emulator-save-import-kind">{localizer.message("ui.saves.emulator.fileType")}</label>
          <DropdownSelect
            className="select"
            id="emulator-save-import-kind"
            onChange={(event) => {
              // Read the value during dispatch because currentTarget is cleared before a deferred state updater runs.
              const kind = event.currentTarget.value as "combined" | "sram" | "state";
              setPendingImport((current) => (current ? { ...current, kind } : current));
            }}
            value={pendingImport.kind}
          >
            <option value="combined">{localizer.message("ui.saves.emulator.kindCombined")}</option>
            <option value="sram">SRAM</option>
            <option value="state">{localizer.message("ui.saves.emulator.kindState")}</option>
          </DropdownSelect>
          {pendingImport.kind === "combined" ? null : (
            <>
              <label htmlFor="emulator-save-import-sha1">{localizer.message("ui.saves.emulator.romSha1")}</label>
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
              {localizer.message("ui.saves.emulator.import")}
            </button>
            <button
              className="btn slim ghost"
              onClick={() => {
                setPendingImport(null);
                setImportSha1("");
              }}
              type="button"
            >
              {localizer.message("ui.common.cancel")}
            </button>
          </div>
        </form>
      ) : null}
      {loading || saves.length ? null : (
        <div className="emulator-saves-empty">
          <strong>{localizer.message("ui.saves.emulator.emptyTitle")}</strong>
          <span>{localizer.message("ui.saves.emulator.emptyBody")}</span>
        </div>
      )}
      {saves.length ? (
        <ul className="emulator-saves-list">
          {saves.map((save) => (
            <li className="emulator-save-row" key={save.gameId}>
              <div className="emulator-save-info">
                <strong>{save.label}</strong>
                <span className="emulator-save-sha">
                  {localizer.message("ui.saves.emulator.fingerprint", { sha1: save.gameId })}
                </span>
                <span className="emulator-save-sizes">
                  {localizer.message("ui.saves.emulator.sizes", {
                    sram: formatSaveSize(save.sram, localizer),
                    state: formatSaveSize(save.state, localizer),
                  })}
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
                  <Download aria-hidden="true" />{" "}
                  {readyExport?.gameId === save.gameId
                    ? localizer.message("ui.common.download")
                    : localizer.message("ui.saves.emulator.export")}
                </button>
                <button
                  className="btn slim ghost"
                  onClick={() => void deleteEmulatorSave(save.gameId).then(refresh).catch(reportActionError)}
                  type="button"
                >
                  <Trash2 aria-hidden="true" /> {localizer.message("ui.saves.emulator.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};

export { EmulatorSavesPanel, type EmulatorSaveImportRequest };
