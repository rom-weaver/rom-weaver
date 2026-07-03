import { getFileNameExtension, stripFileNameQuery } from "../../lib/path-utils.ts";
import { hasReadableBytes, toUint8Array } from "../../storage/shared/binary/binary-source-utils.ts";
import { ROM_WEAVER_ARCHIVE_FORMATS } from "../../wasm/generated/rom-weaver-format-metadata.ts";
import type { BlobLike } from "./archive-source-types.ts";

// Archive detection data (magic signatures + the libarchive extension universe)
// is canonical in Rust (`rom-weaver-containers`) and surfaced here via typegen so
// the browser never maintains a second copy. The matcher functions below stay in
// TS: they run synchronously per-entry in worker decompression loops where a wasm
// round-trip is infeasible.
const MAGIC_SIGNATURES = ROM_WEAVER_ARCHIVE_FORMATS.magicSignatures.map((signature) => ({
  bytes: signature.bytes,
  offset: signature.offset,
  type: signature.archiveType,
}));

const toAliasRecord = (aliases: readonly { extension: string; archiveType: string }[]): Record<string, string> =>
  Object.fromEntries(aliases.map((alias) => [alias.extension, alias.archiveType]));

const ARCHIVE_EXTENSION_ALIASES = toAliasRecord(ROM_WEAVER_ARCHIVE_FORMATS.extensionAliases);
const MULTIPART_ARCHIVE_EXTENSION_ALIASES = toAliasRecord(ROM_WEAVER_ARCHIVE_FORMATS.multipartExtensionAliases);
const MULTIPART_ARCHIVE_EXTENSIONS = ROM_WEAVER_ARCHIVE_FORMATS.multipartExtensions;
const SUPPORTED_ARCHIVE_EXTENSIONS = new Set<string>(ROM_WEAVER_ARCHIVE_FORMATS.supportedExtensions);

type ArchiveSourceObject = {
  _file?: BlobLike;
  fileName?: string;
  name?: string;
  getExtension?: () => string;
};

type MagicSignature = {
  type: string;
  bytes: readonly number[];
  offset?: number;
};

const isArchiveSourceObject = (source: RuntimeValue): source is ArchiveSourceObject =>
  !!source && typeof source === "object";

const isBlobLike = (source: RuntimeValue): source is BlobLike =>
  !!source &&
  typeof source === "object" &&
  "size" in source &&
  typeof source.size === "number" &&
  "arrayBuffer" in source &&
  typeof source.arrayBuffer === "function";

const getBlobSource = (source: RuntimeValue) => {
  if (isBlobLike(source)) return source;
  if (isArchiveSourceObject(source) && isBlobLike(source._file)) return source._file;
  return null;
};

const getFileNameLower = (source: RuntimeValue) => {
  if (typeof source === "string") return stripFileNameQuery(source.toLowerCase());
  if (isArchiveSourceObject(source) && typeof source.fileName === "string")
    return stripFileNameQuery(source.fileName.toLowerCase());
  if (isArchiveSourceObject(source) && typeof source.name === "string")
    return stripFileNameQuery(source.name.toLowerCase());
  if (isArchiveSourceObject(source) && source._file && typeof source._file.name === "string")
    return stripFileNameQuery(source._file.name.toLowerCase());
  return "";
};

const getExtension = (source: RuntimeValue) => {
  if (isArchiveSourceObject(source) && typeof source.getExtension === "function")
    return source.getExtension().toLowerCase();
  return getFileNameExtension(getFileNameLower(source));
};

const getSupportedArchiveExtension = (fileName: string, extension: string) => {
  const normalizedExtension = extension.toLowerCase();
  for (const [multiPartExtension, archiveType] of Object.entries(MULTIPART_ARCHIVE_EXTENSION_ALIASES)) {
    if (fileName.endsWith(`.${multiPartExtension}`)) return archiveType;
  }
  for (const multiPartExtension of MULTIPART_ARCHIVE_EXTENSIONS) {
    if (fileName.endsWith(`.${multiPartExtension}`)) return multiPartExtension;
  }
  if (!SUPPORTED_ARCHIVE_EXTENSIONS.has(normalizedExtension)) return null;
  return ARCHIVE_EXTENSION_ALIASES[normalizedExtension] || normalizedExtension;
};

const matchesMagic = (u8array: Uint8Array, signature: MagicSignature) => {
  const offset = signature.offset || 0;
  if (u8array.length < offset + signature.bytes.length) return false;
  return signature.bytes.every((byte, index) => u8array[offset + index] === byte);
};

const getArchiveMagicType = (u8array: Uint8Array) => {
  for (const signature of MAGIC_SIGNATURES) {
    if (matchesMagic(u8array, signature)) return signature.type;
  }
  return null;
};

const getArchiveType = (source: RuntimeValue) => {
  const extension = getExtension(source);
  const fileName = getFileNameLower(source);
  const namedArchiveType = getSupportedArchiveExtension(fileName, extension);
  if (namedArchiveType?.startsWith("tar.")) return namedArchiveType;

  if (!getBlobSource(source) && hasReadableBytes(source)) {
    const u8array = toUint8Array(source);
    return getArchiveMagicType(u8array) || namedArchiveType;
  }
  return namedArchiveType;
};

const isArchiveFile = (source: RuntimeValue) => !!getArchiveType(source);

export { getArchiveMagicType, getArchiveType, isArchiveFile, MAGIC_SIGNATURES };
