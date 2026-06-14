import type { ArchiveSourceValue } from "../../storage/browser/archive-source.ts";
import type { ByteSourceRecordLike } from "../../storage/shared/binary/source-shared.ts";
import type { JsonObject } from "../../types/runtime.ts";
import type { WorkflowRomFileLike as InputSource } from "../../types/workflow-source.ts";
import {
  getRomSpecificExtractedFileName,
  ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRATIONS,
} from "../compression/container-format-registry.ts";
import { getArchiveType } from "../input/archive-type-utils.ts";

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

type InputSourceMetadata = {
  _file?: { name?: string };
  fileName?: string;
  name?: string;
};
type RomSpecificMagicProbeableSource = ByteSourceRecordLike & {
  _browserFileBacked?: boolean;
  _romSpecificDecompressionOutput?: boolean;
};

type InputSourceValue =
  | ArchiveSourceValue
  | InputSource
  | (RomSpecificMagicProbeableSource &
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

const canProbeRomSpecificMagicSynchronously = (source: InputSourceValue) => {
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return true;
  if (!isInputSourceObject(source)) return false;
  const probeableSource = source as InputSourceObject & RomSpecificMagicProbeableSource;
  if (probeableSource._u8array instanceof Uint8Array) return true;
  if (probeableSource._browserFileBacked) return false;
  return typeof probeableSource.readIntoAt === "function";
};

const getMagicBytes = (source: InputSourceValue, length: number): Uint8Array | null => {
  if (source instanceof ArrayBuffer) return new Uint8Array(source, 0, Math.min(length, source.byteLength));
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, Math.min(length, source.byteLength));
  }
  if (!isInputSourceObject(source)) return null;
  const probeableSource = source as InputSourceObject & RomSpecificMagicProbeableSource;
  if (probeableSource._u8array instanceof Uint8Array) return probeableSource._u8array.subarray(0, length);
  if (probeableSource._browserFileBacked) return null;
  if (typeof probeableSource.readIntoAt !== "function") return null;
  const buffer = new Uint8Array(length);
  const read = probeableSource.readIntoAt(buffer, 0, length, 0);
  return typeof read === "number" ? buffer.subarray(0, read) : buffer;
};

const hasMagicPrefix = (source: InputSourceValue, magic: readonly number[]) => {
  const bytes = getMagicBytes(source, magic.length);
  return !!bytes && bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
};

const classifyPatcherInput = (source: InputSourceValue): PatcherInputClassification => {
  const fileName = getInputSourceFileName(source);
  if (!source) {
    return {
      fileName: fileName,
      kind: "empty",
    };
  }
  const isRomSpecificDecompressionOutput =
    isInputSourceObject(source) &&
    !!(source as InputSourceObject & RomSpecificMagicProbeableSource)._romSpecificDecompressionOutput;
  const canProbeRomSpecificMagic = canProbeRomSpecificMagicSynchronously(source);
  for (const registration of ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRATIONS) {
    const matchedByExtension = registration.extensionRegex.test(fileName);
    const matchedByMagic = canProbeRomSpecificMagic && hasMagicPrefix(source, registration.magicBytes);
    if (!(matchedByExtension || matchedByMagic)) continue;
    if (matchedByExtension && isRomSpecificDecompressionOutput && !matchedByMagic) continue;
    if (matchedByExtension || matchedByMagic) {
      return {
        compressionFormat: registration.format,
        defaultExtractedEntryName: getRomSpecificExtractedFileName(
          registration.format,
          getInputSourceForExtraction(source, fileName, registration.fallbackFileName, true),
        ),
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

export { classifyPatcherInput, getInputSourceFileName };
