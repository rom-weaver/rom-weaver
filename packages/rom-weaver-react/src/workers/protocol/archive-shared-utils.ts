import { getFileNameExtension, getFileNameWithoutExtension, stripFileNameQuery } from "../../lib/path-utils.ts";
import { hasReadableBytes, toUint8Array } from "../../storage/shared/binary/binary-source-utils.ts";
import type { BlobLike } from "./archive-source-types.ts";

const MACOS_RESOURCE_FORK_ENTRY_REGEX = /(^|\/)\._[^/]+$/i;
const MACOSX_METADATA_DIRECTORY_REGEX = /^__MACOSX\//i;
const ARCHIVE_TYPES = {
  AR: "ar",
  ARJ: "arj",
  BROTLI: "br",
  BZIP2: "bz2",
  CAB: "cab",
  COMPRESS: "z",
  CPIO: "cpio",
  GZIP: "gz",
  LIZARD: "lizard",
  LZ4: "lz4",
  LZ5: "lz5",
  LZIP: "lz",
  LZMA: "lzma",
  RAR: "rar",
  SEVEN_ZIP: "7z",
  TAR: "tar",
  TAR_BROTLI: "tar.br",
  TAR_BZIP2: "tar.bz2",
  TAR_GZIP: "tar.gz",
  TAR_LIZARD: "tar.lizard",
  TAR_LZ4: "tar.lz4",
  TAR_LZ5: "tar.lz5",
  TAR_LZIP: "tar.lz",
  TAR_LZMA: "tar.lzma",
  TAR_XZ: "tar.xz",
  TAR_ZSTD: "tar.zst",
  XZ: "xz",
  ZIP: "zip",
  ZSTD: "zst",
};

const MAGIC_SIGNATURES = [
  { bytes: [0x50, 0x4b, 0x03, 0x04], type: ARCHIVE_TYPES.ZIP },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], type: ARCHIVE_TYPES.SEVEN_ZIP },
  { bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00], type: ARCHIVE_TYPES.RAR },
  { bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00], type: ARCHIVE_TYPES.RAR },
  { bytes: [0x75, 0x73, 0x74, 0x61, 0x72], offset: 257, type: ARCHIVE_TYPES.TAR },
  { bytes: [0x60, 0xea], type: ARCHIVE_TYPES.ARJ },
  { bytes: [0x1f, 0x8b], type: ARCHIVE_TYPES.GZIP },
  { bytes: [0x42, 0x5a, 0x68], type: ARCHIVE_TYPES.BZIP2 },
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], type: ARCHIVE_TYPES.XZ },
  { bytes: [0x28, 0xb5, 0x2f, 0xfd], type: ARCHIVE_TYPES.ZSTD },
  { bytes: [0x5d, 0x00, 0x00], type: ARCHIVE_TYPES.LZMA },
  { bytes: [0x04, 0x22, 0x4d, 0x18], type: ARCHIVE_TYPES.LZ4 },
  { bytes: [0x05, 0x22, 0x4d, 0x18], type: ARCHIVE_TYPES.LZ5 },
  { bytes: [0x06, 0x22, 0x4d, 0x18], type: ARCHIVE_TYPES.LIZARD },
  { bytes: [0x4c, 0x5a, 0x49, 0x50], type: ARCHIVE_TYPES.LZIP },
  { bytes: [0x1f, 0x9d], type: ARCHIVE_TYPES.COMPRESS },
  { bytes: [0x1f, 0xa0], type: ARCHIVE_TYPES.COMPRESS },
  { bytes: [0x4d, 0x53, 0x43, 0x46], type: ARCHIVE_TYPES.CAB },
  { bytes: [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a], type: ARCHIVE_TYPES.AR },
  { bytes: [0x30, 0x37, 0x30, 0x37, 0x30], type: ARCHIVE_TYPES.CPIO },
  { bytes: [0xc7, 0x71], type: ARCHIVE_TYPES.CPIO },
  { bytes: [0x71, 0xc7], type: ARCHIVE_TYPES.CPIO },
  { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], type: "compound" },
  { bytes: [0x49, 0x54, 0x53, 0x46, 0x03, 0x00, 0x00, 0x00], type: "chm" },
  { bytes: [0x51, 0x46, 0x49, 0xfb], type: "qcow" },
  { bytes: [0xed, 0xab, 0xee, 0xdb], type: "rpm" },
  { bytes: [0x68, 0x73, 0x71, 0x73], type: "squashfs" },
  { bytes: [0x73, 0x71, 0x73, 0x68], type: "squashfs" },
  { bytes: [0x73, 0x68, 0x73, 0x71], type: "squashfs" },
  { bytes: [0x71, 0x73, 0x68, 0x73], type: "squashfs" },
  { bytes: [0x4d, 0x53, 0x57, 0x49, 0x4d, 0x00, 0x00, 0x00], type: "wim" },
  { bytes: [0x78, 0x61, 0x72, 0x21, 0x00], type: "xar" },
];

const WRAPPED_ARCHIVE_TYPE_VALUES = [
  ARCHIVE_TYPES.BROTLI,
  "brotli",
  ARCHIVE_TYPES.BZIP2,
  "bzip2",
  ARCHIVE_TYPES.COMPRESS,
  "compress",
  ARCHIVE_TYPES.GZIP,
  "gzip",
  ARCHIVE_TYPES.LIZARD,
  ARCHIVE_TYPES.LZ4,
  ARCHIVE_TYPES.LZ5,
  ARCHIVE_TYPES.LZIP,
  "lzip",
  ARCHIVE_TYPES.LZMA,
  "lzma86",
  "mslz",
  "pmd",
  "ppmd",
  ARCHIVE_TYPES.XZ,
  ARCHIVE_TYPES.ZSTD,
  "zstd",
  "zstandard",
];
const WRAPPED_ARCHIVE_TYPES = new Set(WRAPPED_ARCHIVE_TYPE_VALUES);

const FILTER_PATCHES = /\.(ips|ups|bps|aps|rup|ppf|ebp|bdf|bspatch|mod|xdelta|vcdiff)\d*$/i;
const ARCHIVE_EXTENSION_ALIASES: Record<string, string> = {
  a: ARCHIVE_TYPES.AR,
  brotli: ARCHIVE_TYPES.BROTLI,
  bzip2: ARCHIVE_TYPES.BZIP2,
  chi: "chm",
  chq: "chm",
  gzip: ARCHIVE_TYPES.GZIP,
  lib: ARCHIVE_TYPES.AR,
  liz: ARCHIVE_TYPES.LIZARD,
  lzip: ARCHIVE_TYPES.LZIP,
  ova: ARCHIVE_TYPES.TAR,
  pkg: "xar",
  r00: ARCHIVE_TYPES.RAR,
  taz: ARCHIVE_TYPES.TAR_GZIP,
  tbr: ARCHIVE_TYPES.TAR_BROTLI,
  tbz: ARCHIVE_TYPES.TAR_BZIP2,
  tbz2: ARCHIVE_TYPES.TAR_BZIP2,
  tgz: ARCHIVE_TYPES.TAR_GZIP,
  tliz: ARCHIVE_TYPES.TAR_LIZARD,
  tlz: ARCHIVE_TYPES.TAR_LZMA,
  tlz4: ARCHIVE_TYPES.TAR_LZ4,
  tlz5: ARCHIVE_TYPES.TAR_LZ5,
  tpz: ARCHIVE_TYPES.TAR_GZIP,
  txz: ARCHIVE_TYPES.TAR_XZ,
  tzst: ARCHIVE_TYPES.TAR_ZSTD,
  tzstd: ARCHIVE_TYPES.TAR_ZSTD,
  xip: "xar",
  z01: ARCHIVE_TYPES.ZIP,
  zstd: ARCHIVE_TYPES.ZSTD,
};
const MULTIPART_ARCHIVE_EXTENSION_ALIASES: Record<string, string> = {
  "tar.brotli": ARCHIVE_TYPES.TAR_BROTLI,
  "tar.lzip": ARCHIVE_TYPES.TAR_LZIP,
  "tar.zstd": ARCHIVE_TYPES.TAR_ZSTD,
};
const MULTIPART_ARCHIVE_EXTENSIONS = [
  "tar.gz",
  "tar.bz2",
  "tar.xz",
  "tar.lzma",
  "tar.zst",
  "tar.br",
  "tar.lz",
  "tar.lz4",
  "tar.lz5",
  "tar.lizard",
];
const SUPPORTED_ARCHIVE_EXTENSION_VALUES = [
  "001",
  "7z",
  "a",
  "aaf",
  "apfs",
  "apk",
  "apm",
  "appx",
  "ar",
  "arj",
  "avhdx",
  "b64",
  "br",
  "brotli",
  "bz2",
  "bzip2",
  "cab",
  "chi",
  "chm",
  "chq",
  "chw",
  "cpio",
  "cramfs",
  "deb",
  "dmg",
  "doc",
  "docx",
  "epub",
  "esd",
  "ext",
  "ext2",
  "ext3",
  "ext4",
  "fat",
  "gpt",
  "gz",
  "gzip",
  "hfs",
  "hfsx",
  "hxi",
  "hxq",
  "hxr",
  "hxs",
  "hxw",
  "ihex",
  "ipa",
  "jar",
  "lha",
  "lib",
  "lit",
  "liz",
  "lzh",
  "lizard",
  "lpimg",
  "lz",
  "lz4",
  "lz5",
  "lzip",
  "lzma",
  "lzma86",
  "mbr",
  "msi",
  "mslz",
  "msp",
  "msm",
  "mub",
  "nsis",
  "ntfs",
  "ods",
  "odt",
  "ova",
  "pmd",
  "ppkg",
  "ppt",
  "pkg",
  "qcow",
  "qcow2",
  "qcow2c",
  "r00",
  "rar",
  "rpm",
  "scap",
  "sfs",
  "simg",
  "squashfs",
  "swm",
  "tar",
  "tar.br",
  "tar.brotli",
  "tar.bz2",
  "tar.gz",
  "tar.lizard",
  "tar.lz",
  "tar.lz4",
  "tar.lz5",
  "tar.lzip",
  "tar.lzma",
  "tar.xz",
  "tar.zst",
  "tar.zstd",
  "taz",
  "tbz",
  "tbz2",
  "tbr",
  "te",
  "tgz",
  "tliz",
  "tlz",
  "tlz4",
  "tlz5",
  "tpz",
  "txz",
  "tzst",
  "tzstd",
  "udf",
  "udeb",
  "uefi",
  "uefif",
  "vdi",
  "vhd",
  "vhdx",
  "vmdk",
  "wim",
  "xar",
  "xip",
  "xls",
  "xlsx",
  "xpi",
  "xz",
  "z",
  "z01",
  "zip",
  "zipx",
  "zst",
  "zstd",
];
const SUPPORTED_ARCHIVE_EXTENSIONS = new Set(SUPPORTED_ARCHIVE_EXTENSION_VALUES);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FILTER_NON_ROM_EXTENSIONS = [
  "txt",
  "diz",
  "rtf",
  "docx?",
  "xlsx?",
  "html?",
  "pdf",
  "jpe?g",
  "gif",
  "png",
  "bmp",
  "webp",
  ...SUPPORTED_ARCHIVE_EXTENSION_VALUES.map(escapeRegex),
];
const FILTER_NON_ROMS = new RegExp(`\\.(${FILTER_NON_ROM_EXTENSIONS.join("|")})$`, "i");

type ArchiveSourceObject = {
  _file?: BlobLike;
  fileName?: string;
  name?: string;
  getExtension?: () => string;
};

type ArchiveEntry = {
  filename?: string;
};

type NamedArchiveEntry<TEntry extends ArchiveEntry> = TEntry & { filename: string };

type MagicSignature = {
  type: string;
  bytes: number[];
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

const isWrappedArchiveType = (archiveType: string | null | undefined) =>
  WRAPPED_ARCHIVE_TYPES.has(String(archiveType || "").toLowerCase());

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

const isMetadataEntry = (filename: string) =>
  MACOSX_METADATA_DIRECTORY_REGEX.test(filename) || MACOS_RESOURCE_FORK_ENTRY_REGEX.test(filename);

const sortFileEntries = <TEntry extends ArchiveEntry>(entries: TEntry[]) =>
  entries
    .sort((file1, file2) =>
      getFileNameWithoutExtension((file1.filename || "").toLowerCase()).localeCompare(
        getFileNameWithoutExtension((file2.filename || "").toLowerCase()),
      ),
    )
    .sort(
      (file1, file2) =>
        ((file1.filename || "").indexOf("/") === -1 ? 0 : 1) - ((file2.filename || "").indexOf("/") === -1 ? 0 : 1),
    );

const filterArchiveEntries = <TEntry extends ArchiveEntry>(
  entries: TEntry[],
  includeEntry: (entry: NamedArchiveEntry<TEntry>) => boolean,
) =>
  sortFileEntries(
    entries.filter((entry): entry is NamedArchiveEntry<TEntry> => {
      if (!entry.filename || isMetadataEntry(entry.filename)) return false;
      return includeEntry(entry as NamedArchiveEntry<TEntry>);
    }),
  );

const filterRomEntries = <TEntry extends ArchiveEntry>(entries: TEntry[]) =>
  filterArchiveEntries(
    entries,
    (entry) => !(FILTER_NON_ROMS.test(entry.filename) || FILTER_PATCHES.test(entry.filename)),
  );

const filterPatchEntries = <TEntry extends ArchiveEntry>(entries: TEntry[]) =>
  filterArchiveEntries(entries, (entry) => FILTER_PATCHES.test(entry.filename));

export {
  ARCHIVE_TYPES,
  FILTER_NON_ROMS,
  FILTER_PATCHES,
  filterPatchEntries,
  filterRomEntries,
  getArchiveMagicType,
  getArchiveType,
  getBlobSource,
  getExtension,
  getFileNameLower,
  getSupportedArchiveExtension,
  isArchiveFile,
  isMetadataEntry,
  isWrappedArchiveType,
  MAGIC_SIGNATURES,
  matchesMagic,
  SUPPORTED_ARCHIVE_EXTENSION_VALUES,
  sortFileEntries,
};
