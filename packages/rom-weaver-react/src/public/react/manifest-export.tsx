import { useCallback, useRef, useState } from "react";
import { getPatchFileBytes, getPatchFileCleanup, getPatchFileExternalSource } from "../../lib/input/binary-service.ts";
import { prepareInputFile } from "../../lib/input/input-preparation-service.ts";
import { triggerBrowserDownload } from "../../platform/browser/browser-download.ts";
import { browserRuntime } from "../../platform/browser/workflow-runtime.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import type { ManifestHeaderMode, ManifestPatchStatus, ParsedManifestCreateResult } from "../../types/manifest.ts";
import { ROM_WEAVER_CREATE_CONTAINER_FORMATS } from "../../wasm/generated/rom-weaver-format-metadata.ts";
import { InlineProgress, Notice } from "./components/ds/feedback.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { Modal } from "./components/ds/index.ts";
import { getBinarySourceListStableIds } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import type { ManifestPatchMeta } from "./use-manifest-apply-session.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";

/**
 * The apply form's "Export manifest…" flow: a dialog collecting a manifest
 * name/description plus per-patch status/description/ROM-check requirements
 * (prefilled from the live enablement state and any originating manifest
 * session), then a `manifest create` run over the CURRENT session's files.
 * Patch sources are resolved to their extracted leaves first, so a bundle
 * carries the actual patch files rather than the archives they arrived in.
 * The emitted rw.json (or the bundle archive) goes straight to the browser
 * download path.
 */

/** General-purpose multi-file archives the bundle output can be packed as. */
const MANIFEST_BUNDLE_FORMATS = ["zip", "7z"].filter((format) =>
  (ROM_WEAVER_CREATE_CONTAINER_FORMATS as readonly string[]).includes(format),
);

/** "Manifest only" sentinel in the output-format select. */
const MANIFEST_ONLY_FORMAT = "manifest";

type ManifestExportRow = {
  /** Leaf patch file name (what gets exported/bundled). */
  fileName: string;
  /** Source archive the leaf lives in, when it arrived inside one. */
  archiveFileName?: string;
  fileSize?: number;
  format?: string;
  status: ManifestPatchStatus;
  name?: string;
  description: string;
  /** Expected pre-apply ROM checksums ("algo=hex", comma-separable). */
  checks: string;
  label?: string;
  header?: ManifestHeaderMode;
};

type ManifestExportSources = { inputs: BinarySource[]; patches: BinarySource[] };

type ManifestExportProgress = { label?: string; percent?: number | null };

type UseManifestExportOptions = {
  /** Live session sources, read at dialog-open time. */
  getSessionSources: () => ManifestExportSources;
  /** Live per-patch stack items (index-aligned with patches) for leaf names + header round-trips. */
  getStackItems: () => PatchStackItemState[];
  disabledPatchIds: ReadonlySet<string>;
  lockedPatchIds: ReadonlySet<string>;
  /** Originating manifest session metadata (name/label/description round-trips). */
  manifestMetaById: ReadonlyMap<string, ManifestPatchMeta>;
  initialName?: string;
  initialDescription?: string;
  onComplete?: (result: ParsedManifestCreateResult) => void;
};

const stripFileExtension = (fileName: string): string => {
  const trimmed = fileName.trim();
  const dotIndex = trimmed.lastIndexOf(".");
  return dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed;
};

/** Turn a manifest name into a safe bundle file base name. */
const slugFileName = (value: string): string =>
  value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");

const useManifestExport = ({
  getSessionSources,
  getStackItems,
  disabledPatchIds,
  lockedPatchIds,
  manifestMetaById,
  initialName,
  initialDescription,
  onComplete,
}: UseManifestExportOptions) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [format, setFormat] = useState<string>(MANIFEST_BUNDLE_FORMATS[0] || MANIFEST_ONLY_FORMAT);
  const [bundleRom, setBundleRom] = useState(false);
  const [rows, setRows] = useState<ManifestExportRow[]>([]);
  // Phase drives the fallback progress label; wasm progress events override it.
  const [phase, setPhase] = useState<"idle" | "preparing" | "exporting">("idle");
  const [progress, setProgress] = useState<ManifestExportProgress | null>(null);
  // The sources captured when the dialog opened, so the export run stays aligned with its rows even
  // if the bench changes underneath the open dialog.
  const sourcesRef = useRef<ManifestExportSources>({ inputs: [], patches: [] });

  const openDialog = useCallback(() => {
    const sources = getSessionSources();
    const items = getStackItems();
    const ids = getBinarySourceListStableIds(sources.patches);
    sourcesRef.current = { inputs: sources.inputs.slice(), patches: sources.patches.slice() };
    setRows(
      sources.patches.map((patch, index) => {
        const id = ids[index] || "";
        const meta = id ? manifestMetaById.get(id) : undefined;
        const item = items[index];
        const sourceName = getReactBinarySourceFileName(patch, `patch-${index + 1}.bin`);
        const fileName = item?.fileName?.trim() || sourceName;
        const archiveFileName = item?.archiveFileName?.trim();
        const headerChoice = item?.headerChoice;
        // Toggled-off patches export as `optional`; a manifest session's locked
        // `required` entries stay required; everything else is `default`.
        const status: ManifestPatchStatus = disabledPatchIds.has(id)
          ? "optional"
          : lockedPatchIds.has(id)
            ? "required"
            : "default";
        return {
          fileName,
          ...(archiveFileName && archiveFileName !== fileName ? { archiveFileName } : {}),
          ...(item?.fileSize ? { fileSize: item.fileSize } : {}),
          ...(item?.format ? { format: item.format } : {}),
          status,
          ...(meta?.name ? { name: meta.name } : {}),
          checks: "",
          description: meta?.description || "",
          ...(meta?.label ? { label: meta.label } : {}),
          ...(headerChoice === "keep" || headerChoice === "strip" ? { header: headerChoice } : {}),
        };
      }),
    );
    // Auto-name: the originating manifest session's name, else the ROM file
    // name (else the first patch's) without its extension.
    const romName = sources.inputs[0] ? getReactBinarySourceFileName(sources.inputs[0], "") : "";
    const firstPatchName =
      items[0]?.fileName || (sources.patches[0] ? getReactBinarySourceFileName(sources.patches[0], "") : "");
    setName(initialName || stripFileExtension(romName) || stripFileExtension(firstPatchName));
    setDescription(initialDescription || "");
    setFormat(MANIFEST_BUNDLE_FORMATS[0] || MANIFEST_ONLY_FORMAT);
    setBundleRom(false);
    setPhase("idle");
    setProgress(null);
    setError("");
    setOpen(true);
  }, [
    disabledPatchIds,
    getSessionSources,
    getStackItems,
    initialDescription,
    initialName,
    lockedPatchIds,
    manifestMetaById,
  ]);

  const closeDialog = useCallback(() => {
    if (!busy) setOpen(false);
  }, [busy]);

  const setRowStatus = useCallback((index: number, status: ManifestPatchStatus) => {
    setRows((previous) => previous.map((row, rowIndex) => (rowIndex === index ? { ...row, status } : row)));
  }, []);

  const setRowDescription = useCallback((index: number, description: string) => {
    setRows((previous) => previous.map((row, rowIndex) => (rowIndex === index ? { ...row, description } : row)));
  }, []);

  const setRowChecks = useCallback((index: number, checks: string) => {
    setRows((previous) => previous.map((row, rowIndex) => (rowIndex === index ? { ...row, checks } : row)));
  }, []);

  const runExport = useCallback(async () => {
    const create = browserRuntime.manifest?.create;
    const { inputs, patches } = sourcesRef.current;
    if (!(create && patches.length)) return;
    setBusy(true);
    setError("");
    setPhase("preparing");
    setProgress(null);
    const cleanups: Array<() => Promise<void> | void> = [];
    // Resolve a session source to its patch/ROM leaf so bundles carry the
    // actual file, not the archive it arrived in. Degrades to the original
    // source when the leaf cannot be materialized. Only leaves the resolver
    // actually extracted are cleaned up afterwards — a passthrough leaf shares
    // its backing resources with the live form session.
    const prepareLeafSource = async (
      source: BinarySource,
      role: "rom" | "patch",
      fallbackFileName: string,
      selectedArchiveEntry: string | undefined,
      index: number,
    ): Promise<{ fileName: string; source: unknown }> => {
      try {
        const prepared = await prepareInputFile(source, role, undefined, browserRuntime, selectedArchiveEntry, index);
        const leaf = prepared.file;
        if (prepared.wasDecompressed) {
          const cleanup = getPatchFileCleanup(leaf);
          if (cleanup) cleanups.push(cleanup);
        }
        const fileName = leaf.fileName || fallbackFileName;
        const external = getPatchFileExternalSource(leaf, fileName);
        if (external) return { fileName, source: external.source };
        // Copy into a plain ArrayBuffer-backed view: the leaf bytes may sit in
        // shared wasm memory, which File() rejects.
        const bytes = getPatchFileBytes(leaf);
        const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
        copy.set(bytes);
        return { fileName, source: new File([copy], fileName) };
      } catch {
        return { fileName: fallbackFileName, source };
      }
    };
    try {
      const rom = inputs[0];
      const romLeaf = rom
        ? await prepareLeafSource(rom, "rom", getReactBinarySourceFileName(rom, "rom.bin"), undefined, 0)
        : undefined;
      const patchLeaves = [];
      for (const [index, patch] of patches.entries()) {
        const row = rows[index];
        const fallbackFileName = row?.fileName || getReactBinarySourceFileName(patch, `patch-${index + 1}.bin`);
        // When the leaf lives inside an archive, its own file name selects the
        // matching entry (mirrors the apply workflow's selected-entry routing).
        const selectedArchiveEntry = row?.archiveFileName ? row.fileName : undefined;
        patchLeaves.push(await prepareLeafSource(patch, "patch", fallbackFileName, selectedArchiveEntry, index));
      }
      setPhase("exporting");
      const wantsBundle = format !== MANIFEST_ONLY_FORMAT;
      const bundleFileName = wantsBundle ? `${slugFileName(name) || "rw-bundle"}.${format}` : undefined;
      const { result, manifestFile, bundleFile } = await create({
        ...(bundleFileName ? { bundleFileName } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        // The ROM is never distributed unless explicitly bundled: its manifest
        // entry keeps checks only and the applying user supplies the file.
        ...(bundleRom && wantsBundle ? {} : { noBundleRom: true }),
        onProgress: (event) => {
          setProgress({
            ...(event.label || event.message ? { label: event.label || event.message } : {}),
            percent: typeof event.percent === "number" ? event.percent : null,
          });
        },
        patches: patchLeaves.map((leaf, index) => {
          const row = rows[index];
          return {
            fileName: leaf.fileName,
            source: leaf.source,
            status: row?.status || "default",
            ...(row?.name ? { name: row.name } : {}),
            ...(row?.description.trim() ? { description: row.description.trim() } : {}),
            ...(row?.checks.trim() ? { checks: row.checks.trim() } : {}),
            ...(row?.label ? { label: row.label } : {}),
            ...(row?.header ? { header: row.header } : {}),
          };
        }),
        ...(romLeaf ? { rom: { fileName: romLeaf.fileName, source: romLeaf.source } } : {}),
      });
      onComplete?.(result);
      const downloadFile = wantsBundle && bundleFile ? bundleFile : manifestFile;
      await triggerBrowserDownload(downloadFile, downloadFile.name);
      setOpen(false);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      await Promise.all(cleanups.map((cleanup) => Promise.resolve(cleanup()).catch(() => undefined)));
      setPhase("idle");
      setProgress(null);
      setBusy(false);
    }
  }, [bundleRom, description, format, name, onComplete, rows]);

  return {
    bundleRom,
    busy,
    closeDialog,
    description,
    error,
    format,
    name,
    open,
    openDialog,
    phase,
    progress,
    rows,
    runExport,
    setBundleRom,
    setDescription,
    setFormat,
    setName,
    setRowChecks,
    setRowDescription,
    setRowStatus,
  };
};

type ManifestExportDialogProps = ReturnType<typeof useManifestExport>;

const MANIFEST_STATUS_VALUES: ManifestPatchStatus[] = ["required", "default", "optional", "disabled"];

const ManifestExportDialog = (props: ManifestExportDialogProps) => {
  const localizer = useUiLocalizer();
  const wantsBundle = props.format !== MANIFEST_ONLY_FORMAT;
  const progressLabel =
    props.progress?.label ||
    (props.phase === "preparing"
      ? localizer.message("ui.manifestExport.preparing")
      : localizer.message("ui.manifestExport.exporting"));
  const progressPercent = typeof props.progress?.percent === "number" ? props.progress.percent : null;
  return (
    <Modal
      onClose={props.closeDialog}
      open={props.open}
      title={localizer.message("ui.manifestExport.title")}
      variant="manifest-export-modal"
    >
      <div className="ofld">
        <label className="ofld-l" htmlFor="rom-weaver-manifest-export-name">
          {localizer.message("ui.manifestExport.name")}
        </label>
        <input
          className="input"
          disabled={props.busy}
          id="rom-weaver-manifest-export-name"
          onChange={(event) => props.setName(event.currentTarget.value)}
          type="text"
          value={props.name}
        />
      </div>
      <div className="ofld">
        <label className="ofld-l" htmlFor="rom-weaver-manifest-export-description">
          {localizer.message("ui.manifestExport.description")}
        </label>
        <textarea
          className="input tarea"
          disabled={props.busy}
          id="rom-weaver-manifest-export-description"
          onChange={(event) => props.setDescription(event.currentTarget.value)}
          rows={2}
          value={props.description}
        />
      </div>
      <div className="descblk" id="rom-weaver-manifest-export-patches">
        <div className="k">{localizer.message("ui.manifestExport.patches")}</div>
        <div className="cards patch-cards">
          {props.rows.map((row, index) => (
            <FileCard
              key={`${index}:${row.fileName}`}
              meta={
                <>
                  {row.fileSize ? <span className="fsize mono">{formatByteSize(row.fileSize)}</span> : null}
                  {row.format ? <span className="meta-fmt mono">{row.format.toLowerCase()}</span> : null}
                  {row.label ? <span className="meta-fmt mono">{row.label}</span> : null}
                  {row.archiveFileName ? (
                    <span className="meta-fmt mono">
                      {localizer.message("ui.manifestExport.fromArchive", { name: row.archiveFileName })}
                    </span>
                  ) : null}
                </>
              }
              name={<span className="mono">{row.name || row.fileName}</span>}
            >
              <div className="patch-body">
                <div className="patch-body-inner">
                  <div className="optsgrid">
                    <div className="ofld">
                      <label className="ofld-l" htmlFor={`rom-weaver-manifest-export-status-${index}`}>
                        {localizer.message("ui.manifestExport.statusLabel", { n: index + 1 })}
                      </label>
                      <select
                        className="select"
                        disabled={props.busy}
                        id={`rom-weaver-manifest-export-status-${index}`}
                        onChange={(event) =>
                          props.setRowStatus(index, event.currentTarget.value as ManifestPatchStatus)
                        }
                        value={row.status}
                      >
                        {MANIFEST_STATUS_VALUES.map((status) => (
                          <option key={status} value={status}>
                            {localizer.message(`ui.manifestExport.status.${status}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="ofld">
                      <label className="ofld-l" htmlFor={`rom-weaver-manifest-export-checks-${index}`}>
                        {localizer.message("ui.manifestExport.patchChecks")}
                      </label>
                      <input
                        className="input mono"
                        disabled={props.busy}
                        id={`rom-weaver-manifest-export-checks-${index}`}
                        onChange={(event) => props.setRowChecks(index, event.currentTarget.value)}
                        placeholder="crc32=deadbeef, md5=…"
                        type="text"
                        value={row.checks}
                      />
                    </div>
                  </div>
                  <div className="ofld">
                    <label className="ofld-l" htmlFor={`rom-weaver-manifest-export-desc-${index}`}>
                      {localizer.message("ui.manifestExport.description")}
                    </label>
                    <textarea
                      className="input tarea"
                      disabled={props.busy}
                      id={`rom-weaver-manifest-export-desc-${index}`}
                      onChange={(event) => props.setRowDescription(index, event.currentTarget.value)}
                      rows={2}
                      value={row.description}
                    />
                  </div>
                </div>
              </div>
            </FileCard>
          ))}
        </div>
      </div>
      <div className="ofld">
        <label className="ofld-l" htmlFor="rom-weaver-manifest-export-format">
          {localizer.message("ui.manifestExport.output")}
        </label>
        <select
          className="select"
          disabled={props.busy}
          id="rom-weaver-manifest-export-format"
          onChange={(event) => props.setFormat(event.currentTarget.value)}
          value={props.format}
        >
          {MANIFEST_BUNDLE_FORMATS.map((format) => (
            <option key={format} value={format}>
              {localizer.message("ui.manifestExport.format.bundle", { format: `.${format}` })}
            </option>
          ))}
          <option value={MANIFEST_ONLY_FORMAT}>{localizer.message("ui.manifestExport.format.manifestOnly")}</option>
        </select>
      </div>
      {wantsBundle ? (
        <label className="checkrow">
          <input
            checked={props.bundleRom}
            disabled={props.busy}
            id="rom-weaver-manifest-export-bundle-rom"
            onChange={(event) => props.setBundleRom(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{localizer.message("ui.manifestExport.bundleRom")}</span>
        </label>
      ) : null}
      {props.busy ? (
        <InlineProgress
          id="rom-weaver-manifest-export-progress"
          indeterminate={progressPercent === null}
          label={progressLabel}
          percent={progressPercent}
          value={progressPercent === null ? "" : `${Math.round(progressPercent)}%`}
        />
      ) : null}
      {props.error ? (
        <Notice id="rom-weaver-manifest-export-error" level="error">
          {localizer.message("ui.manifestExport.error")}: {props.error}
        </Notice>
      ) : null}
      <div className="c-actions">
        <button className="btn ghost" disabled={props.busy} onClick={props.closeDialog} type="button">
          {localizer.message("ui.common.cancel")}
        </button>
        <button
          className="btn primary"
          disabled={props.busy || !props.rows.length}
          id="rom-weaver-manifest-export-run"
          onClick={() => void props.runExport()}
          type="button"
        >
          {localizer.message("ui.manifestExport.export")}
        </button>
      </div>
    </Modal>
  );
};

export { ManifestExportDialog, useManifestExport };
