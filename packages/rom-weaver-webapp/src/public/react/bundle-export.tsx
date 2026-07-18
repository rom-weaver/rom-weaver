import { useCallback, useEffect, useRef, useState } from "react";
import { browserRuntime } from "../../platform/browser/workflow-runtime.ts";
import {
  createProgressViewModel,
  createProgressViewModelFromEvent,
  type ProgressViewModel,
} from "../../presentation/workflow-presentation.ts";
import { createVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { ApplyWorkflowBundleSources } from "../../types/apply-workflow.ts";
import type { BundleHeaderMode, ParsedBundleCreateResult } from "../../types/bundle.ts";
import type { SourceRef } from "../../types/source.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";

/**
 * The apply form's bundle export flow reuses the leaves and metadata already
 * prepared by the live session. That keeps export out of the ingest/extract/
 * apply pipeline and keeps large outputs path-backed until download.
 */

/** "Bundle only" sentinel in the output-format select. */
const BUNDLE_ONLY_FORMAT = "bundle";

type BundleExportRow = {
  /** Leaf patch file name (what gets exported/bundled). */
  fileName: string;
  /** Source archive the leaf lives in, when it arrived inside one. */
  archiveFileName?: string;
  fileSize?: number;
  format?: string;
  default: boolean;
  id?: string;
  version?: string;
  author?: string;
  name?: string;
  description: string;
  /** Expected pre-apply ROM checksums ("algo=hex", comma-separable). */
  checks: string;
  outputChecks: string;
  label?: string;
  header?: BundleHeaderMode;
  /** Declared input basis, frozen at export: a user pin verbatim, or "base"
   * when the chain plan inferred it - so the applying side never has to
   * re-infer with possibly different evidence. Previous stays unwritten
   * (it is the schema default). */
  basis?: "base" | "previous";
};

type BundleExportSources = ApplyWorkflowBundleSources;

type BundleExportProgress = ProgressViewModel;
const CHECK_ALGORITHMS = ["crc32", "md5", "sha1"] as const;
const CHECK_LENGTHS = { crc32: 8, md5: 32, sha1: 40 } as const;

const disposeBundleOutput = (output: PublicOutput | null | undefined) => {
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

type UseBundleExportOptions = {
  /** Live session sources, read at export time. */
  getSessionSources: () => BundleExportSources;
  /** Live per-patch stack items (index-aligned with patches) for leaf names + header round-trips. */
  getStackItems: () => PatchStackItemState[];
  /** Stable patch-slot ids; unlike source signatures these survive replacement. */
  getPatchIds: () => string[];
  getName?: () => string;
  /** The output card's ROM header choice - a non-auto pick (only offered when the
   * staged ROM has a strippable header) exports as the bundle's `output.header`. */
  getOutputHeader?: () => "auto" | "keep" | "strip" | undefined;
  disabledPatchIds: ReadonlySet<string>;
  /** Originating per-patch metadata (name/label/description round-trips). */
  bundleMetaById: ReadonlyMap<string, BundlePatchMeta>;
  initialBundleRom?: boolean;
  initialFormat?: string;
  ready: boolean;
  onComplete?: (result: ParsedBundleCreateResult) => void;
};

const stripFileExtension = (fileName: string): string => {
  const trimmed = fileName.trim();
  const dotIndex = trimmed.lastIndexOf(".");
  return dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed;
};

/** Turn a bundle name into a safe bundle file base name. */
const slugFileName = (value: string): string =>
  value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");

const useBundleExport = ({
  getSessionSources,
  getPatchIds,
  getStackItems,
  getName,
  getOutputHeader,
  disabledPatchIds,
  bundleMetaById,
  initialBundleRom = false,
  initialFormat = "",
  ready,
  onComplete,
}: UseBundleExportOptions) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [format, setFormat] = useState(initialFormat);
  const [bundleRom, setBundleRom] = useState(initialBundleRom);
  const [progress, setProgress] = useState<BundleExportProgress | null>(null);
  const [downloadableOutput, setDownloadableOutput] = useState<PublicOutput | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const downloadableOutputRef = useRef<PublicOutput | null>(null);
  // The sources captured when the export ran, so the run stays aligned even if
  // the bench changes underneath it.
  const sourcesRef = useRef<BundleExportSources>({ patches: [], rom: null });

  useEffect(() => {
    setFormat(initialFormat);
    setBundleRom(initialBundleRom);
  }, [initialBundleRom, initialFormat]);

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
    const create = browserRuntime.bundle?.create;
    const exportName = getName?.().trim() || "";
    const sources = getSessionSources();
    sourcesRef.current = { patches: sources.patches.slice(), rom: sources.rom };
    const { rom, patches } = sources;
    if (!create) {
      setError("Bundle export is not available in this runtime");
      return;
    }
    if (!rom) {
      setError("A staged ROM is required to export a bundle");
      return;
    }
    if (!patches.length) {
      setError("At least one staged patch is required to export a bundle");
      return;
    }
    const items = getStackItems();
    const ids = getPatchIds();
    const exportRows: BundleExportRow[] = patches.map((patch, index) => {
      const id = ids[index] || "";
      const meta = id ? bundleMetaById.get(id) : undefined;
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
      const chainVerdict = item?.chainVerdict;
      const basis =
        meta?.basis ??
        (chainVerdict?.basis === "base" && chainVerdict.basisSource === "inferred_base"
          ? ("base" as const)
          : undefined);
      return {
        fileName,
        ...(archiveFileName && archiveFileName !== fileName ? { archiveFileName } : {}),
        default: !disabledPatchIds.has(id),
        id: meta?.id || id,
        ...(meta?.version ? { version: meta.version } : {}),
        ...(meta?.author ? { author: meta.author } : {}),
        ...(meta?.name ? { name: meta.name } : {}),
        checks,
        description: meta?.description || "",
        outputChecks,
        ...(meta?.label ? { label: meta.label } : {}),
        ...(headerChoice === "keep" || headerChoice === "strip" ? { header: headerChoice } : {}),
        ...(basis ? { basis } : {}),
      };
    });
    const stepProgress = (label: string) =>
      setProgress(
        createProgressViewModel({
          hasProgress: true,
          label,
          percent: 0,
          stage: "bundle",
        }),
      );
    setBusy(true);
    setError("");
    stepProgress("Preparing bundle export");
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
      stepProgress("Writing bundle");
      const wantsBundle = format !== BUNDLE_ONLY_FORMAT;
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
      // The exported rom.checks are the staged ROM's computed values; a
      // different expected base ROM is expressed as the first patch's input
      // checks (which the bundle schema prefers over rom.checks).
      const romChecksums = { ...rom.checksums };
      const romSize = rom.size;
      const { result, bundleOutput, archiveOutput } = await create({
        ...(bundleFileName ? { bundleFileName } : {}),
        ...(packagedRom ? { bundleRom: packagedRom } : {}),
        ...(exportName.trim() ? { outputName: exportName.trim() } : {}),
        ...(Object.keys(romChecksums).length ? { romChecksums: formatChecks(romChecksums) } : {}),
        ...(typeof romSize === "number" ? { romSize } : {}),
        ...(outputHeader === "keep" || outputHeader === "strip" ? { outputHeader } : {}),
        // The ROM is never distributed unless explicitly bundled: its bundle
        // entry keeps checks only and the applying user supplies the file.
        ...(bundleRom && wantsBundle ? {} : { noBundleRom: true }),
        onProgress: (event) => {
          setProgress(createProgressViewModelFromEvent(event, { hasProgress: true, stage: "bundle" }));
        },
        patches: patches.map((patch, index) => {
          const row = exportRows[index];
          return {
            fileName: patch.fileName,
            source: patch.source,
            ...(row?.id ? { id: row.id } : {}),
            ...(row?.version?.trim() ? { version: row.version.trim() } : {}),
            ...(row?.author?.trim() ? { author: row.author.trim() } : {}),
            ...(row?.default === false ? { optional: true } : {}),
            ...(row?.name ? { name: row.name } : {}),
            ...(row?.description.trim() ? { description: row.description.trim() } : {}),
            ...(row?.checks.trim() ? { inputChecks: row.checks.trim() } : {}),
            ...(row?.outputChecks.trim() ? { outputChecks: row.outputChecks.trim() } : {}),
            ...(row?.label ? { label: row.label } : {}),
            ...(row?.header ? { header: row.header } : {}),
            ...(row?.basis ? { basis: row.basis } : {}),
          };
        }),
        rom: { fileName: rom.fileName, source: rom.source },
        signal: abortController.signal,
      });
      outputs.push(bundleOutput, ...(archiveOutput ? [archiveOutput] : []));
      const downloadOutput = wantsBundle && archiveOutput ? archiveOutput : bundleOutput;
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
    bundleMetaById,
    onComplete,
    downloadExport,
    getPatchIds,
  ]);

  const cancelExport = useCallback(() => abortControllerRef.current?.abort(), []);

  // Changing what the bundle packs (format or ROM inclusion) invalidates an
  // already-created export - the action drops back to "create" instead of
  // offering a download that no longer matches the selection.
  const clearDownloadable = useCallback(() => {
    const output = downloadableOutputRef.current;
    if (!output) return;
    downloadableOutputRef.current = null;
    setDownloadableOutput(null);
    disposeBundleOutput(output);
  }, []);
  const selectFormat = useCallback(
    (value: string) => {
      clearDownloadable();
      setFormat(value);
    },
    [clearDownloadable],
  );
  const selectBundleRom = useCallback(
    (value: boolean) => {
      clearDownloadable();
      setBundleRom(value);
    },
    [clearDownloadable],
  );

  useEffect(
    () => () => {
      const output = downloadableOutputRef.current;
      downloadableOutputRef.current = null;
      disposeBundleOutput(output);
    },
    [],
  );

  return {
    bundleRom,
    busy,
    cancelExport,
    downloadable: downloadableOutput !== null,
    error,
    format,
    progress,
    ready,
    runExport,
    setBundleRom: selectBundleRom,
    setFormat: selectFormat,
  };
};

export { useBundleExport };
