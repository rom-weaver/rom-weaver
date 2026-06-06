import type { ApplySettings, CompressionFormat } from "../../types/settings.ts";
import type { RuntimeWorkerSourceScope } from "../../types/workflow-runtime-adapter.ts";
import {
  getFileNameExtension,
  hasFileNameExtension,
  replaceFileNameExtension,
  stripLeadingExtensionDot,
} from "../path-utils.ts";
import {
  CHD_COMPRESSION_INPUT_EXTENSIONS,
  CHD_DECOMPRESSION_INPUT_EXTENSIONS,
  createDiscExtensionRegex,
  getUnambiguousDiscCompressionInputExtensions,
  hasDiscExtension,
  RVZ_COMPRESSION_INPUT_EXTENSIONS,
  RVZ_DECOMPRESSION_INPUT_EXTENSIONS,
  Z3DS_COMPRESSION_INPUT_EXTENSIONS,
  Z3DS_DECOMPRESSION_INPUT_EXTENSIONS,
} from "./disc-format-support.ts";
import OutputCompressionManager from "./output-compression-manager.ts";

type ByteProbeableSource = {
  _chdMode?: string;
  _u8array?: Uint8Array;
  _z3dsUnderlyingMagic?: string;
  fileName?: string;
  getExtension?: () => string;
  readIntoAt?: (buffer: Uint8Array, bufferOffset?: number, len?: number, fileOffset?: number) => number | undefined;
};

type CompressionOutputExtensionContext = {
  inputFileName?: string;
  settings?: Partial<ApplySettings>;
};
type CompressionParentKindEntry = {
  kind?: string | null;
};

type ArchiveCompressionFormat = Extract<CompressionFormat, "7z" | "zip">;
type DiscCompressionFormat = Extract<CompressionFormat, "chd" | "rvz" | "z3ds">;
type DiscRuntimeCreateMethod = "createChd" | "createRvz" | "createZ3ds";
type DiscRuntimeExtractMethod = "extractChd" | "extractRvz" | "extractZ3ds";
type DiscRuntimeListMethod = "listChd" | "listRvz" | "listZ3ds";
type DiscRuntimeScope = Extract<RuntimeWorkerSourceScope, "chd" | "rvz" | "z3ds">;

type CompressionFormatRegistrationBase<TFormat extends CompressionFormat> = {
  automaticParentKinds?: readonly string[];
  automaticSourceExtensions?: readonly string[];
  format: TFormat;
  label: string;
  outputExtension: (context: CompressionOutputExtensionContext) => string;
};

type ArchiveCompressionFormatRegistration = CompressionFormatRegistrationBase<ArchiveCompressionFormat>;

type NoneCompressionFormatRegistration = CompressionFormatRegistrationBase<"none">;

type DiscCompressionFormatRegistration = CompressionFormatRegistrationBase<DiscCompressionFormat> & {
  create: DiscRuntimeCreateMethod;
  decompressionInputExtensions: readonly string[];
  extract: DiscRuntimeExtractMethod;
  extractedFileName: (source: ByteProbeableSource) => string;
  extensionRegex: RegExp;
  fallbackFileName: string;
  list: DiscRuntimeListMethod;
  magic: string;
  magicBytes: readonly number[];
  pathPrefix: {
    create: string;
    extract: string;
    sidecar?: string;
  };
  scope: DiscRuntimeScope;
};

type CompressionFormatRegistration =
  | ArchiveCompressionFormatRegistration
  | DiscCompressionFormatRegistration
  | NoneCompressionFormatRegistration;

const getFileExtension = (source: ByteProbeableSource | null | undefined): string => {
  if (source && typeof source.getExtension === "function") return source.getExtension().toLowerCase();
  return getFileNameExtension(source?.fileName);
};

const replaceFileExtension = (fileName: string, extension: string): string => {
  const normalizedFileName = String(fileName || "input.bin");
  return hasFileNameExtension(normalizedFileName)
    ? replaceFileNameExtension(normalizedFileName, extension)
    : normalizedFileName;
};

const getSourceFileExtension = (fileName: string | undefined) => getFileNameExtension(fileName);

const normalizeExtension = (extension: string | number | boolean | null | undefined) =>
  stripLeadingExtensionDot(extension).toLowerCase();

const createMagicBytes = (magic: string): readonly number[] =>
  Array.from(magic, (character) => character.charCodeAt(0));

const getOriginalOutputExtension = ({ inputFileName }: CompressionOutputExtensionContext) =>
  getSourceFileExtension(inputFileName);

const getZ3dsOutputExtension = ({ inputFileName }: CompressionOutputExtensionContext) => {
  const extension = getSourceFileExtension(inputFileName);
  if (extension === "cia" || extension === "zcia") return "zcia";
  if (extension === "3ds" || extension === "z3ds") return "z3ds";
  if (extension === "cci" || extension === "zcci") return "zcci";
  if (extension === "cxi" || extension === "app" || extension === "zcxi") return "zcxi";
  if (extension === "3dsx" || extension === "z3dsx") return "z3dsx";
  return "z3ds";
};

const getChdExtractedFileName = (source: ByteProbeableSource): string =>
  replaceFileExtension(source.fileName || "input.chd", source._chdMode === "cd" ? "bin" : "iso");

const getRvzExtractedFileName = (source: ByteProbeableSource): string =>
  replaceFileExtension(source.fileName || "input.rvz", "iso");

const getZ3dsExtractedExtensionForMagic = (magic: string): string | null => {
  if (magic === "CIA\u0000") return "cia";
  if (magic === "NCSD") return "cci";
  if (magic === "NCCH") return "cxi";
  if (magic === "3DSX") return "3dsx";
  return null;
};

const getZ3dsExtractedExtension = (source: ByteProbeableSource): string => {
  const extension = getFileExtension(source);
  if (extension === "zcia") return "cia";
  if (extension === "zcci") return "cci";
  if (extension === "zcxi") return "cxi";
  if (extension === "z3dsx") return "3dsx";
  const magicExtension = getZ3dsExtractedExtensionForMagic(source._z3dsUnderlyingMagic || "");
  if (extension === "z3ds") return magicExtension || "3ds";
  return magicExtension || "3ds";
};

const getZ3dsExtractedFileName = (source: ByteProbeableSource): string => {
  return replaceFileNameExtension(source.fileName || "input.z3ds", getZ3dsExtractedExtension(source));
};

const normalizeZ3dsExtractedFileName = (
  fileName: string | number | boolean | null | undefined,
  source: ByteProbeableSource,
): string => {
  const normalizedFileName = String(fileName || "").trim();
  const extractedExtension = getFileNameExtension(getZ3dsExtractedFileName(source));
  if (!(normalizedFileName && extractedExtension)) return getZ3dsExtractedFileName(source);
  return replaceFileNameExtension(normalizedFileName, extractedExtension);
};

const normalizeDiscExtractedFileName = (
  format: DiscCompressionFormat,
  fileName: string | number | boolean | null | undefined,
  source: ByteProbeableSource,
): string => {
  if (format === "z3ds") return normalizeZ3dsExtractedFileName(fileName, source);
  return String(fileName || "").trim() || getDiscExtractedFileName(format, source);
};

const createAutomaticDiscSourceExtensions = (
  compressionInputExtensions: readonly string[],
  decompressionInputExtensions: readonly string[],
): readonly string[] => [
  ...getUnambiguousDiscCompressionInputExtensions(compressionInputExtensions),
  ...decompressionInputExtensions,
];

const DISC_COMPRESSION_FORMAT_REGISTRY = {
  chd: {
    automaticParentKinds: ["chd"],
    automaticSourceExtensions: createAutomaticDiscSourceExtensions(
      CHD_COMPRESSION_INPUT_EXTENSIONS,
      CHD_DECOMPRESSION_INPUT_EXTENSIONS,
    ),
    create: "createChd",
    decompressionInputExtensions: CHD_DECOMPRESSION_INPUT_EXTENSIONS,
    extensionRegex: createDiscExtensionRegex(CHD_DECOMPRESSION_INPUT_EXTENSIONS),
    extract: "extractChd",
    extractedFileName: getChdExtractedFileName,
    fallbackFileName: "input.chd",
    format: "chd",
    label: "CHD",
    list: "listChd",
    magic: "MComprHD",
    magicBytes: createMagicBytes("MComprHD"),
    outputExtension: () => "chd",
    pathPrefix: {
      create: "chd-image",
      extract: "chd-input",
      sidecar: "chd-track",
    },
    scope: "chd",
  },
  rvz: {
    automaticParentKinds: ["rvz"],
    automaticSourceExtensions: createAutomaticDiscSourceExtensions(
      RVZ_COMPRESSION_INPUT_EXTENSIONS,
      RVZ_DECOMPRESSION_INPUT_EXTENSIONS,
    ),
    create: "createRvz",
    decompressionInputExtensions: RVZ_DECOMPRESSION_INPUT_EXTENSIONS,
    extensionRegex: createDiscExtensionRegex(RVZ_DECOMPRESSION_INPUT_EXTENSIONS),
    extract: "extractRvz",
    extractedFileName: getRvzExtractedFileName,
    fallbackFileName: "input.rvz",
    format: "rvz",
    label: "RVZ",
    list: "listRvz",
    magic: "RVZ\u0000",
    magicBytes: createMagicBytes("RVZ\u0000"),
    outputExtension: () => "rvz",
    pathPrefix: {
      create: "rvz-image",
      extract: "rvz-input",
    },
    scope: "rvz",
  },
  z3ds: {
    automaticParentKinds: ["z3ds"],
    automaticSourceExtensions: createAutomaticDiscSourceExtensions(
      Z3DS_COMPRESSION_INPUT_EXTENSIONS,
      Z3DS_DECOMPRESSION_INPUT_EXTENSIONS,
    ),
    create: "createZ3ds",
    decompressionInputExtensions: Z3DS_DECOMPRESSION_INPUT_EXTENSIONS,
    extensionRegex: createDiscExtensionRegex(Z3DS_DECOMPRESSION_INPUT_EXTENSIONS),
    extract: "extractZ3ds",
    extractedFileName: getZ3dsExtractedFileName,
    fallbackFileName: "input.z3ds",
    format: "z3ds",
    label: "Z3DS",
    list: "listZ3ds",
    magic: "Z3DS",
    magicBytes: createMagicBytes("Z3DS"),
    outputExtension: getZ3dsOutputExtension,
    pathPrefix: {
      create: "z3ds-image",
      extract: "z3ds-input",
    },
    scope: "z3ds",
  },
} satisfies Record<DiscCompressionFormat, DiscCompressionFormatRegistration>;

const COMPRESSION_FORMAT_REGISTRY = {
  "7z": {
    automaticParentKinds: ["7z"],
    automaticSourceExtensions: ["7z"],
    format: "7z",
    label: "7z",
    outputExtension: () => "7z",
  },
  chd: DISC_COMPRESSION_FORMAT_REGISTRY.chd,
  none: {
    format: "none",
    label: "None",
    outputExtension: getOriginalOutputExtension,
  },
  rvz: DISC_COMPRESSION_FORMAT_REGISTRY.rvz,
  z3ds: DISC_COMPRESSION_FORMAT_REGISTRY.z3ds,
  zip: {
    automaticParentKinds: ["zip"],
    automaticSourceExtensions: ["zip", "zipx"],
    format: "zip",
    label: "ZIP",
    outputExtension: ({ settings }) =>
      OutputCompressionManager.getArchiveOutputExtension("zip", {
        zipCodec: settings?.output?.container?.zipCodec,
      }),
  },
} satisfies Record<CompressionFormat, CompressionFormatRegistration>;

const COMPRESSION_FORMAT_REGISTRATIONS = Object.values(COMPRESSION_FORMAT_REGISTRY) as CompressionFormatRegistration[];
const DISC_COMPRESSION_FORMAT_REGISTRATIONS = Object.values(
  DISC_COMPRESSION_FORMAT_REGISTRY,
) as DiscCompressionFormatRegistration[];
const COMPRESSION_FORMATS = Object.keys(COMPRESSION_FORMAT_REGISTRY) as CompressionFormat[];

const isCompressionFormat = (value: unknown): value is CompressionFormat =>
  typeof value === "string" && Object.hasOwn(COMPRESSION_FORMAT_REGISTRY, value);

const isDiscCompressionFormat = (value: unknown): value is DiscCompressionFormat =>
  typeof value === "string" && Object.hasOwn(DISC_COMPRESSION_FORMAT_REGISTRY, value);

const getCompressionFormatRegistration = (
  format: string | null | undefined,
): CompressionFormatRegistration | undefined =>
  isCompressionFormat(format) ? COMPRESSION_FORMAT_REGISTRY[format] : undefined;

const getDiscCompressionFormatRegistration = (
  format: string | null | undefined,
): DiscCompressionFormatRegistration | undefined =>
  isDiscCompressionFormat(format) ? DISC_COMPRESSION_FORMAT_REGISTRY[format] : undefined;

const getCompressionOutputExtension = (
  format: CompressionFormat,
  context: CompressionOutputExtensionContext = {},
): string => COMPRESSION_FORMAT_REGISTRY[format].outputExtension(context);

const getDiscExtractedFileName = (format: DiscCompressionFormat, source: ByteProbeableSource): string =>
  DISC_COMPRESSION_FORMAT_REGISTRY[format].extractedFileName(source);

const hasDiscCompressionFormatExtension = (
  format: DiscCompressionFormat,
  extension: string | number | boolean | null | undefined,
): boolean => hasDiscExtension(DISC_COMPRESSION_FORMAT_REGISTRY[format].decompressionInputExtensions, extension);

const getCompressionFormatForParentKind = (parentKind: string | null | undefined): CompressionFormat | undefined => {
  const normalizedParentKind = String(parentKind || "").toLowerCase();
  if (!normalizedParentKind) return undefined;
  return COMPRESSION_FORMAT_REGISTRATIONS.find((registration) =>
    registration.automaticParentKinds?.includes(normalizedParentKind),
  )?.format;
};

const getCompressionFormatForParentCompressions = (
  parentCompressions: readonly CompressionParentKindEntry[] | null | undefined,
): CompressionFormat | undefined => {
  if (!Array.isArray(parentCompressions) || parentCompressions.length === 0) return undefined;
  for (let index = parentCompressions.length - 1; index >= 0; index -= 1) {
    const format = getCompressionFormatForParentKind(parentCompressions[index]?.kind);
    if (format) return format;
  }
  return undefined;
};

const getCompressionFormatForFileExtension = (
  extension: string | number | boolean | null | undefined,
): CompressionFormat | undefined => {
  const normalized = normalizeExtension(extension);
  if (!normalized) return undefined;
  return COMPRESSION_FORMAT_REGISTRATIONS.find((registration) =>
    registration.automaticSourceExtensions?.includes(normalized),
  )?.format;
};

const resolveAutomaticCompressionFormat = ({
  fallback = "7z",
  parentCompressions,
  parentKind,
  sourceFileName,
}: {
  fallback?: CompressionFormat;
  parentCompressions?: readonly CompressionParentKindEntry[] | null;
  parentKind?: string | null;
  sourceFileName?: string;
}): CompressionFormat =>
  getCompressionFormatForParentCompressions(parentCompressions) ||
  getCompressionFormatForParentKind(parentKind) ||
  getCompressionFormatForFileExtension(getSourceFileExtension(sourceFileName)) ||
  fallback;

export type {
  ByteProbeableSource,
  CompressionFormatRegistration,
  DiscCompressionFormat,
  DiscCompressionFormatRegistration,
};
export {
  COMPRESSION_FORMAT_REGISTRATIONS,
  COMPRESSION_FORMAT_REGISTRY,
  COMPRESSION_FORMATS,
  DISC_COMPRESSION_FORMAT_REGISTRATIONS,
  DISC_COMPRESSION_FORMAT_REGISTRY,
  getCompressionFormatForFileExtension,
  getCompressionFormatForParentCompressions,
  getCompressionFormatForParentKind,
  getCompressionFormatRegistration,
  getCompressionOutputExtension,
  getDiscCompressionFormatRegistration,
  getDiscExtractedFileName,
  getFileExtension,
  hasDiscCompressionFormatExtension,
  isCompressionFormat,
  isDiscCompressionFormat,
  normalizeDiscExtractedFileName,
  resolveAutomaticCompressionFormat,
};
