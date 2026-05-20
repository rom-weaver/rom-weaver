import {
  getNamedSourceSize as getBinarySourceSize,
  getNamedSourceFileName,
  getNamedSourcePath,
} from "../../storage/shared/binary/source-file-utils.ts";
import type { CandidateSelectionRequest, SelectionFileCandidate } from "../../types/selection.ts";
import type { SourceRef } from "../../types/source.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import { isCueEntryFileName, parseCueFileReferences } from "./archive.ts";
import { getArchiveType } from "./archive-type-utils.ts";
import { getArchiveMagicType, MAGIC_SIGNATURES } from "./archive-utils.ts";
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
import { prepareAutoPatchInputs } from "./input-preparation-archive.ts";
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

const DISC_DECOMPRESSION_EXTENSIONS = new Set(["chd", "rvz", "z3ds"]);
const DISC_MAGIC_PREFIXES = [
  { extension: "chd", magic: [0x4d, 0x43, 0x6f, 0x6d, 0x70, 0x72, 0x48, 0x44] },
  { extension: "rvz", magic: [0x52, 0x56, 0x5a, 0x00] },
  { extension: "z3ds", magic: [0x5a, 0x33, 0x44, 0x53] },
];
const FILE_EXTENSION_REGEX = /\.[^./\\?#]*([?#].*)?$/;
const FILE_QUERY_OR_HASH_REGEX = /[?#].*$/;
const MAX_DISC_MAGIC_PREFIX_LENGTH = Math.max(...DISC_MAGIC_PREFIXES.map((entry) => entry.magic.length));
const MAX_ARCHIVE_MAGIC_PREFIX_LENGTH = Math.max(
  ...MAGIC_SIGNATURES.map((entry) => (entry.offset || 0) + entry.bytes.length),
);
const MAX_LAZY_BROWSER_PREFIX_LENGTH = Math.max(MAX_DISC_MAGIC_PREFIX_LENGTH, MAX_ARCHIVE_MAGIC_PREFIX_LENGTH);

type LazyBrowserSource = {
  blob: Blob;
  fileHandle?: FileSystemFileHandle | null;
  fileName: string;
};

const getFileExtension = (fileName: string | undefined) => {
  const normalized = String(fileName || "").replace(FILE_QUERY_OR_HASH_REGEX, "");
  const extensionIndex = normalized.lastIndexOf(".");
  return extensionIndex === -1 ? "" : normalized.slice(extensionIndex + 1).toLowerCase();
};

const getDiscMagicExtension = (bytes: Uint8Array) => {
  for (const entry of DISC_MAGIC_PREFIXES) {
    if (bytes.length >= entry.magic.length && entry.magic.every((value, index) => bytes[index] === value))
      return entry.extension;
  }
  return null;
};

const replaceFileExtension = (fileName: string, extension: string) =>
  FILE_EXTENSION_REGEX.test(fileName)
    ? fileName.replace(FILE_EXTENSION_REGEX, `.${extension}`)
    : `${fileName}.${extension}`;

const readBlobPrefix = async (blob: Blob, length: number) => {
  const buffer = await blob.slice(0, length).arrayBuffer();
  return new Uint8Array(buffer, 0, Math.min(length, buffer.byteLength));
};

const getLazyBrowserSource = async (
  source: SourceRef,
  fallbackFileName: string,
  behavior: InputPreparationBehaviorOptions = {},
): Promise<LazyBrowserSource | null> => {
  if (typeof Blob === "undefined") return null;
  const sourceAccess = createSourceAccessFromSource(source, fallbackFileName);
  const fileName = sourceAccess.fileName || fallbackFileName;
  const fileHandle = sourceAccess.getFileHandle();
  let blob = sourceAccess.getBlob();
  if (!blob && fileHandle) blob = await fileHandle.getFile();
  if (!blob) return null;
  const discHeader = await readBlobPrefix(blob, MAX_DISC_MAGIC_PREFIX_LENGTH);
  if (DISC_DECOMPRESSION_EXTENSIONS.has(getFileExtension(fileName))) return { blob, fileHandle, fileName };
  const magicExtension = getDiscMagicExtension(discHeader);
  if (magicExtension) return { blob, fileHandle, fileName: replaceFileExtension(fileName, magicExtension) };
  if (!behavior.allowLazyBrowserRomSource) return null;
  if (isCueEntryFileName(fileName)) return null;
  const archiveHeader =
    MAX_LAZY_BROWSER_PREFIX_LENGTH > discHeader.byteLength
      ? await readBlobPrefix(blob, MAX_LAZY_BROWSER_PREFIX_LENGTH)
      : discHeader;
  const archiveMagicType = getArchiveMagicType(archiveHeader);
  if (archiveMagicType && !getArchiveType({ fileName })) return null;
  return { blob, fileHandle, fileName };
};

const createInputPreparationPatchFile = async (
  source: SourceRef,
  fallbackFileName: string,
  role: "patch" | "rom",
  behavior: InputPreparationBehaviorOptions = {},
): Promise<PatchFileInstance> => {
  if (role === "patch") {
    const lazyBrowserSource = await getLazyBrowserSource(source, fallbackFileName, behavior);
    if (lazyBrowserSource)
      return createBlobBackedPatchFile(
        lazyBrowserSource.blob,
        lazyBrowserSource.fileName,
        undefined,
        lazyBrowserSource.fileHandle,
        { materialize: false },
      );
    return createPatchFile(source, fallbackFileName);
  }

  const sourceAccess = createSourceAccessFromSource(source, fallbackFileName);
  const sourceFileName = sourceAccess.fileName || fallbackFileName;
  const lazyBrowserSource = await getLazyBrowserSource(source, fallbackFileName, {
    ...behavior,
    allowLazyBrowserRomSource: true,
  });
  if (lazyBrowserSource)
    return createBlobBackedPatchFile(
      lazyBrowserSource.blob,
      lazyBrowserSource.fileName,
      undefined,
      lazyBrowserSource.fileHandle,
      { materialize: false },
    );

  const sourcePath =
    getNamedSourcePath(source as Parameters<typeof getNamedSourcePath>[0]) || sourceAccess.getFilePath();
  if (sourcePath) {
    return createLazyExternalPatchFile(sourceFileName, {
      filePath: sourcePath,
      size: sourceAccess.size ?? undefined,
    });
  }

  throw new Error(
    `${sourceFileName} must be filesystem-backed (File, FileSystemFileHandle, or VFS/OPFS path) in browser workflows`,
  );
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
  const file = await createInputPreparationPatchFile(source, "input.bin", "rom", behavior);
  const sourcePath = getNamedSourcePath(source as Parameters<typeof getNamedSourcePath>[0]) || undefined;
  if (isCueEntryFileName(file.fileName))
    return attachInputPreparationMetrics(await resolveCueInputAssets(file, options, sourceIndex, sourcePath, runtime), {
      sourceSize: file.fileSize,
      wasDecompressed: false,
    });
  return resolveCompressedInputAssets(file, options, runtime, sourceIndex, selectedEntryName);
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
  const file = await createInputPreparationPatchFile(
    source,
    role === "rom" ? "rom.bin" : "patch.bin",
    role,
    role === "rom" ? behavior : {},
  );
  return resolveCompressedInputFile(
    file,
    role,
    options,
    runtime || { name: "browser", sidecars: {} },
    selectedArchiveEntry,
    sourceIndex,
  );
};

export type { InputAsset };
export {
  getBinarySourceSize,
  prepareAutoPatchInputs,
  prepareInput,
  prepareInputAssets,
  prepareInputFile,
  prepareMultipleDirectInputAssets,
};
