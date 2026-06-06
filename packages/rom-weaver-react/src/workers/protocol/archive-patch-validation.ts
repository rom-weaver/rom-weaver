import { createArchiveSourceBlob } from "../../storage/shared/archive-source-utils.ts";
import { toArrayBuffer } from "../../storage/shared/binary/binary-source-utils.ts";
import type { ArchiveEntry, ArchiveEntryInput, BrowserFileLike, ProgressEvent } from "../../types/runtime.ts";
import { filterPatchEntries, getBlobSource } from "./archive-shared-utils.ts";

const BPS_EXTENSION_REGEX = /\.bps\d*$/i;
const PATCH_EXTENSION_DIGIT_SUFFIX_REGEX =
  /\.(ips|ups|bps|aps|rup|ppf|ebp|bdf|bsp|bspatch|mod|xdelta|delta|dat|vcdiff)\d*$/i;

type Awaitable<T> = T | Promise<T>;
type ArchiveByteSource = ArrayBufferLike | Uint8Array | ArrayBufferView;
type ParsePatchResult = object | boolean | null | undefined;
type FileExtractionResult = {
  cleanupPaths?: string[] | null;
  file?: BrowserFileLike;
};

type ArchiveCapabilitiesBase = {
  cleanupFiles?: (filePaths: string[]) => Promise<void>;
};

type BlobSource = NonNullable<ReturnType<typeof getBlobSource>>;
type ArchiveFileSource = BlobSource | FileSystemFileHandle | string;

type FileArchiveCapabilitiesLike = ArchiveCapabilitiesBase & {
  extractEntryFromFile: (
    source: ArchiveFileSource,
    entryName: string | undefined,
    options?: { onProgress?: (progress: ProgressEvent) => void },
  ) => Promise<ArchiveByteSource>;
  extractEntryToFile: (
    source: BlobSource,
    entryName: string | undefined,
    options: { onProgress: (progress: ProgressEvent) => void },
  ) => Promise<FileExtractionResult>;
};

type BufferArchiveCapabilitiesLike = FileArchiveCapabilitiesLike;

type PatchPatchFile = {
  fileName?: string;
  _archiveEntryName?: string;
  _archiveEntryType?: string;
  _archiveFileName?: string | null;
  fileSize?: number;
  readString?: (length: number) => string;
  seek?: (offset: number) => void;
};

type PatchFileConstructor = new (source: ArrayBuffer) => PatchPatchFile;
type ParsePatchFile = (binFile: PatchPatchFile) => Awaitable<ParsePatchResult>;
type BpsFormatLike = {
  readSummary(binFile: PatchPatchFile): Awaitable<ParsePatchResult>;
};

type PatchValidationOptions<TArchiveCapabilities> = {
  archiveCapabilities: TArchiveCapabilities;
  BPSFormat?: BpsFormatLike;
  PatchFileClass: PatchFileConstructor;
  entries: Array<ArchiveEntry | ArchiveEntryInput>;
  parsePatchFile?: ParsePatchFile;
};

type BufferPatchValidationOptions = PatchValidationOptions<BufferArchiveCapabilitiesLike> & {
  arrayBuffer: ArrayBufferLike;
};

type FilePatchValidationOptions = PatchValidationOptions<FileArchiveCapabilitiesLike> & {
  source: ArchiveFileSource | { _file?: BrowserFileLike | null } | null | undefined;
};

const createPatchPatchFile = (entry: ArchiveEntry, data: ArchiveByteSource, PatchFileClass: PatchFileConstructor) => {
  const binFile = new PatchFileClass(toArrayBuffer(data));
  binFile.fileName = entry.filename;
  binFile._archiveEntryName = entry.filename;
  binFile._archiveEntryType = "patch";
  if (entry.archiveFileName) binFile._archiveFileName = entry.archiveFileName;
  return binFile;
};

const hasMagic = (binFile: PatchPatchFile, magic: string) => {
  if (typeof binFile.seek !== "function" || typeof binFile.readString !== "function") return false;
  binFile.seek(0);
  return binFile.readString(magic.length) === magic;
};

const hasIpsFooter = (binFile: PatchPatchFile) => {
  if (typeof binFile.seek !== "function" || typeof binFile.readString !== "function") return false;
  const size = typeof binFile.fileSize === "number" ? binFile.fileSize : 0;
  if (size < 8) return false;
  binFile.seek(size - 3);
  return binFile.readString(3) === "EOF";
};

const isKnownPatchBySignature = (binFile: PatchPatchFile) => {
  const fileName = String(binFile.fileName || "").toLowerCase();
  const normalizedPatchFileName = fileName.replace(PATCH_EXTENSION_DIGIT_SUFFIX_REGEX, ".$1");
  try {
    if (normalizedPatchFileName.endsWith(".ips")) return hasMagic(binFile, "PATCH") && hasIpsFooter(binFile);
    if (normalizedPatchFileName.endsWith(".bps")) return hasMagic(binFile, "BPS1");
    if (normalizedPatchFileName.endsWith(".ups")) return hasMagic(binFile, "UPS1");
    if (normalizedPatchFileName.endsWith(".bdf")) return hasMagic(binFile, "BDF");
    if (normalizedPatchFileName.endsWith(".ppf")) return hasMagic(binFile, "PPF");
    if (normalizedPatchFileName.endsWith(".rup")) return hasMagic(binFile, "NINJA2");
    if (normalizedPatchFileName.endsWith(".aps")) return hasMagic(binFile, "APS10") || hasMagic(binFile, "APS1");
    if (
      normalizedPatchFileName.endsWith(".vcdiff") ||
      normalizedPatchFileName.endsWith(".xdelta") ||
      normalizedPatchFileName.endsWith(".delta") ||
      normalizedPatchFileName.endsWith(".dat")
    )
      return hasMagic(binFile, "\xd6\xc3\xc4");
  } finally {
    if (typeof binFile.seek === "function") binFile.seek(0);
  }
  return false;
};

const createValidatedPatchPatchFileFromFileResult = async ({
  entry,
  result,
  PatchFileClass,
}: {
  entry: ArchiveEntry;
  result: { file?: BrowserFileLike } | null | undefined;
  PatchFileClass: PatchFileConstructor;
}) => {
  if (result?.file && typeof result.file.arrayBuffer === "function")
    return createPatchPatchFile(entry, new Uint8Array(await result.file.arrayBuffer()), PatchFileClass);
  throw new Error("Browser-backed archive patch validation is not available");
};

const isValidPatchPatchFile = async (
  binFile: PatchPatchFile,
  parsePatchFile?: ParsePatchFile,
  BPSFormat?: BpsFormatLike,
) => {
  try {
    if (BPSFormat && BPS_EXTENSION_REGEX.test(binFile.fileName || "")) {
      await BPSFormat.readSummary(binFile);
      return true;
    }
    if (typeof parsePatchFile !== "function") return isKnownPatchBySignature(binFile);
    return !!(await parsePatchFile(binFile));
  } catch (_err) {
    return false;
  }
};

const isValidPatchEntry = ({
  archiveCapabilities,
  arrayBuffer,
  entry,
  PatchFileClass,
  parsePatchFile,
  BPSFormat,
}: Omit<BufferPatchValidationOptions, "entries"> & { entry: ArchiveEntry }) =>
  isValidPatchEntryFromFile({
    archiveCapabilities,
    BPSFormat,
    entry,
    PatchFileClass,
    parsePatchFile,
    source: createArchiveSourceBlob(arrayBuffer, entry.archiveFileName || "archive.bin"),
  }).catch(() => false);

const isValidPatchEntryFromFile = ({
  archiveCapabilities,
  source,
  entry,
  PatchFileClass,
  parsePatchFile,
  BPSFormat,
}: Omit<FilePatchValidationOptions, "entries"> & { entry: ArchiveEntry }) => {
  const blobSource = getBlobSource(source);
  if (blobSource) {
    return archiveCapabilities
      .extractEntryToFile(blobSource, entry.filename, { onProgress: () => undefined })
      .then(async (result) => {
        const patchPatchFile = await createValidatedPatchPatchFileFromFileResult({
          entry,
          PatchFileClass,
          result,
        });
        const isValid = isValidPatchPatchFile(patchPatchFile, parsePatchFile, BPSFormat);
        const cleanupFiles = archiveCapabilities.cleanupFiles;
        const cleanupPaths = result.cleanupPaths;
        if (typeof cleanupFiles !== "function" || !cleanupPaths) return isValid;
        return isValid
          .catch(() => false)
          .then((validated) =>
            cleanupFiles(cleanupPaths).then(
              () => validated,
              () => validated,
            ),
          );
      })
      .catch(() => false);
  }
  if (
    typeof source !== "string" &&
    typeof FileSystemFileHandle !== "undefined" &&
    !(source instanceof FileSystemFileHandle)
  ) {
    return Promise.resolve(false);
  }
  return archiveCapabilities
    .extractEntryFromFile(source as ArchiveFileSource, entry.filename, undefined)
    .then((data) => isValidPatchPatchFile(createPatchPatchFile(entry, data, PatchFileClass), parsePatchFile, BPSFormat))
    .catch(() => false);
};

const filterValidArchivePatchEntries = (
  entries: Array<ArchiveEntry | ArchiveEntryInput>,
  isValidEntry: (entry: ArchiveEntry) => Promise<boolean>,
): Promise<ArchiveEntry[]> => {
  const patchEntries = filterPatchEntries(entries) as ArchiveEntry[];
  const validEntries: ArchiveEntry[] = [];
  return patchEntries
    .reduce<Promise<void>>(
      (promise, entry) =>
        promise
          .then(() => isValidEntry(entry))
          .then((isValid) => {
            if (isValid) validEntries.push(entry);
          }),
      Promise.resolve(),
    )
    .then(() => validEntries);
};

const filterValidPatchEntries = ({
  archiveCapabilities,
  arrayBuffer,
  entries,
  PatchFileClass,
  parsePatchFile,
  BPSFormat,
}: BufferPatchValidationOptions): Promise<ArchiveEntry[]> => {
  return filterValidArchivePatchEntries(entries, (entry) =>
    isValidPatchEntry({ archiveCapabilities, arrayBuffer, BPSFormat, entry, PatchFileClass, parsePatchFile }),
  );
};

const filterValidPatchEntriesFromFile = ({
  archiveCapabilities,
  source,
  entries,
  PatchFileClass,
  parsePatchFile,
  BPSFormat,
}: FilePatchValidationOptions): Promise<ArchiveEntry[]> => {
  return filterValidArchivePatchEntries(entries, (entry) =>
    isValidPatchEntryFromFile({
      archiveCapabilities,
      BPSFormat,
      entry,
      PatchFileClass,
      parsePatchFile,
      source,
    }),
  );
};

export { filterValidPatchEntries, filterValidPatchEntriesFromFile };
