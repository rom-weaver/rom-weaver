import {
  getSingleTrackCdExtractionPlan,
  parseCueFile,
  replaceCuePatchFileName,
} from "../../workers/protocol/cue-file-utils.ts";
import {
  createDiscExtensionRegex,
  hasDiscExtension,
  RVZ_DECOMPRESSION_INPUT_EXTENSIONS,
  Z3DS_DECOMPRESSION_INPUT_EXTENSIONS,
} from "../compression/disc-format-support.ts";

const BIN_EXTENSION_REGEX = /\.bin$/i;
const CHD_EXTENSION_REGEX = /\.chd$/i;
const CUE_EXTENSION_REGEX = /\.cue$/i;
const RVZ_EXTENSION_REGEX = createDiscExtensionRegex(RVZ_DECOMPRESSION_INPUT_EXTENSIONS);
const Z3DS_EXTENSION_REGEX = createDiscExtensionRegex(Z3DS_DECOMPRESSION_INPUT_EXTENSIONS);
const FILE_EXTENSION_REGEX = /\.[^./\\?#]*([?#].*)?$/;
const FILE_QUERY_OR_HASH_REGEX = /[?#].*$/;

type ByteInspectableSource = {
  _u8array?: Uint8Array;
  fileName?: string;
  getExtension?: () => string;
  readIntoAt?: (buffer: Uint8Array, bufferOffset?: number, len?: number, fileOffset?: number) => number | undefined;
};

const getFileExtension = (source: ByteInspectableSource | null | undefined): string => {
  if (source && typeof source.getExtension === "function") return source.getExtension().toLowerCase();
  const fileName = String(source?.fileName || "").replace(FILE_QUERY_OR_HASH_REGEX, "");
  const index = fileName.lastIndexOf(".");
  return index === -1 ? "" : fileName.slice(index + 1).toLowerCase();
};

const replaceFileExtension = (fileName: string, extension: string): string =>
  String(fileName || "input.bin").replace(FILE_EXTENSION_REGEX, `.${extension}`);

const getSourceBytes = (source: unknown, length: number): Uint8Array | null => {
  if (source instanceof ArrayBuffer) return new Uint8Array(source, 0, Math.min(length, source.byteLength));
  if (ArrayBuffer.isView(source))
    return new Uint8Array(source.buffer, source.byteOffset, Math.min(length, source.byteLength));
  if (!source || typeof source !== "object") return null;
  const inspectable = source as ByteInspectableSource;
  if (inspectable._u8array instanceof Uint8Array) return inspectable._u8array.subarray(0, length);
  if (typeof inspectable.readIntoAt === "function") {
    const buffer = new Uint8Array(length);
    const read = inspectable.readIntoAt(buffer, 0, length, 0);
    return typeof read === "number" ? buffer.subarray(0, read) : buffer;
  }
  return null;
};

const hasAsciiMagic = (source: unknown, magic: string): boolean => {
  const bytes = getSourceBytes(source, magic.length);
  if (!bytes || bytes.byteLength < magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic.charCodeAt(index)) return false;
  }
  return true;
};

const isChdFile = (source: unknown): boolean =>
  CHD_EXTENSION_REGEX.test(String((source as ByteInspectableSource | null | undefined)?.fileName || "")) ||
  getFileExtension(source as ByteInspectableSource | null | undefined) === "chd" ||
  hasAsciiMagic(source, "MComprHD");

const isRvzFile = (source: unknown): boolean =>
  RVZ_EXTENSION_REGEX.test(String((source as ByteInspectableSource | null | undefined)?.fileName || "")) ||
  hasDiscExtension(
    RVZ_DECOMPRESSION_INPUT_EXTENSIONS,
    getFileExtension(source as ByteInspectableSource | null | undefined),
  ) ||
  hasAsciiMagic(source, "RVZ\0");

const isZ3dsFile = (source: unknown): boolean =>
  Z3DS_EXTENSION_REGEX.test(String((source as ByteInspectableSource | null | undefined)?.fileName || "")) ||
  hasDiscExtension(
    Z3DS_DECOMPRESSION_INPUT_EXTENSIONS,
    getFileExtension(source as ByteInspectableSource | null | undefined),
  ) ||
  hasAsciiMagic(source, "Z3DS");

const getChdAutoCreateMode = (source: ByteInspectableSource & { _chdCueText?: string; _chdMode?: string }): string => {
  if (source._chdMode === "cd" || source._chdCueText) return "cd";
  if (source._chdMode === "dvd") return "dvd";
  const fileName = String(source.fileName || "");
  return CUE_EXTENSION_REGEX.test(fileName) || BIN_EXTENSION_REGEX.test(fileName) ? "cd" : "dvd";
};

const getChdExtractedFileName = (source: ByteInspectableSource & { _chdMode?: string }): string =>
  replaceFileExtension(source.fileName || "input.chd", source._chdMode === "cd" ? "bin" : "iso");

const getRvzExtractedFileName = (source: ByteInspectableSource): string =>
  replaceFileExtension(source.fileName || "input.rvz", "iso");

const getZ3dsExtractedFileName = (source: ByteInspectableSource & { _z3dsUnderlyingMagic?: string }): string => {
  const extension = getFileExtension(source);
  if (extension === "zcia") return replaceFileExtension(source.fileName || "input.zcia", "cia");
  if (extension === "zcci") return replaceFileExtension(source.fileName || "input.zcci", "cci");
  if (extension === "zcxi") return replaceFileExtension(source.fileName || "input.zcxi", "cxi");
  if (extension === "z3ds") return replaceFileExtension(source.fileName || "input.z3ds", "3ds");
  if (extension === "z3dsx") return replaceFileExtension(source.fileName || "input.z3dsx", "3dsx");
  const magic = source._z3dsUnderlyingMagic || "";
  if (magic === "CIA\u0000") return replaceFileExtension(source.fileName || "input.z3ds", "cia");
  if (magic === "NCSD") return replaceFileExtension(source.fileName || "input.z3ds", "cci");
  if (magic === "NCCH") return replaceFileExtension(source.fileName || "input.z3ds", "cxi");
  if (magic === "3DSX") return replaceFileExtension(source.fileName || "input.z3ds", "3dsx");
  return replaceFileExtension(source.fileName || "input.z3ds", "cci");
};

export {
  getChdAutoCreateMode,
  getChdExtractedFileName,
  getRvzExtractedFileName,
  getSingleTrackCdExtractionPlan,
  getZ3dsExtractedFileName,
  isChdFile,
  isRvzFile,
  isZ3dsFile,
  parseCueFile,
  replaceCuePatchFileName,
};
