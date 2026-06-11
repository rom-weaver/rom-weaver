/*
 * OutputCompressionManager.js
 * Shared compressed output settings for RomWeaver.
 */

import {
  getSourceExtension,
  getSourceFileName,
  replaceFileExtension,
} from "../../storage/shared/binary/source-file-utils.ts";
import {
  type ROM_WEAVER_COMPRESSION_METADATA,
  ROM_WEAVER_CREATE_CONTAINER_FORMATS,
} from "../../wasm/generated/rom-weaver-format-metadata.ts";
import { parseCompressionCodecEntry } from "./codec-parser.ts";
import {
  COMPRESSION_DEFAULTS,
  COMPRESSION_PROFILE_NAMES,
  COMPRESSION_PROFILE_LEVELS as GENERATED_COMPRESSION_PROFILE_LEVELS,
  type GeneratedCompressionProfile,
  getGeneratedCompressionCodecFieldCodecs,
  getGeneratedCompressionCodecLevelMax,
  getGeneratedCompressionCodecLevelMin,
  getGeneratedCompressionCodecProfileKind,
  getGeneratedCompressionProfileLevel,
  normalizeGeneratedCompressionProfile,
} from "./compression-metadata.ts";
import {
  getChdCodecLevelMax,
  getDefaultThreadCount,
  isValidChdCodecLevel,
  normalizeCodecList,
  normalizeThreadCount,
  parseIntegerInRange,
} from "./compression-option-utils.ts";
import {
  CHD_COMPRESSION_INPUT_EXTENSIONS,
  CHD_DECOMPRESSION_INPUT_EXTENSIONS,
  hasRomSpecificExtension,
  hasUnambiguousRomSpecificCompressionInputExtension,
  ROM_SPECIFIC_COMPRESSION_INPUT_EXTENSIONS,
  ROM_SPECIFIC_INPUT_EXTENSIONS,
  RVZ_COMPRESSION_INPUT_EXTENSIONS,
  RVZ_DECOMPRESSION_INPUT_EXTENSIONS,
  Z3DS_COMPRESSION_INPUT_EXTENSIONS,
  Z3DS_DECOMPRESSION_INPUT_EXTENSIONS,
} from "./rom-specific-format-support.ts";

type OutputCompressionValue = "auto" | (typeof ROM_WEAVER_CREATE_CONTAINER_FORMATS)[number] | "none";
type CompressionProfile = GeneratedCompressionProfile;
type ArchiveCodec =
  | (typeof ROM_WEAVER_COMPRESSION_METADATA)["codecFields"]["zipCodec"]["codecs"][number]
  | (typeof ROM_WEAVER_COMPRESSION_METADATA)["codecFields"]["sevenZipCodec"]["codecs"][number];
type Z3dsUnderlyingMagic = "CIA\u0000" | "NCSD" | "NCCH" | "3DSX";
type CompressionSourceInput =
  | CompressionSource
  | string
  | ArrayBufferLike
  | ArrayBufferView
  | FileSystemHandle
  | null
  | undefined;
type CompressionChoiceInput = OutputCompressionValue | string | number | boolean | null | undefined;
type CompressionLevelInput = string | number | null | undefined;
type CodecChoiceInput = ArchiveCodec | string | null | undefined;
type CompressionProfileInput = CompressionProfile | string | number | boolean | null | undefined;
type ThreadCountInput = string | number | boolean | null | undefined;
type ChdCodecInput = string | string[] | number | null | undefined;
type NavigatorConcurrencyInput = { hardwareConcurrency?: number } | null | undefined;

type CompressionSource = {
  fileName?: string;
  name?: string;
  size?: number;
  _archiveEntryName?: string;
  _chdSourceFileName?: string;
  _rvzSourceFileName?: string;
  _z3dsSourceFileName?: string;
  _chdCueText?: string;
  _chdCuePath?: string;
  _chdMode?: "cd" | "dvd" | string;
  _rvzMode?: "iso" | "rvz" | string;
  _z3dsUnderlyingMagic?: Z3dsUnderlyingMagic | string;
};

type OutputCompressionOptions = {
  compressionFormat?: OutputCompressionValue | string;
  sevenZipCodec?: ArchiveCodec | string;
  sevenZipLevel?: number | string | null;
  zipCodec?: ArchiveCodec | string;
  zipLevel?: number | string | null;
  compressionProfile?: CompressionProfile | string | number | boolean | null;
  threads?: string | number | boolean | null | undefined;
  chdCreateCdCodecs?: string | string[] | number | null;
  chdCreateDvdCodecs?: string | string[] | number | null;
};

type OutputCompressionManagerApi = {
  OUTPUT_COMPRESSION: Record<string, OutputCompressionValue>;
  ROM_SPECIFIC_INPUT_EXTENSIONS: string[];
  getFileName: (source: CompressionSourceInput) => string;
  getExtension: (source: CompressionSourceInput) => string;
  replaceExtension: (fileName: string, extension: string | number | boolean | null | undefined) => string;
  normalizeOutputCompression: (value: CompressionChoiceInput) => OutputCompressionValue;
  resolveOutputCompression: (
    source: CompressionSourceInput,
    options?: OutputCompressionOptions,
  ) => OutputCompressionValue;
  supportsOutputCompression: (source: CompressionSourceInput, compression: CompressionChoiceInput) => boolean;
  isRomSpecificInput: (source: CompressionSourceInput) => boolean;
  isRawDiscInput: (source: CompressionSourceInput) => boolean;
  isChdSource: (source: CompressionSourceInput) => boolean;
  isRvzSource: (source: CompressionSourceInput) => boolean;
  isZ3dsSource: (source: CompressionSourceInput) => boolean;
  getCompressedFileName: (
    source: CompressionSourceInput,
    compression: CompressionChoiceInput,
    options?: OutputCompressionOptions,
  ) => string;
  normalizeCompressionLevel: (value: CompressionLevelInput, fallback?: number) => number;
  getArchiveFormat: (compression: CompressionChoiceInput) => string;
  getArchiveCodec: (compression: CompressionChoiceInput, options?: OutputCompressionOptions) => string | null;
  getArchiveOutputExtension: (compression: CompressionChoiceInput, options?: OutputCompressionOptions) => string;
  getArchiveWriterOptions: (compression: CompressionChoiceInput, options?: OutputCompressionOptions) => string;
  normalizeZstdCompressionLevel: (value: CompressionLevelInput, fallback?: number) => number;
  normalizeArchiveCompressionLevel: (
    codec: CodecChoiceInput,
    value: CompressionLevelInput,
    fallback?: number,
  ) => number;
  normalizeArchiveCompressionLevelForFormat: (
    compression: CompressionChoiceInput,
    codec: CodecChoiceInput,
    value: CompressionLevelInput,
    fallback?: number,
  ) => number;
  normalizeCompressionProfile: (
    value: CompressionProfileInput,
    fallback?: CompressionProfile | string,
  ) => CompressionProfile;
  getCompressionProfileLevel: (
    profile: CompressionProfileInput,
    codec: CodecChoiceInput,
    compression?: CompressionChoiceInput,
  ) => number;
  COMPRESSION_PROFILES: CompressionProfile[];
  COMPRESSION_PROFILE_LEVELS: Record<string, Record<CompressionProfile, number>>;
  normalizeThreadCount: (value: ThreadCountInput, fallback?: number) => number | null;
  getDefaultThreadCount: (navigatorObject?: NavigatorConcurrencyInput) => number;
  normalizeChdCodecs: (codecs: ChdCodecInput) => string;
  getChdCodecsForMode: (mode: "cd" | "dvd" | string | null | undefined, options?: OutputCompressionOptions) => string;
  normalizeSevenZipCodec: (value: CodecChoiceInput, fallback?: string) => string;
  normalizeZipCodec: (value: CodecChoiceInput, fallback?: string) => string;
  SEVEN_ZIP_COMPRESSION_METHODS: string[];
  ZIP_COMPRESSION_METHODS: string[];
  RVZ_COMPRESSION_METHODS: string[];
  normalizeRvzCompression: (compression: CodecChoiceInput) => string;
  normalizeRvzCompressionLevel: (value: CompressionLevelInput, fallback?: number) => number;
  normalizeRvzBlockSize: (value: CompressionLevelInput, fallback?: number) => number;
};

const OutputCompressionManager = (() => {
  const OUTPUT_COMPRESSION = {
    AUTO: "auto",
    CHD: "chd",
    NONE: "none",
    RVZ: "rvz",
    SEVEN_ZIP: "7z",
    Z3DS: "z3ds",
    ZIP: "zip",
  } satisfies Record<string, OutputCompressionValue>;
  const OUTPUT_COMPRESSION_VALUES = new Set<string>([
    OUTPUT_COMPRESSION.AUTO,
    ...ROM_WEAVER_CREATE_CONTAINER_FORMATS,
    OUTPUT_COMPRESSION.NONE,
  ]);
  const RAW_DISC_INPUT_EXTENSIONS = ROM_SPECIFIC_COMPRESSION_INPUT_EXTENSIONS;
  const ARCHIVE_FORMATS: Partial<Record<OutputCompressionValue, string>> = {
    "7z": "7zip",
    zip: "zip",
  };
  const SEVEN_ZIP_COMPRESSION_METHODS = getGeneratedCompressionCodecFieldCodecs("sevenZipCodec");
  const ZIP_COMPRESSION_METHODS = getGeneratedCompressionCodecFieldCodecs("zipCodec");
  const RVZ_COMPRESSION_METHODS = getGeneratedCompressionCodecFieldCodecs("rvzCodec");
  const COMPRESSION_PROFILES = [...COMPRESSION_PROFILE_NAMES];
  const COMPRESSION_PROFILE_LEVELS = GENERATED_COMPRESSION_PROFILE_LEVELS;

  const _getFileName = (source: Parameters<typeof getSourceFileName>[0]) =>
    getSourceFileName(source, {
      allowString: true,
      keys: [
        "fileName",
        "name",
        "_archiveEntryName",
        "_chdSourceFileName",
        "_rvzSourceFileName",
        "_z3dsSourceFileName",
      ],
    });

  const _getExtension = (source: Parameters<typeof getSourceExtension>[0]) =>
    getSourceExtension(source, _getFileName, { stripQuery: true });

  const _replaceExtension = replaceFileExtension;

  const _normalizeOutputCompression = (value: CompressionChoiceInput): OutputCompressionValue => {
    const normalized = String(value || OUTPUT_COMPRESSION.AUTO).toLowerCase();
    if (OUTPUT_COMPRESSION_VALUES.has(normalized)) return normalized as OutputCompressionValue;
    throw new Error(`Unsupported output compression: ${value}`);
  };

  const _isRomSpecificInput = (source: CompressionSource | null | undefined) => {
    if (
      source &&
      (source._chdSourceFileName ||
        source._chdCuePath ||
        source._chdCueText ||
        source._chdMode === "cd" ||
        source._chdMode === "dvd" ||
        source._rvzSourceFileName ||
        source._z3dsSourceFileName)
    )
      return true;
    return hasRomSpecificExtension(ROM_SPECIFIC_INPUT_EXTENSIONS, _getExtension(source));
  };
  const _isRawDiscInput = (source: CompressionSourceInput) =>
    hasRomSpecificExtension(RAW_DISC_INPUT_EXTENSIONS, _getExtension(source));
  const _hasChdSourceMetadata = (source: CompressionSource | null | undefined) =>
    !!(
      source &&
      (source._chdSourceFileName ||
        source._chdCuePath ||
        source._chdCueText ||
        source._chdMode === "cd" ||
        source._chdMode === "dvd")
    );
  const _hasRvzSourceMetadata = (source: CompressionSource | null | undefined) => !!source?._rvzSourceFileName;
  const _hasZ3dsSourceMetadata = (source: CompressionSource | null | undefined) => !!source?._z3dsSourceFileName;
  const _isChdSource = (source: CompressionSource | null | undefined) =>
    hasRomSpecificExtension(CHD_DECOMPRESSION_INPUT_EXTENSIONS, _getExtension(source)) || _hasChdSourceMetadata(source);
  const _isRvzSource = (source: CompressionSource | null | undefined) =>
    hasRomSpecificExtension(RVZ_DECOMPRESSION_INPUT_EXTENSIONS, _getExtension(source)) || _hasRvzSourceMetadata(source);
  const _isZ3dsSource = (source: CompressionSource | null | undefined) =>
    hasRomSpecificExtension(Z3DS_DECOMPRESSION_INPUT_EXTENSIONS, _getExtension(source)) ||
    _hasZ3dsSourceMetadata(source);
  const _isChdCompressionInput = (source: CompressionSource | null | undefined) =>
    hasRomSpecificExtension(CHD_COMPRESSION_INPUT_EXTENSIONS, _getExtension(source));
  const _isRvzCompressionInput = (source: CompressionSource | null | undefined) =>
    hasRomSpecificExtension(RVZ_COMPRESSION_INPUT_EXTENSIONS, _getExtension(source));
  const _isZ3dsCompressionInput = (source: CompressionSource | null | undefined) =>
    hasRomSpecificExtension(Z3DS_COMPRESSION_INPUT_EXTENSIONS, _getExtension(source));
  const _isUnambiguousChdCompressionInput = (source: CompressionSource | null | undefined) =>
    hasUnambiguousRomSpecificCompressionInputExtension(CHD_COMPRESSION_INPUT_EXTENSIONS, _getExtension(source));
  const _isUnambiguousRvzCompressionInput = (source: CompressionSource | null | undefined) =>
    hasUnambiguousRomSpecificCompressionInputExtension(RVZ_COMPRESSION_INPUT_EXTENSIONS, _getExtension(source));
  const _isUnambiguousZ3dsCompressionInput = (source: CompressionSource | null | undefined) =>
    hasUnambiguousRomSpecificCompressionInputExtension(Z3DS_COMPRESSION_INPUT_EXTENSIONS, _getExtension(source));
  // `.bin` doubles as bare console dumps (Genesis etc.), so extension alone
  // can't justify a CHD default. CD sectors are 2352 bytes raw / 2048 cooked;
  // a .bin with a known size that isn't sector-aligned is not a disc image.
  // Unknown sizes keep the extension-based resolution.
  const _isLikelyDiscImageSource = (source: CompressionSource | null | undefined) => {
    const extension = String(_getExtension(source) ?? "").toLowerCase();
    if (extension !== "bin") return true;
    const size = typeof source?.size === "number" && Number.isFinite(source.size) ? source.size : null;
    if (size === null || size <= 0) return true;
    return size % 2352 === 0 || size % 2048 === 0;
  };
  const _resolveOutputCompression = (
    source: CompressionSource | null | undefined,
    options?: OutputCompressionOptions,
  ) => {
    options = options || {};
    const selected = _normalizeOutputCompression(options.compressionFormat);
    if (selected !== OUTPUT_COMPRESSION.AUTO) return selected;
    if (_hasChdSourceMetadata(source)) return OUTPUT_COMPRESSION.CHD;
    if (_hasRvzSourceMetadata(source)) return OUTPUT_COMPRESSION.RVZ;
    if (_hasZ3dsSourceMetadata(source)) return OUTPUT_COMPRESSION.Z3DS;
    if (_isUnambiguousZ3dsCompressionInput(source)) return OUTPUT_COMPRESSION.Z3DS;
    if (_isZ3dsSource(source)) return OUTPUT_COMPRESSION.Z3DS;
    if (_isUnambiguousChdCompressionInput(source) && _isLikelyDiscImageSource(source)) return OUTPUT_COMPRESSION.CHD;
    if (_isChdSource(source) && _isLikelyDiscImageSource(source)) return OUTPUT_COMPRESSION.CHD;
    if (_isUnambiguousRvzCompressionInput(source)) return OUTPUT_COMPRESSION.RVZ;
    if (_isRvzSource(source)) return OUTPUT_COMPRESSION.RVZ;
    return OUTPUT_COMPRESSION.SEVEN_ZIP;
  };
  const _supportsOutputCompression = (source: CompressionSourceInput, compression: CompressionChoiceInput) => {
    const selected = _normalizeOutputCompression(compression);
    if (
      selected === OUTPUT_COMPRESSION.AUTO ||
      selected === OUTPUT_COMPRESSION.NONE ||
      selected === OUTPUT_COMPRESSION.SEVEN_ZIP ||
      selected === OUTPUT_COMPRESSION.ZIP
    )
      return true;
    if (selected === OUTPUT_COMPRESSION.CHD)
      return (
        _isChdCompressionInput(source as CompressionSource | null | undefined) ||
        _isChdSource(source as CompressionSource | null | undefined)
      );
    if (selected === OUTPUT_COMPRESSION.RVZ)
      return (
        _isRvzCompressionInput(source as CompressionSource | null | undefined) ||
        _isRvzSource(source as CompressionSource | null | undefined)
      );
    if (selected === OUTPUT_COMPRESSION.Z3DS)
      return (
        _isZ3dsCompressionInput(source as CompressionSource | null | undefined) ||
        _isZ3dsSource(source as CompressionSource | null | undefined)
      );
    return false;
  };

  const _normalizeIntegerOption = (
    value: string | number | null | undefined,
    options: { defaultValue: number; fallback?: number; label: string; max: number; min?: number },
  ) => {
    const parsed = parseIntegerInRange(value, {
      allowEmpty: true,
      failureMessage: `Unsupported ${options.label}: ${value}`,
      max: options.max,
      min: options.min ?? 0,
      requireExactString: true,
    });
    if (parsed !== null) return parsed;
    return options.fallback === undefined ? options.defaultValue : options.fallback;
  };

  const _normalizeCompressionLevel = (value: string | number | null | undefined, fallback?: number) =>
    _normalizeIntegerOption(value, {
      defaultValue: COMPRESSION_PROFILE_LEVELS.standard.max,
      fallback,
      label: "compression level",
      max: getGeneratedCompressionCodecLevelMax("deflate") ?? COMPRESSION_PROFILE_LEVELS.standard.max,
    });

  const _normalizeZstdCompressionLevel = (value: string | number | null | undefined, fallback?: number) =>
    _normalizeIntegerOption(value, {
      defaultValue: COMPRESSION_PROFILE_LEVELS.zstd.max,
      fallback,
      label: "zstd compression level",
      max: getGeneratedCompressionCodecLevelMax("zstd") ?? COMPRESSION_PROFILE_LEVELS.zstd.max,
      min: getGeneratedCompressionCodecLevelMin("zstd") ?? COMPRESSION_PROFILE_LEVELS.zstd.min,
    });
  const _normalizeArchiveCompressionLevel = (
    codec: string | null | undefined,
    value: string | number | null | undefined,
    fallback?: number,
  ) =>
    getGeneratedCompressionCodecProfileKind(codec) === "zstd"
      ? _normalizeZstdCompressionLevel(value, fallback)
      : _normalizeCompressionLevel(value, fallback);
  const _normalizeArchiveCompressionLevelForFormat = (
    compression: string | null | undefined,
    codec: string | null | undefined,
    value: string | number | null | undefined,
    fallback?: number,
  ) => {
    const selected = _normalizeOutputCompression(compression);
    if (selected === OUTPUT_COMPRESSION.ZIP) return _normalizeArchiveCompressionLevel(codec, value, fallback);
    return _normalizeArchiveCompressionLevel(codec, value, fallback);
  };
  const _normalizeCompressionProfile = (
    value: CompressionProfileInput,
    fallback?: CompressionProfile | string,
  ): CompressionProfile => normalizeGeneratedCompressionProfile(value, fallback);
  const _getCompressionProfileLevel = (
    profile: CompressionProfileInput,
    codec: CodecChoiceInput,
    _compression?: CompressionChoiceInput,
  ) => {
    const normalizedProfile = _normalizeCompressionProfile(profile, "max");
    return getGeneratedCompressionProfileLevel(normalizedProfile, codec);
  };
  const _normalizeArchiveCodec = (value: CodecChoiceInput, validCodecs: string[], fallback: string, label: string) => {
    const normalized = String(value || fallback || "")
      .trim()
      .toLowerCase();
    if (validCodecs.indexOf(normalized) !== -1) return normalized;
    throw new Error(`Unsupported ${label || "archive"} codec: ${value}`);
  };

  const _getArchiveFormat = (compression: CompressionChoiceInput) => {
    const selected = _normalizeOutputCompression(compression);
    const archiveFormat = ARCHIVE_FORMATS[selected];
    if (!archiveFormat) throw new Error(`Unsupported archive output compression: ${compression}`);
    return archiveFormat;
  };
  const _getArchiveCodec = (compression: CompressionChoiceInput, options?: OutputCompressionOptions): string | null => {
    options = options || {};
    const selected = _normalizeOutputCompression(compression);
    if (selected === OUTPUT_COMPRESSION.SEVEN_ZIP)
      return _normalizeArchiveCodec(
        options.sevenZipCodec,
        SEVEN_ZIP_COMPRESSION_METHODS,
        COMPRESSION_DEFAULTS.sevenZipCodec,
        "7z",
      );
    if (selected === OUTPUT_COMPRESSION.ZIP)
      return _normalizeArchiveCodec(options.zipCodec, ZIP_COMPRESSION_METHODS, COMPRESSION_DEFAULTS.zipCodec, "ZIP");
    return null;
  };
  const _getArchiveThreadsOption = (options?: OutputCompressionOptions) =>
    normalizeThreadCount(options?.threads, { fallback: null });
  const _getArchiveOutputExtension = (compression: CompressionChoiceInput, _options?: OutputCompressionOptions) => {
    const selected = _normalizeOutputCompression(compression);
    return selected;
  };
  const _appendFileExtension = (fileName: string, extension: string | number | boolean | null | undefined): string => {
    const normalizedExtension = String(extension || "").replace(/^\./, "");
    if (!normalizedExtension) return fileName;
    return `${fileName}.${normalizedExtension}`;
  };
  const _getZ3dsOutputExtension = (source: CompressionSource | null | undefined) => {
    const extension = _getExtension(source);
    if (extension === "cia" || extension === "zcia") return "zcia";
    if (extension === "3ds" || extension === "z3ds") return "z3ds";
    if (extension === "cci" || extension === "zcci") return "zcci";
    if (extension === "cxi" || extension === "app" || extension === "zcxi") return "zcxi";
    if (extension === "3dsx" || extension === "z3dsx") return "z3dsx";
    if (source?._z3dsUnderlyingMagic === "CIA\u0000") return "zcia";
    if (source?._z3dsUnderlyingMagic === "NCSD") return "zcci";
    if (source?._z3dsUnderlyingMagic === "NCCH") return "zcxi";
    if (source?._z3dsUnderlyingMagic === "3DSX") return "z3dsx";
    throw new Error(`Unsupported Z3DS source extension: ${extension || "(missing)"}`);
  };

  const _getArchiveLevelOption = (compression: CompressionChoiceInput, options?: OutputCompressionOptions) => {
    options = options || {};
    const selected = _normalizeOutputCompression(compression);
    if (selected === OUTPUT_COMPRESSION.SEVEN_ZIP) {
      const codec = _getArchiveCodec(compression, options);
      return _normalizeArchiveCompressionLevelForFormat(
        selected,
        codec,
        options.sevenZipLevel,
        _getCompressionProfileLevel(options.compressionProfile, codec, selected),
      );
    }
    if (selected === OUTPUT_COMPRESSION.ZIP) {
      const codec = _getArchiveCodec(compression, options);
      if (codec === "store") return null;
      const level = _normalizeArchiveCompressionLevelForFormat(
        selected,
        codec,
        options.zipLevel,
        _getCompressionProfileLevel(options.compressionProfile, codec, selected),
      );
      return level;
    }
    return null;
  };

  const _getArchiveWriterOptions = (compression: CompressionChoiceInput, options?: OutputCompressionOptions) => {
    const selected = _normalizeOutputCompression(compression);
    const codec = _getArchiveCodec(compression, options);
    const level = _getArchiveLevelOption(compression, options);
    const threads = _getArchiveThreadsOption(options);
    if (selected === OUTPUT_COMPRESSION.SEVEN_ZIP)
      return threads === null
        ? `compression=${codec},compression-level=${level}`
        : `compression=${codec},compression-level=${level},threads=${threads}`;
    if (selected === OUTPUT_COMPRESSION.ZIP) {
      if (codec === "store") return threads === null ? "compression=store" : `compression=store,threads=${threads}`;
      return threads === null
        ? `compression=${codec},compression-level=${level}`
        : `compression=${codec},compression-level=${level},threads=${threads}`;
    }
    return "";
  };

  const _normalizeThreadCount = (value: string | number | boolean | null | undefined, fallback?: number) =>
    normalizeThreadCount(value, {
      failureMessage: `Unsupported thread count: ${value === undefined || value === null || value === "" || value === "auto" ? (fallback ?? 4) : value}`,
      fallback: fallback ?? 4,
      requireExactString: true,
    });

  const _getDefaultThreadCount = (navigatorObject?: { hardwareConcurrency?: number } | null) =>
    getDefaultThreadCount({ navigator: navigatorObject || undefined });

  const _normalizeChdCodecs = (codecs: string | string[] | number | null | undefined) =>
    normalizeCodecList(codecs, {
      allowLevels: true,
      getLevelErrorMessage: (codec, level) => `Unsupported CHD codec level: ${codec}:${level}`,
      isValidLevel: isValidChdCodecLevel,
      label: "CHD codec",
    });

  const _normalizeRvzCompression = (compression: CodecChoiceInput) => {
    const normalized = String(compression || COMPRESSION_DEFAULTS.rvzCodec)
      .trim()
      .toLowerCase();
    if (RVZ_COMPRESSION_METHODS.indexOf(normalized) !== -1) return normalized;
    throw new Error(`Unsupported RVZ compression: ${compression}`);
  };

  const _normalizeRvzCompressionLevel = (value: string | number | null | undefined, fallback?: number) =>
    _normalizeIntegerOption(value, {
      defaultValue: COMPRESSION_DEFAULTS.rvzCompressionLevel,
      fallback,
      label: "RVZ compression level",
      max: getGeneratedCompressionCodecLevelMax(COMPRESSION_DEFAULTS.rvzCodec) ?? COMPRESSION_PROFILE_LEVELS.zstd.max,
      min: getGeneratedCompressionCodecLevelMin(COMPRESSION_DEFAULTS.rvzCodec) ?? COMPRESSION_PROFILE_LEVELS.zstd.min,
    });

  const _normalizeRvzBlockSize = (value: string | number | null | undefined, fallback?: number) =>
    _normalizeIntegerOption(value, {
      defaultValue: COMPRESSION_DEFAULTS.rvzBlockSize,
      fallback,
      label: "RVZ block size",
      max: Number.MAX_SAFE_INTEGER,
      min: 1,
    });
  const _materializeChdCodecLevels = (
    codecs: string | string[] | number | null | undefined,
    options?: OutputCompressionOptions,
  ) => {
    const normalizedCodecs = _normalizeChdCodecs(codecs);
    if (!normalizedCodecs) return "";

    const compressionProfile = _normalizeCompressionProfile(options?.compressionProfile, "max");
    return normalizedCodecs
      .split(",")
      .map((entry) => {
        const parsed = parseCompressionCodecEntry(entry);
        if (!parsed) return entry;

        const codec = parsed.codec;
        if (parsed.hasLevel) return entry;

        const maxLevel = getChdCodecLevelMax(codec);
        if (maxLevel === null) return codec;

        const profileLevel = _getCompressionProfileLevel(compressionProfile, codec, codec === "cdzs" ? "" : "");
        return `${codec}:${Math.max(0, Math.min(maxLevel, profileLevel))}`;
      })
      .join(",");
  };

  const _getChdCodecsForMode = (mode: "cd" | "dvd" | string | null | undefined, options?: OutputCompressionOptions) => {
    options = options || {};
    if (mode === "cd") return _materializeChdCodecLevels(options.chdCreateCdCodecs, options);
    if (mode === "dvd") return _materializeChdCodecLevels(options.chdCreateDvdCodecs, options);
    return "";
  };

  return {
    COMPRESSION_PROFILE_LEVELS: COMPRESSION_PROFILE_LEVELS,
    COMPRESSION_PROFILES: COMPRESSION_PROFILES,
    getArchiveCodec: _getArchiveCodec,
    getArchiveFormat: _getArchiveFormat,
    getArchiveOutputExtension: _getArchiveOutputExtension,
    getArchiveWriterOptions: _getArchiveWriterOptions,
    getChdCodecsForMode: _getChdCodecsForMode,
    getCompressedFileName: (
      source: CompressionSourceInput,
      compression: CompressionChoiceInput,
      options?: OutputCompressionOptions,
    ) => {
      const selected = _normalizeOutputCompression(compression);
      const fileName = _getFileName(source) || "patched.bin";
      if (selected === OUTPUT_COMPRESSION.NONE || selected === OUTPUT_COMPRESSION.AUTO) return fileName;
      if (selected === OUTPUT_COMPRESSION.Z3DS)
        return _replaceExtension(fileName, _getZ3dsOutputExtension(source as CompressionSource | null | undefined));
      if (selected === OUTPUT_COMPRESSION.SEVEN_ZIP || selected === OUTPUT_COMPRESSION.ZIP)
        return _appendFileExtension(fileName, _getArchiveOutputExtension(selected, options));
      return _replaceExtension(fileName, _getArchiveOutputExtension(selected, options));
    },
    getCompressionProfileLevel: _getCompressionProfileLevel,
    getDefaultThreadCount: _getDefaultThreadCount,
    getExtension: _getExtension,
    getFileName: _getFileName,
    isChdSource: _isChdSource,
    isRawDiscInput: _isRawDiscInput,
    isRomSpecificInput: _isRomSpecificInput,
    isRvzSource: _isRvzSource,
    isZ3dsSource: _isZ3dsSource,
    normalizeArchiveCompressionLevel: _normalizeArchiveCompressionLevel,
    normalizeArchiveCompressionLevelForFormat: _normalizeArchiveCompressionLevelForFormat,
    normalizeChdCodecs: _normalizeChdCodecs,
    normalizeCompressionLevel: _normalizeCompressionLevel,
    normalizeCompressionProfile: _normalizeCompressionProfile,
    normalizeOutputCompression: _normalizeOutputCompression,
    normalizeRvzBlockSize: _normalizeRvzBlockSize,
    normalizeRvzCompression: _normalizeRvzCompression,
    normalizeRvzCompressionLevel: _normalizeRvzCompressionLevel,
    normalizeSevenZipCodec: (value: CodecChoiceInput, fallback?: string) =>
      _normalizeArchiveCodec(
        value,
        SEVEN_ZIP_COMPRESSION_METHODS,
        fallback || COMPRESSION_DEFAULTS.sevenZipCodec,
        "7z",
      ),
    normalizeThreadCount: _normalizeThreadCount,
    normalizeZipCodec: (value: CodecChoiceInput, fallback?: string) =>
      _normalizeArchiveCodec(value, ZIP_COMPRESSION_METHODS, fallback || COMPRESSION_DEFAULTS.zipCodec, "ZIP"),
    normalizeZstdCompressionLevel: _normalizeZstdCompressionLevel,
    OUTPUT_COMPRESSION: OUTPUT_COMPRESSION,
    ROM_SPECIFIC_INPUT_EXTENSIONS: ROM_SPECIFIC_INPUT_EXTENSIONS,
    RVZ_COMPRESSION_METHODS: RVZ_COMPRESSION_METHODS,
    replaceExtension: _replaceExtension,
    resolveOutputCompression: _resolveOutputCompression,
    SEVEN_ZIP_COMPRESSION_METHODS: SEVEN_ZIP_COMPRESSION_METHODS,
    supportsOutputCompression: _supportsOutputCompression,
    ZIP_COMPRESSION_METHODS: ZIP_COMPRESSION_METHODS,
  };
})() as OutputCompressionManagerApi;

export default OutputCompressionManager;
