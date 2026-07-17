/*
 * OutputCompressionManager.js
 * Shared compressed output settings for RomWeaver.
 */

import {
  getChdCodecLevelMax,
  getDefaultThreadCount,
  isValidChdCodecLevel,
  normalizeCodecList,
  normalizeThreadCount,
  parseIntegerInRange,
} from "../../platform/shared/compression-options.ts";
import {
  getSourceExtension,
  getSourceFileName,
  replaceFileExtension,
} from "../../storage/shared/binary/source-file-utils.ts";
import type { SourceMetadata } from "../../types/workflow-source.ts";
import {
  type ROM_WEAVER_COMPRESSION_METADATA,
  ROM_WEAVER_CREATE_CONTAINER_FORMATS,
} from "../../wasm/generated/rom-weaver-format-metadata.ts";
import { chdModeFromMetadata } from "../input/rom-specific-file-utils.ts";
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
import { applyCompressionOutputFileName } from "./container-format-registry.ts";
import { isLikelyDiscImageSource } from "./disc-image-policy.ts";
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
import { z3dsCompressedExtensionForMagic, z3dsCompressedExtensionForSourceExtension } from "./z3ds-subtypes.ts";

type OutputCompressionValue = "auto" | (typeof ROM_WEAVER_CREATE_CONTAINER_FORMATS)[number] | "none";
type CompressionProfile = GeneratedCompressionProfile;
type ArchiveCodec =
  | (typeof ROM_WEAVER_COMPRESSION_METADATA)["codecFields"]["zipCodec"]["codecs"][number]
  | (typeof ROM_WEAVER_COMPRESSION_METADATA)["codecFields"]["sevenZipCodec"]["codecs"][number];
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
  metadata?: SourceMetadata;
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

  const _getFileName = (source: Parameters<typeof getSourceFileName>[0]) => {
    const direct = getSourceFileName(source, { allowString: true, keys: ["fileName", "name", "_archiveEntryName"] });
    if (direct) return direct;
    // The source-file-name precedence continues into the nested metadata bag, since
    // `getSourceFileName` only reads flat top-level keys.
    const meta = source && typeof source === "object" ? (source as { metadata?: SourceMetadata }).metadata : undefined;
    return meta?.sourceFileName ?? "";
  };

  const _getExtension = (source: Parameters<typeof getSourceExtension>[0]) =>
    getSourceExtension(source, _getFileName, { stripQuery: true });

  const _replaceExtension = replaceFileExtension;

  const _normalizeOutputCompression = (value: CompressionChoiceInput): OutputCompressionValue => {
    const normalized = String(value || OUTPUT_COMPRESSION.AUTO).toLowerCase();
    if (OUTPUT_COMPRESSION_VALUES.has(normalized)) return normalized as OutputCompressionValue;
    throw new Error(`Unsupported output compression: ${value}`);
  };

  const _isRomSpecificInput = (source: CompressionSource | null | undefined) => {
    if (source && (source.metadata?.sourceFileName || source.metadata?.cuePath || chdModeFromMetadata(source.metadata)))
      return true;
    return hasRomSpecificExtension(ROM_SPECIFIC_INPUT_EXTENSIONS, _getExtension(source));
  };
  const _isRawDiscInput = (source: CompressionSourceInput) =>
    hasRomSpecificExtension(RAW_DISC_INPUT_EXTENSIONS, _getExtension(source));
  // A unified `sourceFileName` can't tell chd from rvz from z3ds, so rvz/z3ds route on extension only;
  // chd keeps its disc-metadata signal (cue/mode), which no other format sets.
  const _hasChdSourceMetadata = (source: CompressionSource | null | undefined) =>
    !!(source && (source.metadata?.cuePath || chdModeFromMetadata(source.metadata)));
  const _isChdSource = (source: CompressionSource | null | undefined) =>
    hasRomSpecificExtension(CHD_DECOMPRESSION_INPUT_EXTENSIONS, _getExtension(source)) || _hasChdSourceMetadata(source);
  const _isRvzSource = (source: CompressionSource | null | undefined) =>
    hasRomSpecificExtension(RVZ_DECOMPRESSION_INPUT_EXTENSIONS, _getExtension(source));
  const _isZ3dsSource = (source: CompressionSource | null | undefined) =>
    hasRomSpecificExtension(Z3DS_DECOMPRESSION_INPUT_EXTENSIONS, _getExtension(source));
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
  // `.bin` doubles as bare console dumps (Genesis etc.), so extension alone can't justify a CHD
  // default. The ambiguous extensions and CD sector sizes come from the shared Rust-owned
  // disc-image policy via the single `isLikelyDiscImageSource` consumption point.
  const _isLikelyDiscImageSource = (source: CompressionSource | null | undefined) => {
    const size = typeof source?.size === "number" && Number.isFinite(source.size) ? source.size : null;
    return isLikelyDiscImageSource(_getExtension(source), size);
  };
  // Engine-recommended rom-specific container (chd/rvz/z3ds) from the ingest identity pass.
  // Content-detected in Rust (works on a bare `.iso`), so it is authoritative and wins over the
  // extension/size heuristics below; `null` when the engine surfaced no rom-specific format.
  const _engineRecommendedRomSpecific = (
    source: CompressionSource | null | undefined,
  ): OutputCompressionValue | null => {
    const recommended = String(source?.metadata?.recommendedFormat || "")
      .trim()
      .toLowerCase();
    if (recommended === OUTPUT_COMPRESSION.CHD) return OUTPUT_COMPRESSION.CHD;
    if (recommended === OUTPUT_COMPRESSION.RVZ) return OUTPUT_COMPRESSION.RVZ;
    if (recommended === OUTPUT_COMPRESSION.Z3DS) return OUTPUT_COMPRESSION.Z3DS;
    return null;
  };
  const _resolveOutputCompression = (
    source: CompressionSource | null | undefined,
    options?: OutputCompressionOptions,
  ) => {
    options = options || {};
    const selected = _normalizeOutputCompression(options.compressionFormat);
    if (selected !== OUTPUT_COMPRESSION.AUTO) return selected;
    // Engine content verdict first: a GameCube/Wii disc reports disc_format=DVD (which would otherwise
    // trip the CHD disc-metadata heuristic below), but Rust ingest correctly recommends rvz for it.
    const engineRecommended = _engineRecommendedRomSpecific(source);
    if (engineRecommended) return engineRecommended;
    if (_hasChdSourceMetadata(source)) return OUTPUT_COMPRESSION.CHD;
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
    // Honor the engine's content verdict first so "supported" agrees with what `_resolveOutputCompression`
    // auto-picks: a content-detected disc whose file name lacks a matching extension (a bare `.bin`
    // GameCube dump) is still a valid rvz/chd/z3ds target and must stay selectable in the dropdown.
    const engineRecommended = _engineRecommendedRomSpecific(source as CompressionSource | null | undefined);
    if (selected === OUTPUT_COMPRESSION.CHD)
      return (
        engineRecommended === OUTPUT_COMPRESSION.CHD ||
        _isChdCompressionInput(source as CompressionSource | null | undefined) ||
        _isChdSource(source as CompressionSource | null | undefined)
      );
    if (selected === OUTPUT_COMPRESSION.RVZ)
      return (
        engineRecommended === OUTPUT_COMPRESSION.RVZ ||
        _isRvzCompressionInput(source as CompressionSource | null | undefined) ||
        _isRvzSource(source as CompressionSource | null | undefined)
      );
    if (selected === OUTPUT_COMPRESSION.Z3DS)
      return (
        engineRecommended === OUTPUT_COMPRESSION.Z3DS ||
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
    _compression: string | null | undefined,
    codec: string | null | undefined,
    value: string | number | null | undefined,
    fallback?: number,
  ) => _normalizeArchiveCompressionLevel(codec, value, fallback);
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
  const _getZ3dsOutputExtension = (source: CompressionSource | null | undefined) => {
    const extension = _getExtension(source);
    return (
      z3dsCompressedExtensionForSourceExtension(extension) ??
      z3dsCompressedExtensionForMagic(source?.metadata?.underlyingMagic) ??
      (() => {
        throw new Error(`Unsupported Z3DS source extension: ${extension || "(missing)"}`);
      })()
    );
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
      // Z3DS picks its output extension from the source's payload subtype; every other container
      // uses the format name. The replace-vs-append decision (archives append a `.zip`/`.7z`
      // wrapper; disc images and z3ds replace the extension) is the Rust-owned per-format strategy,
      // applied by `applyCompressionOutputFileName` instead of being re-hardcoded here.
      const extension =
        selected === OUTPUT_COMPRESSION.Z3DS
          ? _getZ3dsOutputExtension(source as CompressionSource | null | undefined)
          : _getArchiveOutputExtension(selected, options);
      return applyCompressionOutputFileName(fileName, selected, extension);
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
