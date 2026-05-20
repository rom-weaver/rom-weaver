const CODEC_WITH_OPTIONAL_LEVEL_REGEX = /^([a-z0-9_+-]+)(?::(\d+))?$/;
const CODEC_NAME_CAPTURE_REGEX = /^([a-z0-9_+-]+)$/;
const CODEC_NAME_REGEX = /^[a-z0-9_+-]+$/;
const INTEGER_STRING_REGEX = /^-?\d+$/;

type NavigatorRoot = {
  navigator?: {
    hardwareConcurrency?: number;
  };
  crossOriginIsolated?: boolean;
};

type ThreadCountInput = string | number | boolean | null | undefined;
type CodecLevelInput = string | string[] | number | null | undefined;
type IntegerInput = string | number | null | undefined;

type ThreadCountOptions = {
  allowOff?: boolean;
  failureMessage?: string;
  fallback?: number | null;
  label?: string;
  requireExactString?: boolean;
};

type IntegerRangeOptions = {
  allowEmpty?: boolean;
  failureMessage?: string;
  fallback?: number | "" | null;
  max: number;
  min: number;
  requireExactString?: boolean;
};

type CodecListOptions = {
  allowLevels?: boolean;
  failureMessage?: string;
  getErrorMessage?: (codec: string) => string;
  getLevelErrorMessage?: (codec: string, level: number) => string;
  isValidCodec?: (codec: string) => boolean;
  isValidLevel?: (codec: string, level: number) => boolean;
  label?: string;
};

const throwCodecError = (codec: string, options: CodecListOptions): never => {
  if (typeof options.getErrorMessage === "function") throw new Error(options.getErrorMessage(codec));
  throw new Error(options.failureMessage || `Unsupported ${options.label || "codec"}: ${codec}`);
};

const CHD_CODEC_LEVEL_MAX: Record<string, number> = {
  cdfl: 8,
  cdlz: 9,
  cdzl: 9,
  cdzs: 22,
  flac: 8,
  lzma: 9,
  zlib: 9,
  zstd: 22,
};

const canUseThreadedWasm = (root?: NavigatorRoot | null): boolean => {
  const runtimeRoot = root || (typeof globalThis === "undefined" ? null : (globalThis as NavigatorRoot));
  return typeof SharedArrayBuffer === "function" && runtimeRoot?.crossOriginIsolated === true;
};

const getHardwareConcurrency = (root?: NavigatorRoot | null): number => {
  const navigatorObject = root?.navigator
    ? root.navigator
    : (() => {
        if (typeof navigator === "undefined") {
          return null;
        }
        return navigator;
      })();
  const hardwareConcurrency = navigatorObject?.hardwareConcurrency;
  return typeof hardwareConcurrency === "number" && Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0
    ? Math.floor(hardwareConcurrency)
    : 4;
};

const getDefaultThreadCount = (root?: NavigatorRoot | null): number =>
  Math.max(1, Math.min(8, getHardwareConcurrency(root)));

const getDefaultBrowserThreadCount = (root?: NavigatorRoot | null): number =>
  canUseThreadedWasm(root) ? getDefaultThreadCount(root) : 1;

const normalizeThreadCount = (value: ThreadCountInput, options?: ThreadCountOptions): number | null => {
  options = options || {};
  if (value === undefined || value === null || value === "" || value === "auto") return options.fallback ?? null;
  if (options.allowOff && (value === false || value === 0 || value === "0" || value === "off")) return 0;

  const parsed = parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || (options.requireExactString && String(parsed) !== String(value).trim()))
    throw new Error(options.failureMessage || `Invalid ${options.label || "thread count"}: ${value}`);
  return Math.max(1, Math.min(64, parsed));
};

const normalizeCodecList = (codecs: CodecLevelInput, options?: CodecListOptions): string => {
  options = options || {};
  if (codecs === undefined || codecs === null || codecs === "") return "";

  const values = Array.isArray(codecs) ? codecs : String(codecs).split(",");
  const normalized = values
    .map((codec) =>
      String(codec || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);

  for (const item of normalized) {
    const codecValue = item || "";
    const match = options.allowLevels
      ? codecValue.match(CODEC_WITH_OPTIONAL_LEVEL_REGEX)
      : codecValue.match(CODEC_NAME_CAPTURE_REGEX);
    if (!match) throwCodecError(codecValue, options);

    const codec = match?.[1] || "";
    if (typeof options.isValidCodec === "function" && !options.isValidCodec(codec)) throwCodecError(codec, options);
    const levelText = match?.[2];
    if (levelText !== undefined) {
      const level = parseInt(levelText, 10);
      if (
        !Number.isFinite(level) ||
        (typeof options.isValidLevel === "function" && !options.isValidLevel(codec, level))
      ) {
        if (typeof options.getLevelErrorMessage === "function")
          throw new Error(options.getLevelErrorMessage(codec, level));
        throw new Error(options.failureMessage || `Unsupported ${options.label || "codec"} level: ${codecValue}`);
      }
    }

    if (!CODEC_NAME_REGEX.test(codec)) throwCodecError(codec, options);
  }
  return normalized.join(",");
};

const normalizeCodecListWithFallback = (
  codecs: CodecLevelInput,
  fallback: string,
  options?: CodecListOptions,
): string => {
  if (typeof codecs !== "string") return fallback;
  if (!codecs.trim()) return fallback;
  try {
    return normalizeCodecList(codecs, options);
  } catch {
    return fallback;
  }
};

const parseIntegerInRange = (value: IntegerInput, options: IntegerRangeOptions): number | null => {
  const raw = String(value ?? "").trim();
  if (!raw) {
    if (options.allowEmpty) return null;
    if (options.fallback !== undefined) return typeof options.fallback === "number" ? options.fallback : null;
    throw new Error(options.failureMessage || `Invalid value: ${value}`);
  }
  if (!INTEGER_STRING_REGEX.test(raw)) throw new Error(options.failureMessage || `Invalid value: ${value}`);
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(options.failureMessage || `Invalid value: ${value}`);
  if (options.requireExactString && String(parsed) !== raw)
    throw new Error(options.failureMessage || `Invalid value: ${value}`);
  if (parsed < options.min || parsed > options.max)
    throw new Error(options.failureMessage || `Invalid value: ${value}`);
  return parsed;
};

const normalizeIntegerInRange = (value: IntegerInput, options: IntegerRangeOptions): number | "" | null => {
  const raw = String(value ?? "").trim();
  if (!raw) {
    if (options.allowEmpty) return options.fallback === undefined ? null : options.fallback;
    return options.fallback === undefined ? null : options.fallback;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return options.fallback === undefined ? null : options.fallback;
  if (options.requireExactString && String(parsed) !== raw)
    return options.fallback === undefined ? null : options.fallback;
  return Math.max(options.min, Math.min(options.max, parsed));
};

const getChdCodecLevelMax = (codec: string | null | undefined): number | null => {
  const normalizedCodec = String(codec || "").toLowerCase();
  return CHD_CODEC_LEVEL_MAX[normalizedCodec] ?? null;
};

const isValidChdCodecLevel = (codec: string, level: number): boolean => {
  const maxLevel = getChdCodecLevelMax(codec);
  return maxLevel !== null && level >= 0 && level <= maxLevel;
};

const normalizeBrowserThreadCount = (
  value: ThreadCountInput,
  root?: NavigatorRoot | null,
  fallback = getDefaultBrowserThreadCount(root),
): number => {
  if (value === false || value === 0 || value === "0" || value === "off") return 0;
  if (!canUseThreadedWasm(root)) return 1;
  return (
    normalizeThreadCount(value, {
      allowOff: true,
      fallback,
    }) ?? fallback
  );
};

export {
  CHD_CODEC_LEVEL_MAX,
  canUseThreadedWasm,
  getChdCodecLevelMax,
  getDefaultBrowserThreadCount,
  getDefaultThreadCount,
  isValidChdCodecLevel,
  normalizeBrowserThreadCount,
  normalizeCodecList,
  normalizeCodecListWithFallback,
  normalizeIntegerInRange,
  normalizeThreadCount,
  parseIntegerInRange,
};
