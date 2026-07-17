import {
  type CompressionCodecOption,
  getCompressionCodecLevelMax,
  getCompressionCodecOptions,
  getCompressionCodecSuggestions,
  getCompressionCodecValues,
} from "../../lib/compression/codec-fields.ts";
import {
  COMPRESSION_DEFAULTS,
  COMPRESSION_PROFILE_LABELS,
  COMPRESSION_PROFILE_LEVELS,
  getGeneratedCompressionCodecFieldDefault,
  getGeneratedCompressionCodecLevelMax,
  getGeneratedCompressionCodecLevelMin,
} from "../../lib/compression/compression-metadata.ts";
import { getBrowserLocaleCandidates, negotiateLocale } from "../../presentation/localization/index.ts";
import { getSettingsLabel, getUiSettingsLabel } from "../../presentation/settings.ts";
import { LOG_LEVELS } from "../../types/logging.ts";
import { getDefaultWebappLogLevel } from "../development-defaults.ts";
import {
  COMPRESSION_PROFILES,
  canUseThreadedWasm,
  getCompressionProfileFromIndex,
  getCompressionProfileIndex,
  getCompressionProfileLabel,
  getDefaultBrowserThreadCount,
} from "./settings-compression.ts";

const LOCAL_STORAGE_SETTINGS_ID = "rom-weaver-settings";

type SettingsState = {
  defaultCompression: string;
  language: string;
  logLevel: string;
  bundlePackage: string;
  betaToolsEnabled: boolean;
  fixChecksum: boolean;
  requireInputChecksumMatch: boolean;
  compressionProfile: string;
  chdCreateCdCodecs: string;
  chdCreateDvdCodecs: string;
  rvzCodec: string;
  rvzCompressionLevel: number | "";
  rvzBlockSize: number;
  z3dsCompressionLevel: number | "";
  sevenZipCodec: string;
  sevenZipLevel: number | "";
  zipCodec: string;
  zipLevel: number | "";
  workerThreads: number | "auto";
};

type NumericDraftValue = number | "" | string;

type SettingsDraftState = Omit<
  SettingsState,
  "rvzCompressionLevel" | "rvzBlockSize" | "z3dsCompressionLevel" | "sevenZipLevel" | "zipLevel" | "workerThreads"
> & {
  rvzCompressionLevel: NumericDraftValue;
  rvzBlockSize: number | string;
  z3dsCompressionLevel: NumericDraftValue;
  sevenZipLevel: NumericDraftValue;
  zipLevel: NumericDraftValue;
  workerThreads: number | string;
};

type SettingsDraft = Partial<SettingsDraftState> & Record<string, unknown>;

type SettingsValidation = {
  messages: string[];
  invalidFields: string[];
  settings: SettingsState;
};

type StorageLike = (Pick<Storage, "getItem"> & Partial<Pick<Storage, "removeItem">>) | null;

type SettingsChoiceOption = {
  value: string;
  label: string;
};

type SettingsFieldKey = keyof SettingsState;
type SettingsFieldKind = "select" | "checkbox" | "choice-checkbox" | "text" | "number" | "range" | "hidden";

type SettingsUiState = {
  chdEnabled: boolean;
  rvzEnabled: boolean;
  sevenZipEnabled: boolean;
  zipEnabled: boolean;
  workerThreadsEnabled: boolean;
  compressionProfileLabel: string;
  compressionProfileIndex: number;
};

type SettingsFieldContext = {
  settings: SettingsDraftState;
  uiState: SettingsUiState;
};

type DynamicSettingsText = string | ((context: SettingsFieldContext) => string);
type DynamicSettingsNumber = number | ((context: SettingsFieldContext) => number);
type DynamicSettingsBoolean = boolean | ((context: SettingsFieldContext) => boolean);

type SettingsFieldMetadata<K extends SettingsFieldKey = SettingsFieldKey> = {
  key: K;
  id: string;
  kind: SettingsFieldKind;
  defaultValue: SettingsState[K] | (() => SettingsState[K]);
  label?: string;
  labelDataLocalize?: string;
  layout?: "default" | "large";
  validationLabel?: string;
  codecOptions?: CompressionCodecOption[];
  codecSuggestions?: CompressionCodecOption[];
  options?: SettingsChoiceOption[];
  validValues?: string[];
  placeholder?: DynamicSettingsText;
  suggestion?: DynamicSettingsText;
  suggestionDataLocalize?: DynamicSettingsText;
  min?: DynamicSettingsNumber;
  max?: DynamicSettingsNumber;
  step?: number;
  disabled?: DynamicSettingsBoolean;
  scaleLabels?: string[];
  checkedValue?: string;
  uncheckedValue?: string;
};

function normalizeChoiceSetting(value: unknown, validValues: readonly string[], fallback: string): string;
function normalizeChoiceSetting(value: unknown, validValues: readonly string[], fallback: null): string | null;
function normalizeChoiceSetting(
  value: unknown,
  validValues: readonly string[],
  fallback: string | null,
): string | null {
  const normalized = typeof value === "string" ? value.toLowerCase() : String(value);
  return validValues.indexOf(normalized) === -1 ? fallback : normalized;
}

function getDefaultWorkerThreads(): number {
  return getDefaultBrowserThreadCount(typeof globalThis === "undefined" ? undefined : globalThis);
}

function getDefaultLanguage(): string {
  const browserLanguage = negotiateLocale(getBrowserLocaleCandidates());
  const fullMatch = normalizeChoiceSetting(browserLanguage, SETTINGS_VALID_LANGUAGES, "");
  if (fullMatch) return fullMatch;
  return normalizeChoiceSetting(browserLanguage.slice(0, 2), SETTINGS_VALID_LANGUAGES, "en");
}

const SETTINGS_FIELD_ORDER = [
  "defaultCompression",
  "language",
  "logLevel",
  "betaToolsEnabled",
  "fixChecksum",
  "requireInputChecksumMatch",
  "bundlePackage",
  "compressionProfile",
  "chdCreateCdCodecs",
  "chdCreateDvdCodecs",
  "rvzCodec",
  "rvzCompressionLevel",
  "rvzBlockSize",
  "z3dsCompressionLevel",
  "sevenZipCodec",
  "sevenZipLevel",
  "zipCodec",
  "zipLevel",
  "workerThreads",
] as const satisfies readonly SettingsFieldKey[];

const SETTINGS_LEVEL_OVERRIDE_FIELDS = [
  "rvzCompressionLevel",
  "z3dsCompressionLevel",
  "sevenZipLevel",
  "zipLevel",
] as const satisfies readonly SettingsFieldKey[];
const SETTINGS_LEVEL_OVERRIDE_FIELD_SET = new Set<SettingsFieldKey>(SETTINGS_LEVEL_OVERRIDE_FIELDS);
const STANDARD_CODEC_MIN_LEVEL = COMPRESSION_PROFILE_LEVELS.standard.min;
const STANDARD_CODEC_MAX_LEVEL = COMPRESSION_PROFILE_LEVELS.standard.max;
const ZSTD_CODEC_MIN_LEVEL = COMPRESSION_PROFILE_LEVELS.zstd.min;
const ZSTD_CODEC_MAX_LEVEL = COMPRESSION_PROFILE_LEVELS.zstd.max;
const normalizeCodecName = (codec: string | null | undefined): string =>
  (String(codec || "").split(":")[0] || "").trim().toLowerCase();
const formatLevelRange = (min: number, max: number): string => `${min}..${max}`;
const getCodecMinLevel = (codec: string | null | undefined, fallback: number): number =>
  getGeneratedCompressionCodecLevelMin(normalizeCodecName(codec)) ?? fallback;
const getCodecMaxLevel = (codec: string | null | undefined, fallback: number): number =>
  getGeneratedCompressionCodecLevelMax(normalizeCodecName(codec)) ?? fallback;
const codecLevelRange = (
  codec: string | null | undefined,
  minFallback = STANDARD_CODEC_MIN_LEVEL,
  maxFallback = STANDARD_CODEC_MAX_LEVEL,
): string => formatLevelRange(getCodecMinLevel(codec, minFallback), getCodecMaxLevel(codec, maxFallback));
const codecValuesText = (fieldKey: string): string =>
  getCompressionCodecOptions(fieldKey)
    .map((option) => option.value)
    .join(", ");
const codecLevelRangeText = (fieldKey: string): string =>
  getCompressionCodecOptions(fieldKey)
    .map((option) =>
      option.maxLevel === null
        ? option.value
        : `${option.value}[:${formatLevelRange(option.minLevel ?? 0, option.maxLevel)}]`,
    )
    .join(", ");
const codecDefaultPlaceholderText = (fieldKey: string): string =>
  getGeneratedCompressionCodecFieldDefault(fieldKey)
    .split(",")
    .map((codec) => {
      const normalized = normalizeCodecName(codec);
      const maxLevel = getCompressionCodecLevelMax(fieldKey, normalized);
      return maxLevel === null ? normalized : `${normalized}:${maxLevel}`;
    })
    .filter(Boolean)
    .join(",");
const ZIP_ZSTD_CODEC =
  getCompressionCodecOptions("zipCodec").find((option) => option.value === "zstd")?.value ||
  COMPRESSION_DEFAULTS.zipCodec;

const SETTINGS_FIELD_METADATA: { [K in SettingsFieldKey]: SettingsFieldMetadata<K> } = {
  betaToolsEnabled: {
    defaultValue: false,
    id: "settings-beta-tools-enabled",
    key: "betaToolsEnabled",
    kind: "checkbox",
    label: getSettingsLabel("betaToolsEnabled"),
    labelDataLocalize: "Enable beta tools (Trim and Tools)",
    layout: "large",
  },
  bundlePackage: {
    defaultValue: "",
    id: "settings-bundle-package",
    key: "bundlePackage",
    kind: "select",
    label: "Bundle",
    options: [
      { label: "Hide bundle creation", value: "" },
      { label: "Bundle + patches (.zip)", value: "zip:patches" },
      { label: "Bundle + ROM + patches (.zip)", value: "zip:rom" },
      { label: "Bundle + patches (.7z)", value: "7z:patches" },
      { label: "Bundle + ROM + patches (.7z)", value: "7z:rom" },
    ],
    suggestion: "Choose a package to show bundle download by default when weaving a ROM hack.",
    validationLabel: "Bundle",
    validValues: ["", "zip:patches", "zip:rom", "7z:patches", "7z:rom"],
  },
  chdCreateCdCodecs: {
    codecOptions: getCompressionCodecOptions("chdCreateCdCodecs"),
    codecSuggestions: getCompressionCodecSuggestions("chdCreateCdCodecs"),
    defaultValue: COMPRESSION_DEFAULTS.chdCreateCdCodecs,
    disabled: ({ uiState }) => !uiState.chdEnabled,
    id: "settings-chd-createcd-codecs",
    key: "chdCreateCdCodecs",
    kind: "text",
    label: getUiSettingsLabel("chdCd"),
    labelDataLocalize: "CD Codecs",
    placeholder: codecDefaultPlaceholderText("chdCreateCdCodecs"),
    suggestion: `Valid values: ${codecValuesText("chdCreateCdCodecs")}. Optional levels: ${codecLevelRangeText("chdCreateCdCodecs")}`,
    suggestionDataLocalize: `Valid values: ${codecValuesText("chdCreateCdCodecs")}. Optional levels: ${codecLevelRangeText("chdCreateCdCodecs")}`,
    validationLabel: "CD Codecs",
  },
  chdCreateDvdCodecs: {
    codecOptions: getCompressionCodecOptions("chdCreateDvdCodecs"),
    codecSuggestions: getCompressionCodecSuggestions("chdCreateDvdCodecs"),
    defaultValue: COMPRESSION_DEFAULTS.chdCreateDvdCodecs,
    disabled: ({ uiState }) => !uiState.chdEnabled,
    id: "settings-chd-createdvd-codecs",
    key: "chdCreateDvdCodecs",
    kind: "text",
    label: getUiSettingsLabel("chdDvd"),
    labelDataLocalize: "DVD Codecs",
    placeholder: codecDefaultPlaceholderText("chdCreateDvdCodecs"),
    suggestion: `Valid values: ${codecValuesText("chdCreateDvdCodecs")}. Optional levels: ${codecLevelRangeText("chdCreateDvdCodecs")}`,
    suggestionDataLocalize: `Valid values: ${codecValuesText("chdCreateDvdCodecs")}. Optional levels: ${codecLevelRangeText("chdCreateDvdCodecs")}`,
    validationLabel: "DVD Codecs",
  },
  compressionProfile: {
    defaultValue: "max",
    id: "settings-compression-profile",
    key: "compressionProfile",
    kind: "range",
    label: getSettingsLabel("compressionProfile"),
    labelDataLocalize: "Level",
    max: COMPRESSION_PROFILES.length - 1,
    min: 0,
    scaleLabels: [...COMPRESSION_PROFILE_LABELS],
    step: 1,
    suggestion: `Default: Max. zstd levels: ${formatLevelRange(
      ZSTD_CODEC_MIN_LEVEL,
      ZSTD_CODEC_MAX_LEVEL,
    )}. Other codec levels: ${formatLevelRange(STANDARD_CODEC_MIN_LEVEL, STANDARD_CODEC_MAX_LEVEL)}.`,
    suggestionDataLocalize: `Default: Max. zstd levels: ${formatLevelRange(
      ZSTD_CODEC_MIN_LEVEL,
      ZSTD_CODEC_MAX_LEVEL,
    )}. Other codec levels: ${formatLevelRange(STANDARD_CODEC_MIN_LEVEL, STANDARD_CODEC_MAX_LEVEL)}.`,
    validationLabel: "Level",
    validValues: [...COMPRESSION_PROFILES],
  },
  defaultCompression: {
    defaultValue: "zip/special",
    id: "settings-default-compression",
    key: "defaultCompression",
    kind: "select",
    label: "Type",
    options: [
      { label: ".7z or ROM specific", value: "7z/special" },
      { label: ".zip or ROM specific", value: "zip/special" },
      { label: "ROM specific only", value: "special only" },
      { label: ".7z only", value: "7z only" },
      { label: ".zip only", value: "zip only" },
      { label: "None", value: "none" },
    ],
    suggestion:
      ".zip or ROM specific is the default: ZIP for archive output, or ROM-specific compression such as Z3DS, CHD, RVZ, etc. when available.",
    suggestionDataLocalize:
      ".zip or ROM specific is the default: ZIP for archive output, or ROM-specific compression such as Z3DS, CHD, RVZ, etc. when available.",
    validationLabel: "Type",
    validValues: ["7z/special", "zip/special", "special only", "7z only", "zip only", "none"],
  },
  fixChecksum: {
    defaultValue: false,
    id: "settings-fix-checksum",
    key: "fixChecksum",
    kind: "checkbox",
    label: getSettingsLabel("fixChecksum"),
    labelDataLocalize: "Fix ROM header",
    layout: "large",
  },
  language: {
    defaultValue: getDefaultLanguage,
    id: "settings-language",
    key: "language",
    kind: "select",
    label: getSettingsLabel("language"),
    options: [
      { label: "English", value: "en" },
      { label: "Français", value: "fr" },
      { label: "Deutsch", value: "de" },
      { label: "Italiano", value: "it" },
      { label: "Español", value: "es" },
      { label: "Nederlands", value: "nl" },
      { label: "Svenska", value: "sv" },
      { label: "Català", value: "ca" },
      { label: "Valencià", value: "ca-va" },
      { label: "Português Brasileiro", value: "pt-br" },
      { label: "Russian", value: "ru" },
      { label: "日本語", value: "ja" },
      { label: "中文（简体）", value: "zh-cn" },
      { label: "中文（正體）", value: "zh-tw" },
    ],
    validationLabel: "Language",
  },
  logLevel: {
    defaultValue: getDefaultWebappLogLevel,
    id: "settings-log-level",
    key: "logLevel",
    kind: "select",
    label: getSettingsLabel("logLevel"),
    options: [
      { label: "Off", value: "off" },
      { label: "Errors", value: "error" },
      { label: "Warnings", value: "warn" },
      { label: "Info", value: "info" },
      { label: "Debug", value: "debug" },
      { label: "Trace", value: "trace" },
    ],
    suggestion:
      "Default: Trace in development; Warnings otherwise. Debug and Trace include detailed workflow progress.",
    validationLabel: "Log level",
    validValues: [...LOG_LEVELS],
  },
  requireInputChecksumMatch: {
    defaultValue: true,
    id: "settings-require-input-checksum-match",
    key: "requireInputChecksumMatch",
    kind: "checkbox",
    label: getSettingsLabel("requireInputChecksumMatch"),
    labelDataLocalize: "Require input checksum match",
    layout: "large",
  },
  rvzBlockSize: {
    defaultValue: COMPRESSION_DEFAULTS.rvzBlockSize,
    disabled: ({ uiState }) => !uiState.rvzEnabled,
    id: "settings-rvz-block-size",
    key: "rvzBlockSize",
    kind: "number",
    label: getUiSettingsLabel("rvzBlockSize"),
    labelDataLocalize: "RVZ block size",
    max: 2147483647,
    min: 1,
    step: 1,
    suggestion: `Default: ${COMPRESSION_DEFAULTS.rvzBlockSize}`,
    suggestionDataLocalize: "Valid values: 1-2147483647",
    validationLabel: "RVZ block size",
  },
  rvzCodec: {
    codecOptions: getCompressionCodecOptions("rvzCodec"),
    defaultValue: COMPRESSION_DEFAULTS.rvzCodec,
    disabled: ({ uiState }) => !uiState.rvzEnabled,
    id: "settings-rvz-codec",
    key: "rvzCodec",
    kind: "text",
    label: getUiSettingsLabel("rvzCodec"),
    labelDataLocalize: "RVZ codec",
    placeholder: `${COMPRESSION_DEFAULTS.rvzCodec}:${getCodecMaxLevel(COMPRESSION_DEFAULTS.rvzCodec, ZSTD_CODEC_MAX_LEVEL)}`,
    suggestion: `Default: ${COMPRESSION_DEFAULTS.rvzCodec}. Optional level: ${COMPRESSION_DEFAULTS.rvzCodec}[:${codecLevelRange(
      COMPRESSION_DEFAULTS.rvzCodec,
      ZSTD_CODEC_MIN_LEVEL,
      ZSTD_CODEC_MAX_LEVEL,
    )}].`,
    suggestionDataLocalize: `Default: ${COMPRESSION_DEFAULTS.rvzCodec}. Optional level: ${COMPRESSION_DEFAULTS.rvzCodec}[:${codecLevelRange(
      COMPRESSION_DEFAULTS.rvzCodec,
      ZSTD_CODEC_MIN_LEVEL,
      ZSTD_CODEC_MAX_LEVEL,
    )}].`,
    validationLabel: "RVZ codec",
  },
  rvzCompressionLevel: {
    defaultValue: "",
    disabled: ({ uiState }) => !uiState.rvzEnabled,
    id: "settings-rvz-compression-level",
    key: "rvzCompressionLevel",
    kind: "number",
    label: getSettingsLabel("levelOverride"),
    labelDataLocalize: "Compression level override",
    max: getCodecMaxLevel(COMPRESSION_DEFAULTS.rvzCodec, ZSTD_CODEC_MAX_LEVEL),
    min: getCodecMinLevel(COMPRESSION_DEFAULTS.rvzCodec, ZSTD_CODEC_MIN_LEVEL),
    placeholder: "Uses Compression Level",
    step: 1,
    suggestion: `Optional override. Blank uses the compression profile. Valid values: ${codecLevelRange(
      COMPRESSION_DEFAULTS.rvzCodec,
      ZSTD_CODEC_MIN_LEVEL,
      ZSTD_CODEC_MAX_LEVEL,
    )}.`,
    suggestionDataLocalize: `Optional override. Blank uses the compression profile. Valid values: ${codecLevelRange(
      COMPRESSION_DEFAULTS.rvzCodec,
      ZSTD_CODEC_MIN_LEVEL,
      ZSTD_CODEC_MAX_LEVEL,
    )}.`,
    validationLabel: "RVZ compression level override",
  },
  sevenZipCodec: {
    codecOptions: getCompressionCodecOptions("sevenZipCodec"),
    defaultValue: COMPRESSION_DEFAULTS.sevenZipCodec,
    id: "settings-7z-codec",
    key: "sevenZipCodec",
    kind: "text",
    label: getUiSettingsLabel("sevenZipCodec"),
    labelDataLocalize: "7z codec",
    placeholder: `${COMPRESSION_DEFAULTS.sevenZipCodec}:${getCodecMaxLevel(
      COMPRESSION_DEFAULTS.sevenZipCodec,
      STANDARD_CODEC_MAX_LEVEL,
    )}`,
    suggestion: `Default: ${COMPRESSION_DEFAULTS.sevenZipCodec}. Optional level: ${COMPRESSION_DEFAULTS.sevenZipCodec}[:${codecLevelRange(
      COMPRESSION_DEFAULTS.sevenZipCodec,
      STANDARD_CODEC_MIN_LEVEL,
      STANDARD_CODEC_MAX_LEVEL,
    )}].`,
    suggestionDataLocalize: `Default: ${COMPRESSION_DEFAULTS.sevenZipCodec}. Optional level: ${COMPRESSION_DEFAULTS.sevenZipCodec}[:${codecLevelRange(
      COMPRESSION_DEFAULTS.sevenZipCodec,
      STANDARD_CODEC_MIN_LEVEL,
      STANDARD_CODEC_MAX_LEVEL,
    )}].`,
    validationLabel: "7z codec",
  },
  sevenZipLevel: {
    defaultValue: "",
    disabled: ({ uiState }) => !uiState.sevenZipEnabled,
    id: "settings-7z-level",
    key: "sevenZipLevel",
    kind: "number",
    label: getSettingsLabel("levelOverride"),
    labelDataLocalize: "Compression level override",
    max: getCodecMaxLevel(COMPRESSION_DEFAULTS.sevenZipCodec, STANDARD_CODEC_MAX_LEVEL),
    min: getCodecMinLevel(COMPRESSION_DEFAULTS.sevenZipCodec, STANDARD_CODEC_MIN_LEVEL),
    placeholder: "Uses Compression Level",
    step: 1,
    suggestion: `Optional override. Blank uses the compression profile. Valid values: ${codecLevelRange(
      COMPRESSION_DEFAULTS.sevenZipCodec,
      STANDARD_CODEC_MIN_LEVEL,
      STANDARD_CODEC_MAX_LEVEL,
    )}.`,
    suggestionDataLocalize: `Optional override. Blank uses the compression profile. Valid values: ${codecLevelRange(
      COMPRESSION_DEFAULTS.sevenZipCodec,
      STANDARD_CODEC_MIN_LEVEL,
      STANDARD_CODEC_MAX_LEVEL,
    )}.`,
    validationLabel: "7z compression level override",
  },
  workerThreads: {
    defaultValue: "auto",
    disabled: ({ uiState }) => !uiState.workerThreadsEnabled,
    id: "settings-worker-threads",
    key: "workerThreads",
    kind: "number",
    label: getSettingsLabel("workerThreads"),
    labelDataLocalize: "Threads",
    max: 64,
    min: 0,
    placeholder: "auto",
    step: 1,
    suggestion: ({ uiState }) =>
      uiState.workerThreadsEnabled
        ? "Valid values: auto, 0-64. Use 0 to disable threaded bundles."
        : "Valid values: auto or 1.",
    validationLabel: "Threads",
  },
  z3dsCompressionLevel: {
    defaultValue: "",
    id: "settings-z3ds-compression-level",
    key: "z3dsCompressionLevel",
    kind: "number",
    label: getSettingsLabel("levelOverride"),
    labelDataLocalize: "Compression level override",
    max: getCodecMaxLevel(COMPRESSION_DEFAULTS.z3dsCodec, ZSTD_CODEC_MAX_LEVEL),
    min: getCodecMinLevel(COMPRESSION_DEFAULTS.z3dsCodec, ZSTD_CODEC_MIN_LEVEL),
    placeholder: "Uses Compression Level",
    step: 1,
    suggestion: `Optional override. Blank uses the compression profile. Valid values: ${codecLevelRange(
      COMPRESSION_DEFAULTS.z3dsCodec,
      ZSTD_CODEC_MIN_LEVEL,
      ZSTD_CODEC_MAX_LEVEL,
    )}.`,
    suggestionDataLocalize: `Optional override. Blank uses the compression profile. Valid values: ${codecLevelRange(
      COMPRESSION_DEFAULTS.z3dsCodec,
      ZSTD_CODEC_MIN_LEVEL,
      ZSTD_CODEC_MAX_LEVEL,
    )}.`,
    validationLabel: "Z3DS compression level override",
  },
  zipCodec: {
    codecOptions: getCompressionCodecOptions("zipCodec"),
    defaultValue: COMPRESSION_DEFAULTS.zipCodec,
    disabled: ({ uiState }) => !uiState.zipEnabled,
    id: "settings-zip-codec",
    key: "zipCodec",
    kind: "text",
    label: getUiSettingsLabel("zipCodec"),
    labelDataLocalize: "ZIP codec",
    placeholder: `${ZIP_ZSTD_CODEC}:${getCodecMaxLevel(ZIP_ZSTD_CODEC, ZSTD_CODEC_MAX_LEVEL)}`,
    suggestion: `Default: ${COMPRESSION_DEFAULTS.zipCodec}. Valid values: ${codecValuesText("zipCodec")}. Optional levels: ${codecLevelRangeText(
      "zipCodec",
    )}. Store does not use a level.`,
    suggestionDataLocalize: `Default: ${COMPRESSION_DEFAULTS.zipCodec}. Valid values: ${codecValuesText("zipCodec")}. Optional levels: ${codecLevelRangeText(
      "zipCodec",
    )}. Store does not use a level.`,
    validationLabel: "ZIP codec",
  },
  zipLevel: {
    defaultValue: "",
    disabled: ({ settings, uiState }) =>
      !uiState.zipEnabled || normalizeCodecName(String(settings.zipCodec)) === "store",
    id: "settings-zip-level",
    key: "zipLevel",
    kind: "number",
    label: getSettingsLabel("levelOverride"),
    labelDataLocalize: "ZIP compression level override",
    max: ({ settings }) => getCodecMaxLevel(String(settings.zipCodec), STANDARD_CODEC_MAX_LEVEL),
    min: ({ settings }) => getCodecMinLevel(String(settings.zipCodec), STANDARD_CODEC_MIN_LEVEL),
    placeholder: "Uses Compression Level",
    step: 1,
    suggestion: ({ settings }) =>
      normalizeCodecName(String(settings.zipCodec)) === "store"
        ? "Unused for Store. Blank uses the compression profile."
        : normalizeCodecName(String(settings.zipCodec)) === "zstd"
          ? `Optional override. Blank uses the compression profile. Valid values: ${codecLevelRange(
              "zstd",
              ZSTD_CODEC_MIN_LEVEL,
              ZSTD_CODEC_MAX_LEVEL,
            )}.`
          : `Optional override. Blank uses the compression profile. Valid values: ${codecLevelRange(
              String(settings.zipCodec),
              STANDARD_CODEC_MIN_LEVEL,
              STANDARD_CODEC_MAX_LEVEL,
            )}.`,
    suggestionDataLocalize: ({ settings }) =>
      normalizeCodecName(String(settings.zipCodec)) === "zstd"
        ? `Optional override. Blank uses the compression profile. Valid values: ${codecLevelRange(
            "zstd",
            ZSTD_CODEC_MIN_LEVEL,
            ZSTD_CODEC_MAX_LEVEL,
          )}.`
        : `Optional override. Blank uses the compression profile. Valid values: ${codecLevelRange(
            String(settings.zipCodec),
            STANDARD_CODEC_MIN_LEVEL,
            STANDARD_CODEC_MAX_LEVEL,
          )}.`,
    validationLabel: "ZIP compression level override",
  },
};

const getSettingsChoiceValues = <K extends SettingsFieldKey>(fieldKey: K): string[] => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  if (Array.isArray(field.codecOptions)) return getCompressionCodecValues(fieldKey);
  if (Array.isArray(field.validValues)) return [...field.validValues];
  if (Array.isArray(field.options)) return field.options.map((option) => option.value);
  return [];
};

const getSettingsFieldId = (fieldKey: SettingsFieldKey): string => SETTINGS_FIELD_METADATA[fieldKey].id;

const getSettingsFieldValidationLabel = (fieldKey: SettingsFieldKey): string =>
  SETTINGS_FIELD_METADATA[fieldKey].validationLabel ||
  SETTINGS_FIELD_METADATA[fieldKey].label ||
  SETTINGS_FIELD_METADATA[fieldKey].id;

const isSettingsDraftFieldNumeric = (fieldKey: SettingsFieldKey): boolean =>
  SETTINGS_FIELD_METADATA[fieldKey].kind === "number";

const SETTINGS_VALID_LANGUAGES = getSettingsChoiceValues("language");
const SETTINGS_VALID_DEFAULT_COMPRESSION = getSettingsChoiceValues("defaultCompression");
const SETTINGS_VALID_COMPRESSION_PROFILES = getSettingsChoiceValues("compressionProfile");

const SETTINGS_PANEL_FIELD_ORDER: SettingsFieldKey[] = SETTINGS_FIELD_ORDER.filter(
  (fieldKey) => SETTINGS_FIELD_METADATA[fieldKey].kind !== "hidden" && !SETTINGS_LEVEL_OVERRIDE_FIELD_SET.has(fieldKey),
);

const SETTINGS_FIELD_ID_TO_KEY = SETTINGS_FIELD_ORDER.reduce<Record<string, SettingsFieldKey>>((mapping, fieldKey) => {
  mapping[SETTINGS_FIELD_METADATA[fieldKey].id] = fieldKey;
  return mapping;
}, {});

const getSettingsFieldDefaultValue = <K extends SettingsFieldKey>(fieldKey: K): SettingsState[K] => {
  const defaultValue = SETTINGS_FIELD_METADATA[fieldKey].defaultValue;
  return typeof defaultValue === "function" ? (defaultValue as () => SettingsState[K])() : defaultValue;
};

const resolveSettingsFieldTextValue = (
  value: DynamicSettingsText | undefined,
  settings: SettingsDraftState,
  uiState: SettingsUiState,
): string | undefined => {
  if (value === undefined) return undefined;
  return typeof value === "function" ? value({ settings, uiState }) : value;
};

const resolveSettingsFieldNumberValue = (
  value: DynamicSettingsNumber | undefined,
  settings: SettingsDraftState,
  uiState: SettingsUiState,
): number | undefined => {
  if (value === undefined) return undefined;
  return typeof value === "function" ? value({ settings, uiState }) : value;
};

const resolveSettingsFieldBooleanValue = (
  value: DynamicSettingsBoolean | undefined,
  settings: SettingsDraftState,
  uiState: SettingsUiState,
): boolean => {
  if (value === undefined) return false;
  return typeof value === "function" ? value({ settings, uiState }) : value;
};

const getSettingsUiState = (source: SettingsDraftState): SettingsUiState => {
  const defaultCompression = normalizeChoiceSetting(
    source.defaultCompression,
    SETTINGS_VALID_DEFAULT_COMPRESSION,
    "zip/special",
  );
  const specialEnabled =
    defaultCompression === "7z/special" ||
    defaultCompression === "zip/special" ||
    defaultCompression === "special only";
  return {
    chdEnabled: specialEnabled,
    compressionProfileIndex: getCompressionProfileIndex(SETTINGS_VALID_COMPRESSION_PROFILES, source.compressionProfile),
    compressionProfileLabel: getCompressionProfileLabel(source.compressionProfile),
    rvzEnabled: specialEnabled,
    sevenZipEnabled: defaultCompression === "7z/special" || defaultCompression === "7z only",
    workerThreadsEnabled: canUseThreadedWasm(),
    zipEnabled: defaultCompression === "zip/special" || defaultCompression === "zip only",
  };
};

const getSettingsFieldPlaceholder = (
  fieldKey: SettingsFieldKey,
  settings: SettingsDraftState,
  uiState: SettingsUiState = getSettingsUiState(settings),
): string | undefined =>
  resolveSettingsFieldTextValue(SETTINGS_FIELD_METADATA[fieldKey].placeholder, settings, uiState);

const getSettingsFieldSuggestion = (
  fieldKey: SettingsFieldKey,
  settings: SettingsDraftState,
  uiState: SettingsUiState = getSettingsUiState(settings),
): string | undefined => resolveSettingsFieldTextValue(SETTINGS_FIELD_METADATA[fieldKey].suggestion, settings, uiState);

const getSettingsFieldSuggestionDataLocalize = (
  fieldKey: SettingsFieldKey,
  settings: SettingsDraftState,
  uiState: SettingsUiState = getSettingsUiState(settings),
): string | undefined => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  return resolveSettingsFieldTextValue(field.suggestionDataLocalize ?? field.suggestion, settings, uiState);
};

const getSettingsFieldMin = (
  fieldKey: SettingsFieldKey,
  settings: SettingsDraftState,
  uiState: SettingsUiState = getSettingsUiState(settings),
): number | undefined => resolveSettingsFieldNumberValue(SETTINGS_FIELD_METADATA[fieldKey].min, settings, uiState);

const getSettingsFieldMax = (
  fieldKey: SettingsFieldKey,
  settings: SettingsDraftState,
  uiState: SettingsUiState = getSettingsUiState(settings),
): number | undefined => resolveSettingsFieldNumberValue(SETTINGS_FIELD_METADATA[fieldKey].max, settings, uiState);

const isSettingsFieldDisabled = (
  fieldKey: SettingsFieldKey,
  settings: SettingsDraftState,
  uiState: SettingsUiState = getSettingsUiState(settings),
): boolean => resolveSettingsFieldBooleanValue(SETTINGS_FIELD_METADATA[fieldKey].disabled, settings, uiState);

const getDefaultSettings = (): SettingsState => {
  const settings = {} as Record<SettingsFieldKey, SettingsState[SettingsFieldKey]>;
  for (const fieldKey of SETTINGS_FIELD_ORDER) settings[fieldKey] = getSettingsFieldDefaultValue(fieldKey);
  return settings as SettingsState;
};

const copySettings = (source: SettingsState): SettingsState => Object.assign({}, source);

export type {
  SettingsDraft,
  SettingsDraftState,
  SettingsFieldKey,
  SettingsState,
  SettingsUiState,
  SettingsValidation,
  StorageLike,
};
export {
  copySettings,
  getCompressionProfileFromIndex,
  getDefaultSettings,
  getDefaultWorkerThreads,
  getSettingsChoiceValues,
  getSettingsFieldDefaultValue,
  getSettingsFieldId,
  getSettingsFieldMax,
  getSettingsFieldMin,
  getSettingsFieldPlaceholder,
  getSettingsFieldSuggestion,
  getSettingsFieldSuggestionDataLocalize,
  getSettingsFieldValidationLabel,
  getSettingsUiState,
  isSettingsDraftFieldNumeric,
  isSettingsFieldDisabled,
  LOCAL_STORAGE_SETTINGS_ID,
  normalizeChoiceSetting,
  SETTINGS_FIELD_ID_TO_KEY,
  SETTINGS_FIELD_METADATA,
  SETTINGS_FIELD_ORDER,
  SETTINGS_LEVEL_OVERRIDE_FIELDS,
  SETTINGS_PANEL_FIELD_ORDER,
  SETTINGS_VALID_COMPRESSION_PROFILES,
};
