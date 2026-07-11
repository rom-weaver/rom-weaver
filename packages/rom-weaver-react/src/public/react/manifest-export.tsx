import { useCallback, useRef, useState } from "react";
import { getPatchFileBytes, getPatchFileCleanup, getPatchFileExternalSource } from "../../lib/input/binary-service.ts";
import { prepareInputFile } from "../../lib/input/input-preparation-service.ts";
import { triggerBrowserDownload } from "../../platform/browser/browser-download.ts";
import { browserRuntime } from "../../platform/browser/workflow-runtime.ts";
import type { ManifestHeaderMode, ParsedManifestCreateResult } from "../../types/manifest.ts";
import type { SourceRef } from "../../types/source.ts";
import { ROM_WEAVER_CREATE_CONTAINER_FORMATS } from "../../wasm/generated/rom-weaver-format-metadata.ts";
import { getBinarySourceListStableIds } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import type { ManifestPatchMeta } from "./use-manifest-apply-session.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";

/**
 * The apply form's manifest export flow collects per-patch metadata and ROM
 * checks from the live session, then runs `manifest create` over its files.
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
  default: boolean;
  name?: string;
  description: string;
  /** Expected pre-apply ROM checksums ("algo=hex", comma-separable). */
  checks: string;
  outputChecks: string;
  label?: string;
  header?: ManifestHeaderMode;
};

type ManifestExportSources = { inputs: BinarySource[]; patches: BinarySource[] };

type ManifestExportProgress = { label?: string; percent?: number | null };
const CHECK_ALGORITHMS = ["crc32", "md5", "sha1"] as const;
const CHECK_LENGTHS = { crc32: 8, md5: 32, sha1: 40 } as const;

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
  onComplete,
}: UseManifestExportOptions) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState(initialName || "");
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
    const romName = sources.inputs[0] ? getReactBinarySourceFileName(sources.inputs[0], "") : "";
    const firstPatchName =
      items[0]?.fileName || (sources.patches[0] ? getReactBinarySourceFileName(sources.patches[0], "") : "");
    setName(initialName || stripFileExtension(romName) || stripFileExtension(firstPatchName));
    setFormat(MANIFEST_BUNDLE_FORMATS[0] || MANIFEST_ONLY_FORMAT);
    setBundleRom(false);
    setPhase("idle");
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

  const runExport = useCallback(async () => {
    const create = browserRuntime.manifest?.create;
    const exportName = getName?.().trim() || name;
    const sources = getSessionSources();
    const { inputs, patches } = sources;
    if (!(create && patches.length)) return;
    const items = getStackItems();
    const ids = getBinarySourceListStableIds(patches);
    const exportRows: ManifestExportRow[] = patches.map((patch, index) => {
      const id = ids[index] || "";
      const meta = id ? manifestMetaById.get(id) : undefined;
      const item = items[index];
      const sourceName = getReactBinarySourceFileName(patch, `patch-${index + 1}.bin`);
      const fileName = item?.fileName?.trim() || sourceName;
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
    setBusy(true);
    setError("");
    setPhase("preparing");
    setProgress(null);
    const cleanups: Array<() => Promise<void> | void> = [];
    // Resolve a session source to its patch/ROM leaf so bundles carry the
    // actual file, not the archive it arrived in. Degrades to the original
    // source when the leaf cannot be materialized. Only leaves the resolver
    // actually extracted are cleaned up afterwards - a passthrough leaf shares
    // its backing resources with the live form session.
    const prepareLeafSource = async (
      source: BinarySource,
      role: "rom" | "patch",
      fallbackFileName: string,
      selectedArchiveEntry: string | undefined,
      index: number,
    ): Promise<{ fileName: string; source: SourceRef }> => {
      try {
        const prepared = await prepareInputFile(source, role, undefined, browserRuntime, selectedArchiveEntry, index);
        const leaf = prepared.file;
        if (prepared.wasDecompressed) {
          const cleanup = getPatchFileCleanup(leaf);
          if (cleanup) cleanups.push(cleanup);
        }
        const fileName = leaf.fileName || fallbackFileName;
        const external = getPatchFileExternalSource(leaf, fileName);
        if (external) return { fileName, source: external.source as SourceRef };
        // Copy into a plain ArrayBuffer-backed view: the leaf bytes may sit in
        // shared wasm memory, which File() rejects.
        const bytes = getPatchFileBytes(leaf);
        const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
        copy.set(bytes);
        return { fileName, source: new File([copy], fileName) };
      } catch {
        return { fileName: fallbackFileName, source: source as SourceRef };
      }
    };
    try {
      const rom = inputs[0];
      const romLeaf = rom
        ? await prepareLeafSource(rom, "rom", getReactBinarySourceFileName(rom, "rom.bin"), undefined, 0)
        : undefined;
      const patchLeaves = [];
      for (const [index, patch] of patches.entries()) {
        const row = exportRows[index];
        const fallbackFileName = row?.fileName || getReactBinarySourceFileName(patch, `patch-${index + 1}.bin`);
        // When the leaf lives inside an archive, its own file name selects the
        // matching entry (mirrors the apply workflow's selected-entry routing).
        const selectedArchiveEntry = row?.archiveFileName ? row.fileName : undefined;
        patchLeaves.push(await prepareLeafSource(patch, "patch", fallbackFileName, selectedArchiveEntry, index));
      }
      if (!romLeaf) throw new Error("A ROM is required to generate patch verification checks");
      const hashSource = async (source: unknown, fileName: string, label: string) => {
        const ingest = browserRuntime.ingest?.run;
        if (!ingest) throw new Error("Checksum generation is not available in this runtime");
        setProgress({ label, percent: null });
        const { result } = await ingest({
          checksumAlgorithms: [...CHECK_ALGORITHMS],
          fileName,
          source,
        });
        const asset = result.assets[0];
        const checksums = asset?.checksums || {};
        return {
          checksums: Object.fromEntries(
            CHECK_ALGORITHMS.map((algorithm) => [algorithm, String(checksums[algorithm] || "").toLowerCase()]),
          ) as Record<string, string>,
          recommendedFormat: asset?.recommendedFormat?.toLowerCase(),
        };
      };
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
      let chainSource: SourceRef = romLeaf.source;
      let chainFileName = romLeaf.fileName;
      const applyPatch = browserRuntime.patch.applyPatch;
      if (!applyPatch) throw new Error("Patch application is not available in this runtime");
      for (const [index, leaf] of patchLeaves.entries()) {
        const row = exportRows[index];
        if (!row) continue;
        row.checks = validateRowChecks(row.checks, embeddedChecks(items[index], "in"), `Patch ${index + 1} input`);
        row.outputChecks = validateRowChecks(
          row.outputChecks,
          embeddedChecks(items[index], "out"),
          `Patch ${index + 1} output`,
        );
        setProgress({ label: `Applying patch chain · ${index + 1}/${patchLeaves.length}`, percent: null });
        const output = await applyPatch({
          input: chainSource,
          options: {
            headerModes: [row.header || "auto"],
            outputName: `manifest-chain-${index + 1}.bin`,
          },
          patches: [{ patchFile: leaf.source, patchFileName: leaf.fileName }],
        });
        const blob = await browserRuntime.publicOutput.getBlob(output);
        chainFileName = output.fileName || `manifest-chain-${index + 1}.bin`;
        chainSource = new File([blob], chainFileName);
        await output.cleanup?.();
      }
      // The manifest's endpoints stay self-validating: Rust hashes the ROM for
      // rom.checks, and the full-chain result is hashed ONCE here for
      // output.checks.
      const finalOutputHash = await hashSource(chainSource, chainFileName, "Checksum generation · final output");
      const finalOutputCheck = formatChecks(finalOutputHash.checksums);
      setPhase("exporting");
      setProgress({ label: "Writing manifest", percent: null });
      const wantsBundle = format !== MANIFEST_ONLY_FORMAT;
      const bundleFileName = wantsBundle ? `${slugFileName(exportName) || "rw-bundle"}.${format}` : undefined;
      let packagedRom: { fileName: string; source: SourceRef } | undefined;
      if (bundleRom && wantsBundle) {
        const originalName = rom ? getReactBinarySourceFileName(rom, romLeaf.fileName) : romLeaf.fileName;
        const existingFormat = originalName.split(".").pop()?.toLowerCase();
        // The ROM is hashed only here, and only for the packaging-format
        // recommendation - rom.checks come from Rust during create.
        const recommendedRomFormat =
          rom && existingFormat && ["chd", "rvz", "z3ds"].includes(existingFormat)
            ? undefined
            : (await hashSource(romLeaf.source, romLeaf.fileName, "Checksum generation · ROM")).recommendedFormat;
        if (rom && existingFormat && ["chd", "rvz", "z3ds"].includes(existingFormat)) {
          packagedRom = { fileName: originalName, source: rom as SourceRef };
        } else if (["chd", "rvz", "z3ds"].includes(recommendedRomFormat || "")) {
          const targetFormat = recommendedRomFormat as "chd" | "rvz" | "z3ds";
          const createCompression = browserRuntime.compression.create;
          if (!createCompression) throw new Error("ROM compression is not available in this runtime");
          setProgress({ label: `ROM compression · ${targetFormat.toUpperCase()}`, percent: null });
          const outputName = `${stripFileExtension(romLeaf.fileName)}.${targetFormat}`;
          const compressed = await createCompression({
            fileName: romLeaf.fileName,
            format: targetFormat,
            outputName,
            romSpecific: { [targetFormat]: { sourceFileName: romLeaf.fileName } },
            source: romLeaf.source,
          });
          const output = "output" in compressed ? compressed.output : compressed;
          const blob = await browserRuntime.publicOutput.getBlob(output);
          packagedRom = { fileName: outputName, source: new File([blob], outputName) };
          await output.cleanup?.();
        } else {
          packagedRom = romLeaf;
        }
      }
      const outputHeader = getOutputHeader?.();
      const { result, manifestFile, bundleFile } = await create({
        ...(bundleFileName ? { bundleFileName } : {}),
        ...(packagedRom ? { bundleRom: packagedRom } : {}),
        ...(exportName.trim() ? { outputName: exportName.trim() } : {}),
        ...(finalOutputCheck ? { outputCheck: finalOutputCheck } : {}),
        ...(outputHeader === "keep" || outputHeader === "strip" ? { outputHeader } : {}),
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
          const row = exportRows[index];
          return {
            fileName: leaf.fileName,
            source: leaf.source,
            ...(row?.default === false ? { optional: true } : {}),
            ...(row?.name ? { name: row.name } : {}),
            ...(row?.description.trim() ? { description: row.description.trim() } : {}),
            ...(row?.checks.trim() ? { inputChecks: row.checks.trim() } : {}),
            ...(row?.outputChecks.trim() ? { outputChecks: row.outputChecks.trim() } : {}),
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
  ]);

  return {
    bundleRom,
    busy,
    closeDialog,
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
    setFormat,
    setName,
    setRowChecks,
    setRowDefault,
    setRowDescription,
  };
};

export { useManifestExport };
