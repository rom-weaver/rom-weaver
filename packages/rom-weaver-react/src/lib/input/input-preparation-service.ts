import {
  getNamedSourceSize as getBinarySourceSize,
  getNamedSourceFileName,
  getNamedSourcePath,
} from "../../storage/shared/binary/source-file-utils.ts";
import type { CandidateSelectionRequest, SelectionFileCandidate } from "../../types/selection.ts";
import type { SourceRef } from "../../types/source.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime-types.ts";
import { getArchiveMagicType, getArchiveType, MAGIC_SIGNATURES } from "../../workers/protocol/archive-shared-utils.ts";
import type { PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import { ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS } from "../compression/rom-specific-format-support.ts";
import { emitTraceLog } from "../logging.ts";
import { getFileNameExtension, replaceFileNameExtension } from "../path-utils.ts";
import { isCueEntryFileName, isGdiEntryFileName, parseCueFileReferences, parseGdiFileReferences } from "./archive.ts";
import {
  createBlobBackedPatchFile,
  createLazyExternalPatchFile,
  createPatchFile,
  createSourceAccessFromSource,
  decodeUtf8,
  getPatchFileBytes,
} from "./binary-service.ts";
import {
  attachInputPreparationMetrics,
  type InputAsset,
  makeCueAsset,
  makeInputCandidateGroup,
  makeInputId,
  makeMissingReferenceWarnings,
  makeRomAsset,
  makeTrackAsset,
} from "./input-assets.ts";
import {
  type PreparedInputFileResult,
  resolveCompressedInputAssets,
  resolveCompressedInputFile,
} from "./input-decompression.ts";
import {
  getPatchLeafFileForSelection,
  getPatchLeafParentCompressionsForSelection,
  prepareAutoPatchInputs,
} from "./input-preparation-archive.ts";
import { getBaseFileName, normalizeArchiveEntryName } from "./path-utils.ts";

type InputPreparationOptions = ApplyWorkflowOptions | CreateWorkflowOptions | undefined;
type InputPreparationBehaviorOptions = {
  allowLazyBrowserRomSource?: boolean;
};
type InputPreparationRuntime = Pick<WorkflowRuntime, "name"> & {
  compression?: WorkflowRuntime["compression"];
  sidecars: {
    read?: (sourcePath: string, referencedName: string) => Promise<SourceRef>;
  };
  workerIo?: WorkflowRuntime["workerIo"];
};

const ROM_SPECIFIC_DECOMPRESSION_EXTENSIONS = new Set(ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS);
const ROM_SPECIFIC_MAGIC_PREFIXES = [
  { extension: "chd", magic: [0x4d, 0x43, 0x6f, 0x6d, 0x70, 0x72, 0x48, 0x44] },
  { extension: "rvz", magic: [0x52, 0x56, 0x5a, 0x00] },
  { extension: "z3ds", magic: [0x5a, 0x33, 0x44, 0x53] },
];
const MAX_ROM_SPECIFIC_MAGIC_PREFIX_LENGTH = Math.max(
  ...ROM_SPECIFIC_MAGIC_PREFIXES.map((entry) => entry.magic.length),
);
const MAX_ARCHIVE_MAGIC_PREFIX_LENGTH = Math.max(
  ...MAGIC_SIGNATURES.map((entry) => (entry.offset || 0) + entry.bytes.length),
);
const MAX_LAZY_BROWSER_PREFIX_LENGTH = Math.max(MAX_ROM_SPECIFIC_MAGIC_PREFIX_LENGTH, MAX_ARCHIVE_MAGIC_PREFIX_LENGTH);

type LazyBrowserSource = {
  blob: Blob;
  fileHandle?: FileSystemFileHandle | null;
  fileName: string;
};

const getPreparationSourceKind = (source: unknown) => {
  if (typeof File !== "undefined" && source instanceof File) return "file";
  if (typeof Blob !== "undefined" && source instanceof Blob) return "blob";
  if (
    source &&
    typeof source === "object" &&
    "getFile" in source &&
    typeof (source as { getFile?: unknown }).getFile === "function"
  )
    return "file-handle";
  if (source instanceof Uint8Array) return "uint8array";
  if (source instanceof ArrayBuffer) return "arraybuffer";
  if (typeof source === "string") return "path-string";
  if (source && typeof source === "object") return "object";
  return typeof source;
};

const summarizePreparationSource = (source: SourceRef, fallbackFileName: string) => ({
  fileName: getNamedSourceFileName(source, { fallback: fallbackFileName }) || fallbackFileName,
  kind: getPreparationSourceKind(source),
  path: getNamedSourcePath(source as Parameters<typeof getNamedSourcePath>[0]) || "",
  size: getBinarySourceSize(source as Parameters<typeof getBinarySourceSize>[0]) ?? undefined,
});

const emitInputPreparationTrace = (
  options: InputPreparationOptions,
  message: string,
  details: Record<string, unknown> = {},
) => {
  emitTraceLog(
    {
      logLevel: options?.logging?.level,
      namespace: "workflow:input-preparation",
      onLog: options?.onLog,
    },
    message,
    details,
  );
};

const getFileExtension = (fileName: string | undefined) => getFileNameExtension(fileName);

const getRomSpecificMagicExtension = (bytes: Uint8Array) => {
  for (const entry of ROM_SPECIFIC_MAGIC_PREFIXES) {
    if (bytes.length >= entry.magic.length && entry.magic.every((value, index) => bytes[index] === value))
      return entry.extension;
  }
  return null;
};

const replaceFileExtension = (fileName: string, extension: string) => replaceFileNameExtension(fileName, extension);

const readBlobPrefix = async (blob: Blob, length: number) => {
  const buffer = await blob.slice(0, length).arrayBuffer();
  return new Uint8Array(buffer, 0, Math.min(length, buffer.byteLength));
};

const getLazyBrowserSource = async (
  source: SourceRef,
  fallbackFileName: string,
  options: InputPreparationOptions,
  behavior: InputPreparationBehaviorOptions = {},
): Promise<LazyBrowserSource | null> => {
  emitInputPreparationTrace(options, "lazy browser source check start", {
    behavior,
    source: summarizePreparationSource(source, fallbackFileName),
  });
  if (typeof Blob === "undefined") return null;
  const sourceAccess = createSourceAccessFromSource(source, fallbackFileName);
  const fileName = sourceAccess.fileName || fallbackFileName;
  const fileHandle = sourceAccess.getFileHandle();
  let blob = sourceAccess.getBlob();
  emitInputPreparationTrace(options, "lazy browser source access resolved", {
    fileName,
    hasBlob: !!blob,
    hasFileHandle: !!fileHandle,
    size: sourceAccess.size ?? undefined,
  });
  if (!blob && fileHandle) blob = await fileHandle.getFile();
  if (!blob) {
    emitInputPreparationTrace(options, "lazy browser source unavailable", {
      fileName,
      reason: "no-blob",
    });
    return null;
  }
  emitInputPreparationTrace(options, "lazy browser source read disc header start", {
    fileName,
    prefixLength: MAX_ROM_SPECIFIC_MAGIC_PREFIX_LENGTH,
    size: blob.size,
  });
  const romSpecificHeader = await readBlobPrefix(blob, MAX_ROM_SPECIFIC_MAGIC_PREFIX_LENGTH);
  emitInputPreparationTrace(options, "lazy browser source read disc header finish", {
    fileName,
    readBytes: romSpecificHeader.byteLength,
  });
  if (ROM_SPECIFIC_DECOMPRESSION_EXTENSIONS.has(getFileExtension(fileName))) {
    emitInputPreparationTrace(options, "lazy browser source accepted by extension", {
      fileName,
    });
    return { blob, fileHandle, fileName };
  }
  const magicExtension = getRomSpecificMagicExtension(romSpecificHeader);
  if (magicExtension) {
    const magicFileName = replaceFileExtension(fileName, magicExtension);
    emitInputPreparationTrace(options, "lazy browser source accepted by magic", {
      fileName,
      magicExtension,
      magicFileName,
    });
    return { blob, fileHandle, fileName: magicFileName };
  }
  if (!behavior.allowLazyBrowserRomSource) {
    emitInputPreparationTrace(options, "lazy browser source rejected", {
      fileName,
      reason: "lazy-rom-source-disabled",
    });
    return null;
  }
  if (isCueEntryFileName(fileName)) {
    emitInputPreparationTrace(options, "lazy browser source rejected", {
      fileName,
      reason: "cue-input",
    });
    return null;
  }
  emitInputPreparationTrace(options, "lazy browser source read archive header start", {
    fileName,
    prefixLength: MAX_LAZY_BROWSER_PREFIX_LENGTH,
  });
  const archiveHeader =
    MAX_LAZY_BROWSER_PREFIX_LENGTH > romSpecificHeader.byteLength
      ? await readBlobPrefix(blob, MAX_LAZY_BROWSER_PREFIX_LENGTH)
      : romSpecificHeader;
  const archiveMagicType = getArchiveMagicType(archiveHeader);
  emitInputPreparationTrace(options, "lazy browser source read archive header finish", {
    archiveMagicType: archiveMagicType || "",
    fileName,
    readBytes: archiveHeader.byteLength,
  });
  if (archiveMagicType && !getArchiveType({ fileName })) {
    emitInputPreparationTrace(options, "lazy browser source rejected", {
      archiveMagicType,
      fileName,
      reason: "archive-magic-without-extension",
    });
    return null;
  }
  emitInputPreparationTrace(options, "lazy browser source accepted", {
    fileName,
  });
  return { blob, fileHandle, fileName };
};

const createInputPreparationPatchFile = async (
  source: SourceRef,
  fallbackFileName: string,
  role: "patch" | "rom",
  options: InputPreparationOptions,
  behavior: InputPreparationBehaviorOptions = {},
): Promise<PatchFileInstance> => {
  emitInputPreparationTrace(options, "create patch file start", {
    behavior,
    fallbackFileName,
    role,
    source: summarizePreparationSource(source, fallbackFileName),
  });
  if (role === "patch") {
    const lazyBrowserSource = await getLazyBrowserSource(source, fallbackFileName, options, behavior);
    if (lazyBrowserSource) {
      emitInputPreparationTrace(options, "create patch file lazy patch source", {
        fileName: lazyBrowserSource.fileName,
        size: lazyBrowserSource.blob.size,
      });
      return createBlobBackedPatchFile(
        lazyBrowserSource.blob,
        lazyBrowserSource.fileName,
        undefined,
        lazyBrowserSource.fileHandle,
        { materialize: false },
      );
    }
    emitInputPreparationTrace(options, "create patch file materialized patch source", {
      fallbackFileName,
    });
    return createPatchFile(source, fallbackFileName);
  }

  const sourceAccess = createSourceAccessFromSource(source, fallbackFileName);
  const sourceFileName = sourceAccess.fileName || fallbackFileName;
  const lazyBrowserSource = await getLazyBrowserSource(source, fallbackFileName, options, {
    ...behavior,
    allowLazyBrowserRomSource: true,
  });
  if (lazyBrowserSource) {
    emitInputPreparationTrace(options, "create patch file lazy rom source", {
      fileName: lazyBrowserSource.fileName,
      size: lazyBrowserSource.blob.size,
    });
    return createBlobBackedPatchFile(
      lazyBrowserSource.blob,
      lazyBrowserSource.fileName,
      undefined,
      lazyBrowserSource.fileHandle,
      { materialize: false },
    );
  }

  const sourcePath =
    getNamedSourcePath(source as Parameters<typeof getNamedSourcePath>[0]) || sourceAccess.getFilePath();
  if (sourcePath) {
    emitInputPreparationTrace(options, "create patch file lazy external rom source", {
      fileName: sourceFileName,
      size: sourceAccess.size ?? undefined,
      sourcePath,
    });
    return createLazyExternalPatchFile(sourceFileName, {
      filePath: sourcePath,
      size: sourceAccess.size ?? undefined,
    });
  }

  emitInputPreparationTrace(options, "create patch file failed", {
    fileName: sourceFileName,
    reason: "no-path-backed-source",
  });
  throw new Error(`${sourceFileName} must be OPFS/VFS path-backed in browser workflows`);
};

const reportInputCandidates = (options: InputPreparationOptions, request: CandidateSelectionRequest) => {
  if (typeof options?.onCandidatesFound === "function") options.onCandidatesFound(request);
};

const makeCueSelectionCandidate = (fileName: string, groupId: string, size?: number): SelectionFileCandidate => ({
  fileName,
  id: `${groupId}-cue`,
  kind: "cue",
  parentCandidateId: groupId,
  patchable: false,
  selectable: false,
  size,
  type: "file",
});

const makeAssetSelectionCandidate = (asset: InputAsset): SelectionFileCandidate => ({
  fileName: asset.fileName,
  id: asset.id,
  kind: asset.kind,
  parentCandidateId: asset.groupId,
  patchable: asset.patchable,
  selectable: asset.patchable,
  size: asset.size,
  type: "file",
});

const makeMissingTrackSelectionCandidate = (
  sourceIndex: number,
  fileName: string,
  groupId: string,
  patchable?: boolean,
): SelectionFileCandidate => ({
  fileName,
  id: makeInputId(sourceIndex, fileName, normalizeArchiveEntryName),
  kind: "track",
  parentCandidateId: groupId,
  patchable,
  reason: "Missing referenced file",
  selectable: false,
  type: "file",
});

const reportCueInputCandidates = ({
  candidates,
  cueFileName,
  groupId,
  missingReferences,
  options,
  patchable,
  sourceName,
  trackFileNames,
}: {
  candidates: SelectionFileCandidate[];
  cueFileName: string;
  groupId: string;
  missingReferences: string[];
  options: InputPreparationOptions;
  patchable: boolean;
  sourceName?: string;
  trackFileNames: string[];
}) => {
  reportInputCandidates(options, {
    candidates: [
      ...candidates,
      makeInputCandidateGroup({
        cueFileName,
        groupId,
        missingReferences,
        patchable,
        trackFileNames,
      }),
    ],
    role: "input",
    sourceName: sourceName || cueFileName,
    warnings: makeMissingReferenceWarnings(cueFileName, missingReferences),
  });
};

const resolveCueInputAssets = async (
  cueFile: PatchFileInstance,
  options: ApplyWorkflowOptions | undefined,
  sourceIndex: number,
  sourcePath: string | undefined,
  runtime: InputPreparationRuntime,
): Promise<InputAsset[]> => {
  const cueText = decodeUtf8(getPatchFileBytes(cueFile));
  const references = parseCueFileReferences(cueText);
  const groupId = makeInputId(sourceIndex, cueFile.fileName, normalizeArchiveEntryName, "-group");
  const assets: InputAsset[] = [makeCueAsset(`${groupId}-cue`, cueFile.fileName, cueFile, groupId, cueText)];
  const candidates: SelectionFileCandidate[] = [makeCueSelectionCandidate(cueFile.fileName, groupId, cueFile.fileSize)];
  const missingReferences: string[] = [];
  const readSiblingFile = runtime.sidecars.read;
  for (const reference of references) {
    try {
      if (!sourcePath) throw new Error("CUE sidecar source path is unavailable");
      if (!readSiblingFile) throw new Error("CUE sidecar file resolver is unavailable");
      const trackFile = await createPatchFile(
        await readSiblingFile(sourcePath, reference.fileName),
        getBaseFileName(reference.fileName),
      );
      const asset = makeTrackAsset(
        makeInputId(sourceIndex, reference.fileName, normalizeArchiveEntryName),
        trackFile.fileName,
        trackFile,
        groupId,
        reference,
        { cueText },
      );
      assets.push(asset);
      candidates.push(makeAssetSelectionCandidate(asset));
    } catch (_err) {
      missingReferences.push(reference.fileName);
      candidates.push(
        makeMissingTrackSelectionCandidate(sourceIndex, reference.fileName, groupId, reference.patchable),
      );
    }
  }
  reportCueInputCandidates({
    candidates,
    cueFileName: cueFile.fileName,
    groupId,
    missingReferences,
    options,
    patchable: missingReferences.length === 0 && assets.some((asset) => asset.patchable),
    trackFileNames: assets.filter((asset) => asset.kind === "track").map((asset) => asset.fileName),
  });
  if (missingReferences.length) throw new Error(`CUE file references missing file(s): ${missingReferences.join(", ")}`);
  return assets;
};

const prepareInputAssets = async (
  source: SourceRef,
  options: ApplyWorkflowOptions | undefined,
  sourceIndex: number,
  runtime: InputPreparationRuntime,
  selectedEntryName?: string,
  behavior: InputPreparationBehaviorOptions = {},
): Promise<InputAsset[]> => {
  emitInputPreparationTrace(options, "input.assets.prepare.start", {
    behavior,
    source: summarizePreparationSource(source, "input.bin"),
    sourceIndex,
  });
  const file = await createInputPreparationPatchFile(source, "input.bin", "rom", options, behavior);
  emitInputPreparationTrace(options, "input.assets.patch-file.created", {
    fileName: file.fileName,
    filePath: file.filePath || "",
    fileSize: file.fileSize,
  });
  const sourcePath = getNamedSourcePath(source as Parameters<typeof getNamedSourcePath>[0]) || undefined;
  if (isCueEntryFileName(file.fileName)) {
    emitInputPreparationTrace(options, "input.assets.cue.resolve.start", {
      fileName: file.fileName,
      sourcePath,
    });
    return attachInputPreparationMetrics(await resolveCueInputAssets(file, options, sourceIndex, sourcePath, runtime), {
      sourceSize: file.fileSize,
      wasDecompressed: false,
    });
  }
  emitInputPreparationTrace(options, "input.assets.compression.resolve.start", {
    fileName: file.fileName,
    fileSize: file.fileSize,
    selectedEntryName,
  });
  const assets = await resolveCompressedInputAssets(file, options, runtime, sourceIndex, selectedEntryName);
  emitInputPreparationTrace(options, "input.assets.prepare.finish", {
    assetCount: assets.length,
    fileName: file.fileName,
  });
  return assets;
};

const prepareMultipleDirectInputAssets = async (
  sources: SourceRef[],
  options: ApplyWorkflowOptions | undefined,
): Promise<InputAsset[] | null> => {
  const fallbackFileNames = sources.map((_, index) => `input-${index + 1}.bin`);
  if (
    !sources.some((source, index) =>
      isCueEntryFileName(
        getNamedSourceFileName(source, { fallback: fallbackFileNames[index] }) || fallbackFileNames[index],
      ),
    )
  ) {
    return null;
  }
  const files = await Promise.all(sources.map((source, index) => createPatchFile(source, `input-${index + 1}.bin`)));
  if (!files.some((file) => isCueEntryFileName(file.fileName))) return null;

  const assets: InputAsset[] = [];
  const used = new Set<PatchFileInstance>();
  for (let cueIndex = 0; cueIndex < files.length; cueIndex++) {
    const cueFile = files[cueIndex];
    if (!(cueFile && isCueEntryFileName(cueFile.fileName))) continue;
    const cueText = decodeUtf8(getPatchFileBytes(cueFile));
    const references = parseCueFileReferences(cueText);
    const groupId = makeInputId(cueIndex, cueFile.fileName, normalizeArchiveEntryName, "-group");
    // A redump GD-ROM dump ships a `.gdi` alongside the `.cue` for the same
    // disc. Find a sibling `.gdi` that references the same tracks so it rides on
    // the disc (its own GDI section) instead of becoming a separate ROM.
    const cueBinNames = new Set(references.map((reference) => getBaseFileName(reference.fileName).toLowerCase()));
    let gdiFile: PatchFileInstance | undefined;
    let gdiText: string | undefined;
    for (const file of files) {
      if (!file || used.has(file) || !isGdiEntryFileName(file.fileName)) continue;
      const text = decodeUtf8(getPatchFileBytes(file));
      const gdiRefs = parseGdiFileReferences(text).map((name) => getBaseFileName(name).toLowerCase());
      if (gdiRefs.length > 0 && gdiRefs.every((name) => cueBinNames.has(name))) {
        gdiFile = file;
        gdiText = text;
        break;
      }
    }
    const missingReferences: string[] = [];
    const trackAssets: InputAsset[] = [];
    for (const reference of references) {
      const trackFile = files.find(
        (file) => getBaseFileName(file.fileName).toLowerCase() === getBaseFileName(reference.fileName).toLowerCase(),
      );
      if (!trackFile) {
        missingReferences.push(reference.fileName);
        continue;
      }
      used.add(trackFile);
      trackAssets.push(
        makeTrackAsset(
          makeInputId(cueIndex, trackFile.fileName, normalizeArchiveEntryName),
          trackFile.fileName,
          trackFile,
          groupId,
          reference,
          { cueText, gdiText },
        ),
      );
    }
    reportCueInputCandidates({
      candidates: [
        makeCueSelectionCandidate(cueFile.fileName, groupId, cueFile.fileSize),
        ...trackAssets.map(makeAssetSelectionCandidate),
        ...missingReferences.map((fileName) => makeMissingTrackSelectionCandidate(cueIndex, fileName, groupId, true)),
      ],
      cueFileName: cueFile.fileName,
      groupId,
      missingReferences,
      options,
      patchable: missingReferences.length === 0 && trackAssets.some((asset) => asset.patchable),
      trackFileNames: trackAssets.map((asset) => asset.fileName),
    });
    if (missingReferences.length)
      throw new Error(`CUE file references missing file(s): ${missingReferences.join(", ")}`);
    used.add(cueFile);
    assets.push(makeCueAsset(`${groupId}-cue`, cueFile.fileName, cueFile, groupId, cueText), ...trackAssets);
    if (gdiFile) {
      used.add(gdiFile);
      assets.push(makeCueAsset(`${groupId}-gdi`, gdiFile.fileName, gdiFile, groupId, gdiText ?? ""));
    }
  }
  files.forEach((file, index) => {
    if (!used.has(file)) assets.push(makeRomAsset(makeInputId(index, file.fileName, normalizeArchiveEntryName), file));
  });
  return assets;
};

const prepareInput = async (
  source: SourceRef,
  role: "rom" | "patch",
  options?: InputPreparationOptions,
  runtime?: InputPreparationRuntime,
  selectedArchiveEntry?: string,
  sourceIndex = 0,
  behavior: InputPreparationBehaviorOptions = {},
): Promise<PatchFileInstance> => {
  return (await prepareInputFile(source, role, options, runtime, selectedArchiveEntry, sourceIndex, behavior)).file;
};

const prepareInputFile = async (
  source: SourceRef,
  role: "rom" | "patch",
  options?: InputPreparationOptions,
  runtime?: InputPreparationRuntime,
  selectedArchiveEntry?: string,
  sourceIndex = 0,
  behavior: InputPreparationBehaviorOptions = {},
): Promise<PreparedInputFileResult> => {
  emitInputPreparationTrace(options, "input.file.prepare.start", {
    behavior,
    role,
    source: summarizePreparationSource(source, role === "rom" ? "rom.bin" : "patch.bin"),
    sourceIndex,
  });
  const file = await createInputPreparationPatchFile(
    source,
    role === "rom" ? "rom.bin" : "patch.bin",
    role,
    options,
    role === "rom" ? behavior : {},
  );
  emitInputPreparationTrace(options, "input.file.patch-file.created", {
    fileName: file.fileName,
    filePath: file.filePath || "",
    fileSize: file.fileSize,
    role,
  });
  const prepared = await resolveCompressedInputFile(
    file,
    role,
    options,
    runtime || { name: "browser", sidecars: {} },
    selectedArchiveEntry,
    sourceIndex,
  );
  emitInputPreparationTrace(options, "input.file.prepare.finish", {
    fileName: prepared.file.fileName,
    role,
    wasDecompressed: prepared.wasDecompressed,
  });
  return prepared;
};

export {
  getBinarySourceSize,
  getPatchLeafFileForSelection,
  getPatchLeafParentCompressionsForSelection,
  prepareAutoPatchInputs,
  prepareInput,
  prepareInputAssets,
  prepareInputFile,
  prepareMultipleDirectInputAssets,
};
