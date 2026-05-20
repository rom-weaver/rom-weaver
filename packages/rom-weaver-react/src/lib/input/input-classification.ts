import type { ArchiveSourceValue } from "../../storage/browser/archive-source.ts";
import type { ByteSourceRecordLike } from "../../storage/shared/binary/source-shared.ts";
import type { ArchiveEntry, JsonObject } from "../../types/runtime.ts";
import type { WorkflowRomFileLike as InputSource } from "../../types/workflow-source.ts";
import {
  createDiscExtensionRegex,
  RVZ_DECOMPRESSION_INPUT_EXTENSIONS,
  Z3DS_DECOMPRESSION_INPUT_EXTENSIONS,
} from "../compression/disc-format-support.ts";
import { getArchiveType } from "../input/archive-type-utils.ts";
import { getChdExtractedFileName, getRvzExtractedFileName, getZ3dsExtractedFileName } from "./disc-file-utils.ts";

const CHD_EXTENSION_REGEX = /\.chd$/i;
const RVZ_EXTENSION_REGEX = createDiscExtensionRegex(RVZ_DECOMPRESSION_INPUT_EXTENSIONS);
const Z3DS_EXTENSION_REGEX = createDiscExtensionRegex(Z3DS_DECOMPRESSION_INPUT_EXTENSIONS);

type PatcherInputClassification =
  | {
      kind: "empty" | "raw";
      fileName: string;
    }
  | {
      kind: "compression";
      compressionFormat: string;
      defaultExtractedEntryName: string;
      fileName: string;
    };

type ArchiveEntrySelection = {
  role: "rom" | "patch";
  candidates: ArchiveEntry[];
  action: "extract" | "choose" | "fallback-raw" | "empty";
};

type InputSourceMetadata = {
  _file?: { name?: string };
  fileName?: string;
  name?: string;
};
type DiscMagicInspectableSource = ByteSourceRecordLike & {
  _browserFileBacked?: boolean;
  _discDecompressionOutput?: boolean;
};

type InputSourceValue =
  | ArchiveSourceValue
  | InputSource
  | (DiscMagicInspectableSource &
      InputSourceMetadata & {
        _file?: Blob & { name?: string };
        getExtension?: () => string;
      })
  | ArrayBuffer
  | ArrayBufferLike
  | ArrayBufferView
  | JsonObject
  | string
  | number
  | boolean
  | null
  | undefined;

type InputSourceObject = Extract<InputSourceValue, object>;
type DiscClassifier = {
  extensionRegex: RegExp;
  fallbackFileName: string;
  getExtractedFileName: (source: InputSourceValue, fileName: string, fallbackFileName: string) => string;
  kind: string;
  magic: number[];
};

const isInputSourceObject = (source: InputSourceValue): source is InputSourceObject =>
  typeof source === "object" && source !== null;

const getInputSourceFileName = (source: InputSourceValue): string => {
  if (!isInputSourceObject(source)) return "";
  const sourceMetadata = source as InputSourceObject & InputSourceMetadata;
  if (typeof sourceMetadata.fileName === "string") return sourceMetadata.fileName;
  if (typeof sourceMetadata.name === "string") return sourceMetadata.name;
  const embeddedFile = sourceMetadata._file;
  if (embeddedFile && typeof embeddedFile.name === "string") return embeddedFile.name;
  return "";
};

const getInputSourceForExtraction = (
  source: InputSourceValue,
  fileName: string,
  fallbackFileName: string,
  includeMetadata = false,
) => {
  const sourceMetadata = isInputSourceObject(source) ? (source as InputSourceObject & InputSourceMetadata) : {};
  const sourceWithFileName = {
    fileName: fileName || sourceMetadata.fileName || fallbackFileName,
  };
  return includeMetadata ? Object.assign({}, sourceMetadata, sourceWithFileName) : sourceWithFileName;
};

const canInspectDiscMagicSynchronously = (source: InputSourceValue) => {
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return true;
  if (!isInputSourceObject(source)) return false;
  const inspectableSource = source as InputSourceObject & DiscMagicInspectableSource;
  if (inspectableSource._u8array instanceof Uint8Array) return true;
  if (inspectableSource._browserFileBacked) return false;
  return typeof inspectableSource.readIntoAt === "function";
};

const getMagicBytes = (source: InputSourceValue, length: number): Uint8Array | null => {
  if (source instanceof ArrayBuffer) return new Uint8Array(source, 0, Math.min(length, source.byteLength));
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, Math.min(length, source.byteLength));
  }
  if (!isInputSourceObject(source)) return null;
  const inspectableSource = source as InputSourceObject & DiscMagicInspectableSource;
  if (inspectableSource._u8array instanceof Uint8Array) return inspectableSource._u8array.subarray(0, length);
  if (inspectableSource._browserFileBacked) return null;
  if (typeof inspectableSource.readIntoAt !== "function") return null;
  const buffer = new Uint8Array(length);
  const read = inspectableSource.readIntoAt(buffer, 0, length, 0);
  return typeof read === "number" ? buffer.subarray(0, read) : buffer;
};

const hasMagicPrefix = (source: InputSourceValue, magic: number[]) => {
  const bytes = getMagicBytes(source, magic.length);
  return !!bytes && bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
};

const DISC_CLASSIFIERS: DiscClassifier[] = [
  {
    extensionRegex: CHD_EXTENSION_REGEX,
    fallbackFileName: "input.chd",
    getExtractedFileName: (source, fileName, fallbackFileName) =>
      getChdExtractedFileName(
        getInputSourceForExtraction(source, fileName, fallbackFileName, true) as Parameters<
          typeof getChdExtractedFileName
        >[0],
      ),
    kind: "chd",
    magic: [0x4d, 0x43, 0x6f, 0x6d, 0x70, 0x72, 0x48, 0x44],
  },
  {
    extensionRegex: RVZ_EXTENSION_REGEX,
    fallbackFileName: "input.rvz",
    getExtractedFileName: (source, fileName, fallbackFileName) =>
      getRvzExtractedFileName(
        getInputSourceForExtraction(source, fileName, fallbackFileName) as Parameters<
          typeof getRvzExtractedFileName
        >[0],
      ),
    kind: "rvz",
    magic: [0x52, 0x56, 0x5a, 0x00],
  },
  {
    extensionRegex: Z3DS_EXTENSION_REGEX,
    fallbackFileName: "input.z3ds",
    getExtractedFileName: (source, fileName, fallbackFileName) =>
      getZ3dsExtractedFileName(
        getInputSourceForExtraction(source, fileName, fallbackFileName) as Parameters<
          typeof getZ3dsExtractedFileName
        >[0],
      ),
    kind: "z3ds",
    magic: [0x5a, 0x33, 0x44, 0x53],
  },
];

const classifyPatcherInput = (source: InputSourceValue): PatcherInputClassification => {
  const fileName = getInputSourceFileName(source);
  if (!source) {
    return {
      fileName: fileName,
      kind: "empty",
    };
  }
  const isDiscDecompressionOutput =
    isInputSourceObject(source) &&
    !!(source as InputSourceObject & DiscMagicInspectableSource)._discDecompressionOutput;
  const canInspectDiscMagic = canInspectDiscMagicSynchronously(source);
  for (const classifier of DISC_CLASSIFIERS) {
    const matchedByExtension = classifier.extensionRegex.test(fileName);
    const matchedByMagic = canInspectDiscMagic && hasMagicPrefix(source, classifier.magic);
    if (!(matchedByExtension || matchedByMagic)) continue;
    if (matchedByExtension && isDiscDecompressionOutput && !matchedByMagic) continue;
    if (matchedByExtension || matchedByMagic) {
      return {
        compressionFormat: classifier.kind,
        defaultExtractedEntryName: classifier.getExtractedFileName(source, fileName, classifier.fallbackFileName),
        fileName: fileName,
        kind: "compression",
      };
    }
  }
  const archiveType = getArchiveType(source);
  if (archiveType) {
    return {
      compressionFormat: archiveType,
      defaultExtractedEntryName: fileName,
      fileName: fileName,
      kind: "compression",
    };
  }
  return {
    fileName: fileName,
    kind: "raw",
  };
};

const selectArchiveEntriesForRole = (
  role: "rom" | "patch" | string | null | undefined,
  entries: ArchiveEntry[] | null | undefined,
): ArchiveEntrySelection => {
  const candidates: ArchiveEntry[] = Array.isArray(entries) ? entries : [];
  const normalizedRole = role === "patch" ? "patch" : "rom";
  return {
    action:
      candidates.length === 1
        ? "extract"
        : (() => {
            if (candidates.length > 1) {
              return "choose";
            }
            if (normalizedRole === "rom") {
              return "fallback-raw";
            }
            return "empty";
          })(),
    candidates: candidates,
    role: normalizedRole,
  };
};

export type { ArchiveEntrySelection, InputSourceValue, PatcherInputClassification };
export { classifyPatcherInput, getInputSourceFileName, selectArchiveEntriesForRole };
