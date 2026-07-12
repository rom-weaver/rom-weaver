import { useCallback, useEffect, useRef, useState } from "react";
import { browserRuntime } from "../../platform/browser/workflow-runtime.ts";
import {
  createProgressViewModel,
  createProgressViewModelFromEvent,
  type ProgressViewModel,
} from "../../presentation/workflow-presentation.ts";
import { createVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { ApplyWorkflowManifestSources } from "../../types/apply-workflow.ts";
import type { ManifestHeaderMode, ParsedManifestCreateResult } from "../../types/manifest.ts";
import type { SourceRef } from "../../types/source.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import { ROM_WEAVER_CREATE_CONTAINER_FORMATS } from "../../wasm/generated/rom-weaver-format-metadata.ts";
import { getBinarySourceListStableIds } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import type { ManifestPatchMeta } from "./use-manifest-apply-session.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";

/**
 * The apply form's manifest export flow reuses the leaves and metadata already
 * prepared by the live session. That keeps export out of the ingest/extract/
 * apply pipeline and keeps large outputs path-backed until download.
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
  default: boolean;
  name?: string;
  description: string;
  /** Expected pre-apply ROM checksums ("algo=hex", comma-separable). */
  checks: string;
  outputChecks: string;
  label?: string;
  header?: ManifestHeaderMode;
};

type ManifestExportSources = ApplyWorkflowManifestSources;

type ManifestExportProgress = ProgressViewModel;
const CHECK_ALGORITHMS = ["crc32", "md5", "sha1"] as const;
const CHECK_LENGTHS = { crc32: 8, md5: 32, sha1: 40 } as const;

const disposeManifestOutput = (output: PublicOutput | null | undefined) => {
  if (output) void output.dispose().catch(() => undefined);
};

const parseChecks = (value: string, label: string): Record<string, string> => {
  const checks: Record<string, string> = {};
  for (const token of value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [rawAlgorithm, rawValue, ...extra] = token.split("=");
    const algorithm = rawAlgorithm?.trim().toLowerCase().replace("sha-1", "sha1");
    const checksum = rawValue?.trim().toLowerCase();
    if (extra.length || !algorithm || !checksum || !CHECK_ALGORITHMS.includes(algorithm as never)) {
      throw new Error(`${label} contains an invalid checksum entry`);
    }
    const expectedLength = CHECK_LENGTHS[algorithm as keyof typeof CHECK_LENGTHS];
    if (!new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(checksum)) {
      throw new Error(`${label} ${algorithm.toUpperCase()} must be ${expectedLength} hexadecimal characters`);
    }
    checks[algorithm] = checksum;
  }
  return checks;
};

const formatChecks = (checks: Record<string, string>) =>
  CHECK_ALGORITHMS.map((algorithm) => (checks[algorithm] ? `${algorithm}=${checks[algorithm]}` : ""))
    .filter(Boolean)
    .join(",");

const embeddedChecks = (item: PatchStackItemState | undefined, side: "in" | "out"): Record<string, string> => {
  const checks: Record<string, string> = {};
  for (const entry of item?.validationValues || []) {
    const [rawLabel, rawValue] = entry.split("=", 2);
    const label = rawLabel?.trim().toLowerCase();
    const value = rawValue?.trim().toLowerCase();
    if (!(label?.startsWith(`${side} `) && value)) continue;
    const algorithm = label.slice(side.length + 1).replace("sha-1", "sha1");
    if (CHECK_ALGORITHMS.includes(algorithm as never)) checks[algorithm] = value as string;
  }
  return checks;
};

type UseManifestExportOptions = {
  /** Live session sources, read at dialog-open time. */
  getSessionSources: () => ManifestExportSources;
  /** Live per-patch stack items (index-aligned with patches) for leaf names + header round-trips. */
  getStackItems: () => PatchStackItemState[];
  getName?: () => string;
  /** The output card's ROM header choice - a non-auto pick (only offered when the
   * staged ROM has a strippable header) exports as the manifest's `output.header`. */
  getOutputHeader?: () => "auto" | "keep" | "strip" | undefined;
  disabledPatchIds: ReadonlySet<string>;
  /** Originating per-patch metadata (name/label/description round-trips). */
  manifestMetaById: ReadonlyMap<string, ManifestPatchMeta>;
  initialName?: string;
  ready: boolean;
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
  getName,
  getOutputHeader,
  disabledPatchIds,
  manifestMetaById,
  initialName,
  ready,
  onComplete,
}: UseManifestExportOptions) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState(initialName || "");
  const [format, setFormat] = useState<string>(MANIFEST_BUNDLE_FORMATS[0] || MANIFEST_ONLY_FORMAT);
  const [bundleRom, setBundleRom] = useState(false);
  const [rows, setRows] = useState<ManifestExportRow[]>([]);
  const [progress, setProgress] = useState<ManifestExportProgress | null>(null);
  const [downloadableOutput, setDownloadableOutput] = useState<PublicOutput | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const downloadableOutputRef = useRef<PublicOutput | null>(null);
  // The sources captured when the dialog opened, so the export run stays aligned with its rows even
  // if the bench changes underneath the open dialog.
  const sourcesRef = useRef<ManifestExportSources>({ patches: [], rom: null });

  const openDialog = useCallback(() => {
    const sources = getSessionSources();
    const items = getStackItems();
    const ids = getBinarySourceListStableIds(sources.patches.map((patch) => patch.originalSource as BinarySource));
    sourcesRef.current = { patches: sources.patches.slice(), rom: sources.rom };
    setRows(
      sources.patches.map((patch, index) => {
        const id = ids[index] || "";
        const meta = id ? manifestMetaById.get(id) : undefined;
        const item = items[index];
        const fileName = item?.fileName?.trim() || patch.fileName || `patch-${index + 1}.bin`;
        const archiveFileName = item?.archiveFileName?.trim();
        const headerChoice = item?.headerChoice;
        // Toggled-off patches export as `optional`; a manifest session's locked
        // `required` entries stay required; everything else is `default`.
        const defaultEnabled = !disabledPatchIds.has(id);
        return {
          fileName,
          ...(archiveFileName && archiveFileName !== fileName ? { archiveFileName } : {}),
          ...(item?.fileSize ? { fileSize: item.fileSize } : {}),
          ...(item?.format ? { format: item.format } : {}),
          default: defaultEnabled,
          ...(meta?.name ? { name: meta.name } : {}),
          checks: "",
          description: meta?.description || "",
          outputChecks: "",
          ...(meta?.label ? { label: meta.label } : {}),
          ...(headerChoice === "keep" || headerChoice === "strip" ? { header: headerChoice } : {}),
        };
      }),
    );
    // Auto-name: the originating manifest session's name, else the ROM file
    // name (else the first patch's) without its extension.
    const romName = sources.rom?.fileName || "";
    const firstPatchName = items[0]?.fileName || sources.patches[0]?.fileName || "";
    setName(initialName || stripFileExtension(romName) || stripFileExtension(firstPatchName));
    setFormat(MANIFEST_BUNDLE_FORMATS[0] || MANIFEST_ONLY_FORMAT);
    setBundleRom(false);
    setProgress(null);
    setError("");
    setOpen(true);
  }, [disabledPatchIds, getSessionSources, getStackItems, initialName, manifestMetaById]);

  const closeDialog = useCallback(() => {
    if (!busy) setOpen(false);
  }, [busy]);

  const setRowDefault = useCallback((index: number, defaultEnabled: boolean) => {
    setRows((previous) =>
      previous.map((row, rowIndex) => (rowIndex === index ? { ...row, default: defaultEnabled } : row)),
    );
  }, []);

  const setRowDescription = useCallback((index: number, description: string) => {
    setRows((previous) => previous.map((row, rowIndex) => (rowIndex === index ? { ...row, description } : row)));
  }, []);

  const setRowChecks = useCallback((index: number, checks: string) => {
    setRows((previous) => previous.map((row, rowIndex) => (rowIndex === index ? { ...row, checks } : row)));
  }, []);

  const downloadExport = useCallback(async () => {
    const output = downloadableOutputRef.current;
    if (!output) return;
    setBusy(true);
    setError("");
    setProgress(
      createProgressViewModel({
        hasProgress: true,
        label: `Downloading ${output.fileName}`,
        stage: "download",
      }),
    );
    try {
      await browserRuntime.publicOutput.saveAs(output);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }, []);

  const runExport = useCallback(async () => {
    if (downloadableOutputRef.current) {
      await downloadExport();
      return;
    }
    const create = browserRuntime.manifest?.create;
    const exportName = getName?.().trim() || name;
    const sources = getSessionSources();
    sourcesRef.current = { patches: sources.patches.slice(), rom: sources.rom };
    const { rom, patches } = sources;
    if (!create) {
      setError("Manifest export is not available in this runtime");
      return;
    }
    if (!rom) {
      setError("A staged ROM is required to export a manifest");
      return;
    }
    if (!patches.length) {
      setError("At least one staged patch is required to export a manifest");
      return;
    }
    const items = getStackItems();
    const ids = getBinarySourceListStableIds(patches.map((patch) => patch.originalSource as BinarySource));
    const exportRows: ManifestExportRow[] = patches.map((patch, index) => {
      const id = ids[index] || "";
      const meta = id ? manifestMetaById.get(id) : undefined;
      const item = items[index];
      const fileName = item?.fileName?.trim() || patch.fileName || `patch-${index + 1}.bin`;
      const archiveFileName = item?.archiveFileName?.trim();
      const headerChoice = item?.headerChoice;
      const checks = Object.entries(meta?.inputChecks?.checksums || {})
        .filter(([, value]) => value.trim())
        .map(([algorithm, value]) => `${algorithm}=${value.trim()}`)
        .join(",");
      const outputChecks = Object.entries(meta?.outputChecks?.checksums || {})
        .filter(([, value]) => value.trim())
        .map(([algorithm, value]) => `${algorithm}=${value.trim()}`)
        .join(",");
      return {
        fileName,
        ...(archiveFileName && archiveFileName !== fileName ? { archiveFileName } : {}),
        default: !disabledPatchIds.has(id),
        ...(meta?.name ? { name: meta.name } : {}),
        checks,
        description: meta?.description || "",
        outputChecks,
        ...(meta?.label ? { label: meta.label } : {}),
        ...(headerChoice === "keep" || headerChoice === "strip" ? { header: headerChoice } : {}),
      };
    });
    const stepProgress = (label: string) =>
      setProgress(
        createProgressViewModel({
          hasProgress: true,
          label,
          percent: 0,
          stage: "manifest",
        }),
      );
    setBusy(true);
    setError("");
    stepProgress("Preparing manifest export");
    const outputs: PublicOutput[] = [];
    const compressedRomOutputs: PublicOutput[] = [];
    const retainedOutputs = new Set<PublicOutput>();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    try {
      // Per-patch entries carry ONLY checks the author specified (typed in the
      // dialog or the patch's Options) - chain intermediates are never hashed
      // or attached. A typed check may not contradict one built into the patch
      // file itself.
      const validateRowChecks = (raw: string, builtIn: Record<string, string>, label: string): string => {
        const explicit = parseChecks(raw, label);
        for (const algorithm of CHECK_ALGORITHMS) {
          if (builtIn[algorithm] && explicit[algorithm] && builtIn[algorithm] !== explicit[algorithm]) {
            throw new Error(`${label} ${algorithm.toUpperCase()} conflicts with the checksum built into the patch`);
          }
        }
        return formatChecks(explicit);
      };
      for (const [index] of patches.entries()) {
        const row = exportRows[index];
        if (!row) continue;
        row.checks = validateRowChecks(row.checks, embeddedChecks(items[index], "in"), `Patch ${index + 1} input`);
        row.outputChecks = validateRowChecks(
          row.outputChecks,
          embeddedChecks(items[index], "out"),
          `Patch ${index + 1} output`,
        );
      }
      stepProgress("Writing manifest");
      const wantsBundle = format !== MANIFEST_ONLY_FORMAT;
      const bundleFileName = wantsBundle ? `${slugFileName(exportName) || "rw-bundle"}.${format}` : undefined;
      let packagedRom: { fileName: string; source: SourceRef } | undefined;
      if (bundleRom && wantsBundle) {
        const originalName = getReactBinarySourceFileName(rom.originalSource as BinarySource, rom.fileName);
        const existingFormat = originalName.split(".").pop()?.toLowerCase();
        const recommendedRomFormat = rom.recommendedFormat?.toLowerCase();
        if (["chd", "rvz", "z3ds"].includes(existingFormat || "")) {
          packagedRom = { fileName: originalName, source: rom.originalSource };
        } else if (["chd", "rvz", "z3ds"].includes(recommendedRomFormat || "")) {
          const targetFormat = recommendedRomFormat as "chd" | "rvz" | "z3ds";
          const createCompression = browserRuntime.compression.create;
          if (!createCompression) throw new Error("ROM compression is not available in this runtime");
          stepProgress(`ROM compression · ${targetFormat.toUpperCase()}`);
          const outputName = `${stripFileExtension(rom.fileName)}.${targetFormat}`;
          const compressed = await createCompression({
            fileName: rom.fileName,
            format: targetFormat,
            outputName,
            romSpecific: { [targetFormat]: { sourceFileName: rom.fileName } },
            source: rom.source,
          });
          const output = "output" in compressed ? compressed.output : compressed;
          compressedRomOutputs.push(output);
          packagedRom = {
            fileName: outputName,
            source: createVfsFileRef(output.vfs, output.path, { fileName: outputName }),
          };
        } else {
          packagedRom = { fileName: rom.fileName, source: rom.source };
        }
      }
      const outputHeader = getOutputHeader?.();
      const { result, manifestOutput, bundleOutput } = await create({
        ...(bundleFileName ? { bundleFileName } : {}),
        ...(packagedRom ? { bundleRom: packagedRom } : {}),
        ...(exportName.trim() ? { outputName: exportName.trim() } : {}),
        ...(rom.checksums ? { romChecksums: formatChecks(rom.checksums) } : {}),
        ...(typeof rom.size === "number" ? { romSize: rom.size } : {}),
        ...(outputHeader === "keep" || outputHeader === "strip" ? { outputHeader } : {}),
        // The ROM is never distributed unless explicitly bundled: its manifest
        // entry keeps checks only and the applying user supplies the file.
        ...(bundleRom && wantsBundle ? {} : { noBundleRom: true }),
        onProgress: (event) => {
          setProgress(createProgressViewModelFromEvent(event, { hasProgress: true, stage: "manifest" }));
        },
        patches: patches.map((patch, index) => {
          const row = exportRows[index];
          return {
            fileName: patch.fileName,
            source: patch.source,
            ...(row?.default === false ? { optional: true } : {}),
            ...(row?.name ? { name: row.name } : {}),
            ...(row?.description.trim() ? { description: row.description.trim() } : {}),
            ...(row?.checks.trim() ? { inputChecks: row.checks.trim() } : {}),
            ...(row?.outputChecks.trim() ? { outputChecks: row.outputChecks.trim() } : {}),
            ...(row?.label ? { label: row.label } : {}),
            ...(row?.header ? { header: row.header } : {}),
          };
        }),
        rom: { fileName: rom.fileName, source: rom.source },
        signal: abortController.signal,
      });
      outputs.push(manifestOutput, ...(bundleOutput ? [bundleOutput] : []));
      const downloadOutput = wantsBundle && bundleOutput ? bundleOutput : manifestOutput;
      downloadableOutputRef.current = downloadOutput;
      setDownloadableOutput(downloadOutput);
      retainedOutputs.add(downloadOutput);
      onComplete?.(result);
      setProgress(
        createProgressViewModel({
          hasProgress: true,
          label: `Downloading ${downloadOutput.fileName}`,
          stage: "download",
        }),
      );
      await browserRuntime.publicOutput.saveAs(downloadOutput);
      setOpen(false);
    } catch (runError) {
      if (!abortController.signal.aborted) {
        setError(runError instanceof Error ? runError.message : String(runError));
      }
    } finally {
      if (abortControllerRef.current === abortController) abortControllerRef.current = null;
      await Promise.all(
        [...outputs, ...compressedRomOutputs]
          .filter((output) => !retainedOutputs.has(output))
          .map((output) => output.dispose().catch(() => undefined)),
      );
      setProgress(null);
      setBusy(false);
    }
  }, [
    bundleRom,
    disabledPatchIds,
    format,
    getSessionSources,
    getStackItems,
    getName,
    getOutputHeader,
    manifestMetaById,
    name,
    onComplete,
    ready,
    downloadExport,
  ]);

  const cancelExport = useCallback(() => abortControllerRef.current?.abort(), []);

  useEffect(
    () => () => {
      const output = downloadableOutputRef.current;
      downloadableOutputRef.current = null;
      disposeManifestOutput(output);
    },
    [],
  );

  return {
    bundleRom,
    busy,
    cancelExport,
    closeDialog,
    downloadable: downloadableOutput !== null,
    error,
    format,
    name,
    open,
    openDialog,
    progress,
    ready,
    rows,
    runExport,
    setBundleRom,
    setFormat,
    setName,
    setRowChecks,
    setRowDefault,
    setRowDescription,
  };
};

export { useManifestExport };
