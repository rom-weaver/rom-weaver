import type { ApplySettings, CompressionFormat } from "../../types/settings.ts";
import type { RuntimeWorkerSourceScope } from "../../types/workflow-runtime-adapter.ts";
import {
  ROM_WEAVER_CONTAINER_FORMATS,
  ROM_WEAVER_CREATE_CONTAINER_FORMATS,
} from "../../wasm/generated/rom-weaver-format-metadata.ts";
import {
  getFileNameExtension,
  hasFileNameExtension,
  replaceFileNameExtension,
  stripLeadingExtensionDot,
} from "../path-utils.ts";
import { createRomSpecificExtensionRegex, hasRomSpecificExtension } from "./rom-specific-format-support.ts";

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

type ContainerCompressionFormat = Exclude<CompressionFormat, "none">;
type RomSpecificCompressionFormat = Extract<ContainerCompressionFormat, "chd" | "rvz" | "z3ds">;
type ArchiveCompressionFormat = Exclude<ContainerCompressionFormat, RomSpecificCompressionFormat>;
type RomSpecificRuntimeCreateMethod = "createChd" | "createRvz" | "createZ3ds";
type RomSpecificRuntimeExtractMethod = "extractChd" | "extractRvz" | "extractZ3ds";
type RomSpecificRuntimeListMethod = "listChd" | "listRvz" | "listZ3ds";
type RomSpecificRuntimeScope = Extract<RuntimeWorkerSourceScope, "chd" | "rvz" | "z3ds">;
type GeneratedContainerDefaultOutput = NonNullable<(typeof ROM_WEAVER_CONTAINER_FORMATS)[number]["defaultOutput"]>;

type CompressionFormatRegistrationBase<TFormat extends CompressionFormat> = {
  automaticParentKinds?: readonly string[];
  automaticSourceExtensions?: readonly string[];
  format: TFormat;
  label: string;
  outputExtension: (context: CompressionOutputExtensionContext) => string;
};

type ArchiveCompressionFormatRegistration = CompressionFormatRegistrationBase<ArchiveCompressionFormat>;

type NoneCompressionFormatRegistration = CompressionFormatRegistrationBase<"none">;

type RomSpecificCompressionFormatRegistration = CompressionFormatRegistrationBase<RomSpecificCompressionFormat> & {
  create: RomSpecificRuntimeCreateMethod;
  decompressionInputExtensions: readonly string[];
  extract: RomSpecificRuntimeExtractMethod;
  extractedFileName: (source: ByteProbeableSource) => string;
  extensionRegex: RegExp;
  fallbackFileName: string;
  list: RomSpecificRuntimeListMethod;
  magic: string;
  magicBytes: readonly number[];
  pathPrefix: {
    create: string;
    extract: string;
    sidecar?: string;
  };
  scope: RomSpecificRuntimeScope;
};

type RomSpecificRuntimeRegistration = {
  create: RomSpecificRuntimeCreateMethod;
  extract: RomSpecificRuntimeExtractMethod;
  extractedFileName: (source: ByteProbeableSource) => string;
  fallbackFileName: string;
  list: RomSpecificRuntimeListMethod;
  magic: string;
  pathPrefix: {
    create: string;
    extract: string;
    sidecar?: string;
  };
  scope: RomSpecificRuntimeScope;
};

type CompressionFormatRegistration =
  | ArchiveCompressionFormatRegistration
  | RomSpecificCompressionFormatRegistration
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

const normalizeRomSpecificExtractedFileName = (
  format: RomSpecificCompressionFormat,
  fileName: string | number | boolean | null | undefined,
  source: ByteProbeableSource,
): string => {
  if (format === "z3ds") return normalizeZ3dsExtractedFileName(fileName, source);
  return String(fileName || "").trim() || getRomSpecificExtractedFileName(format, source);
};

const getGeneratedDefaultOutputMetadata = <TFormat extends ContainerCompressionFormat>(
  format: TFormat,
): GeneratedContainerDefaultOutput & { format: TFormat } => {
  const metadata = ROM_WEAVER_CONTAINER_FORMATS.find((entry) => entry.name === format)?.defaultOutput;
  if (!metadata) throw new Error(`Generated container output metadata is missing for ${format}`);
  if (metadata.format !== format) {
    throw new Error(`Generated container output metadata for ${format} points to ${metadata.format}`);
  }
  return metadata as GeneratedContainerDefaultOutput & { format: TFormat };
};

const createOutputExtensionResolver = (metadata: GeneratedContainerDefaultOutput) => {
  if (metadata.outputExtensionStrategy === "z3ds-subtype") return getZ3dsOutputExtension;
  return () => metadata.outputExtension;
};

const createCompressionFormatRegistrationBase = <TFormat extends ContainerCompressionFormat>(
  format: TFormat,
): CompressionFormatRegistrationBase<TFormat> => {
  const metadata = getGeneratedDefaultOutputMetadata(format);
  return {
    automaticParentKinds: metadata.automaticParentKinds,
    automaticSourceExtensions: metadata.automaticSourceExtensions,
    format,
    label: metadata.label,
    outputExtension: createOutputExtensionResolver(metadata),
  };
};

const ROM_SPECIFIC_RUNTIME_REGISTRY = {
  chd: {
    create: "createChd",
    extract: "extractChd",
    extractedFileName: getChdExtractedFileName,
    fallbackFileName: "input.chd",
    list: "listChd",
    magic: "MComprHD",
    pathPrefix: {
      create: "chd-image",
      extract: "chd-input",
      sidecar: "chd-track",
    },
    scope: "chd",
  },
  rvz: {
    create: "createRvz",
    extract: "extractRvz",
    extractedFileName: getRvzExtractedFileName,
    fallbackFileName: "input.rvz",
    list: "listRvz",
    magic: "RVZ\u0000",
    pathPrefix: {
      create: "rvz-image",
      extract: "rvz-input",
    },
    scope: "rvz",
  },
  z3ds: {
    create: "createZ3ds",
    extract: "extractZ3ds",
    extractedFileName: getZ3dsExtractedFileName,
    fallbackFileName: "input.z3ds",
    list: "listZ3ds",
    magic: "Z3DS",
    pathPrefix: {
      create: "z3ds-image",
      extract: "z3ds-input",
    },
    scope: "z3ds",
  },
} satisfies Record<RomSpecificCompressionFormat, RomSpecificRuntimeRegistration>;

const isRomSpecificCompressionFormatName = (
  format: ContainerCompressionFormat,
): format is RomSpecificCompressionFormat => Object.hasOwn(ROM_SPECIFIC_RUNTIME_REGISTRY, format);

const isArchiveCompressionFormatName = (format: ContainerCompressionFormat): format is ArchiveCompressionFormat =>
  !isRomSpecificCompressionFormatName(format);

const createRomSpecificCompressionFormatRegistration = (
  format: RomSpecificCompressionFormat,
): RomSpecificCompressionFormatRegistration => {
  const metadata = getGeneratedDefaultOutputMetadata(format);
  const runtime = ROM_SPECIFIC_RUNTIME_REGISTRY[format];
  return {
    ...createCompressionFormatRegistrationBase(format),
    create: runtime.create,
    decompressionInputExtensions: metadata.decompressionInputExtensions,
    extensionRegex: createRomSpecificExtensionRegex(metadata.decompressionInputExtensions),
    extract: runtime.extract,
    extractedFileName: runtime.extractedFileName,
    fallbackFileName: runtime.fallbackFileName,
    list: runtime.list,
    magic: runtime.magic,
    magicBytes: createMagicBytes(runtime.magic),
    pathPrefix: runtime.pathPrefix,
    scope: runtime.scope,
  };
};

const createArchiveCompressionFormatRegistration = (
  format: ArchiveCompressionFormat,
): ArchiveCompressionFormatRegistration => createCompressionFormatRegistrationBase(format);

const createContainerCompressionFormatRegistration = (
  format: ContainerCompressionFormat,
): ArchiveCompressionFormatRegistration | RomSpecificCompressionFormatRegistration =>
  isRomSpecificCompressionFormatName(format)
    ? createRomSpecificCompressionFormatRegistration(format)
    : createArchiveCompressionFormatRegistration(format);

const GENERATED_COMPRESSION_FORMAT_REGISTRY = Object.fromEntries(
  ROM_WEAVER_CREATE_CONTAINER_FORMATS.map((format) => [format, createContainerCompressionFormatRegistration(format)]),
) as Record<
  ContainerCompressionFormat,
  ArchiveCompressionFormatRegistration | RomSpecificCompressionFormatRegistration
>;

const NONE_COMPRESSION_FORMAT_REGISTRATION: NoneCompressionFormatRegistration = {
  format: "none",
  label: "None",
  outputExtension: getOriginalOutputExtension,
};

const ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY = Object.fromEntries(
  (Object.keys(ROM_SPECIFIC_RUNTIME_REGISTRY) as RomSpecificCompressionFormat[]).map((format) => [
    format,
    createRomSpecificCompressionFormatRegistration(format),
  ]),
) as Record<RomSpecificCompressionFormat, RomSpecificCompressionFormatRegistration>;

const COMPRESSION_FORMAT_REGISTRY = {
  ...GENERATED_COMPRESSION_FORMAT_REGISTRY,
  none: NONE_COMPRESSION_FORMAT_REGISTRATION,
} satisfies Record<CompressionFormat, CompressionFormatRegistration>;

const COMPRESSION_FORMAT_REGISTRATIONS = Object.values(COMPRESSION_FORMAT_REGISTRY) as CompressionFormatRegistration[];
const ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRATIONS = Object.values(
  ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY,
) as RomSpecificCompressionFormatRegistration[];
const CREATE_CONTAINER_COMPRESSION_FORMATS = [...ROM_WEAVER_CREATE_CONTAINER_FORMATS] as ContainerCompressionFormat[];
const CREATE_ARCHIVE_COMPRESSION_FORMATS = CREATE_CONTAINER_COMPRESSION_FORMATS.filter(isArchiveCompressionFormatName);
const CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS = CREATE_CONTAINER_COMPRESSION_FORMATS.filter(
  isRomSpecificCompressionFormatName,
);
const OUTPUT_COMPRESSION_FORMATS = ["none", ...CREATE_CONTAINER_COMPRESSION_FORMATS] as CompressionFormat[];
const COMPRESSION_FORMATS = Object.keys(COMPRESSION_FORMAT_REGISTRY) as CompressionFormat[];

const isCompressionFormat = (value: unknown): value is CompressionFormat =>
  typeof value === "string" && Object.hasOwn(COMPRESSION_FORMAT_REGISTRY, value);

const isRomSpecificCompressionFormat = (value: unknown): value is RomSpecificCompressionFormat =>
  typeof value === "string" && Object.hasOwn(ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY, value);

const isArchiveCompressionFormat = (value: unknown): value is ArchiveCompressionFormat =>
  typeof value === "string" && CREATE_ARCHIVE_COMPRESSION_FORMATS.includes(value as ArchiveCompressionFormat);

const getCompressionFormatRegistration = (
  format: string | null | undefined,
): CompressionFormatRegistration | undefined =>
  isCompressionFormat(format) ? COMPRESSION_FORMAT_REGISTRY[format] : undefined;

const getRomSpecificCompressionFormatRegistration = (
  format: string | null | undefined,
): RomSpecificCompressionFormatRegistration | undefined =>
  isRomSpecificCompressionFormat(format) ? ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY[format] : undefined;

const getCompressionOutputExtension = (
  format: CompressionFormat,
  context: CompressionOutputExtensionContext = {},
): string => COMPRESSION_FORMAT_REGISTRY[format].outputExtension(context);

const getRomSpecificExtractedFileName = (format: RomSpecificCompressionFormat, source: ByteProbeableSource): string =>
  ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY[format].extractedFileName(source);

const hasRomSpecificCompressionFormatExtension = (
  format: RomSpecificCompressionFormat,
  extension: string | number | boolean | null | undefined,
): boolean =>
  hasRomSpecificExtension(ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY[format].decompressionInputExtensions, extension);

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

// `.bin` is ambiguous: CD images (bin/cue) should auto-resolve to chd, but
// bare console ROM dumps use the same extension. CD sectors are 2352 bytes
// raw or 2048 cooked, so a .bin whose size is not sector-aligned is not a
// disc image. An unknown size keeps the extension-based resolution.
const AMBIGUOUS_DISC_IMAGE_EXTENSIONS: readonly string[] = ["bin"];
const CD_SECTOR_SIZES: readonly number[] = [2352, 2048];

const isLikelyDiscImageSize = (size: number | null | undefined): boolean => {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return true;
  return CD_SECTOR_SIZES.some((sectorSize) => size % sectorSize === 0);
};

const resolveAutomaticCompressionFormat = ({
  fallback = "7z",
  parentCompressions,
  parentKind,
  sourceFileName,
  sourceSize,
}: {
  fallback?: CompressionFormat;
  parentCompressions?: readonly CompressionParentKindEntry[] | null;
  parentKind?: string | null;
  sourceFileName?: string;
  sourceSize?: number | null;
}): CompressionFormat => {
  const parentFormat =
    getCompressionFormatForParentCompressions(parentCompressions) || getCompressionFormatForParentKind(parentKind);
  if (parentFormat) return parentFormat;
  const extension = normalizeExtension(getSourceFileExtension(sourceFileName));
  const extensionFormat = getCompressionFormatForFileExtension(extension);
  if (!extensionFormat) return fallback;
  if (extension && AMBIGUOUS_DISC_IMAGE_EXTENSIONS.includes(extension) && !isLikelyDiscImageSize(sourceSize)) {
    return fallback;
  }
  return extensionFormat;
};

export type {
  ArchiveCompressionFormat,
  ByteProbeableSource,
  CompressionFormatRegistration,
  RomSpecificCompressionFormat,
  RomSpecificCompressionFormatRegistration,
};
export {
  COMPRESSION_FORMAT_REGISTRATIONS,
  COMPRESSION_FORMAT_REGISTRY,
  COMPRESSION_FORMATS,
  CREATE_ARCHIVE_COMPRESSION_FORMATS,
  CREATE_CONTAINER_COMPRESSION_FORMATS,
  CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS,
  getCompressionFormatForFileExtension,
  getCompressionFormatForParentCompressions,
  getCompressionFormatForParentKind,
  getCompressionFormatRegistration,
  getCompressionOutputExtension,
  getFileExtension,
  getRomSpecificCompressionFormatRegistration,
  getRomSpecificExtractedFileName,
  hasRomSpecificCompressionFormatExtension,
  isArchiveCompressionFormat,
  isCompressionFormat,
  isRomSpecificCompressionFormat,
  normalizeRomSpecificExtractedFileName,
  OUTPUT_COMPRESSION_FORMATS,
  ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRATIONS,
  ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY,
  resolveAutomaticCompressionFormat,
};
