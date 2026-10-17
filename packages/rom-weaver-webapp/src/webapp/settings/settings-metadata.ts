import {
  POST_APPLY_DOWNLOAD_BEHAVIOR_OPTIONS,
  POST_APPLY_TEST_BEHAVIOR_OPTIONS,
} from "../../lib/apply/post-apply-behavior.ts";
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
import {
  getBrowserLocaleCandidates,
  LOCALE_OPTIONS,
  negotiateLocale,
  type Localizer,
} from "../../presentation/localization/index.ts";
import type { MessageId } from "../../presentation/localization/catalog.ts";
import { getSettingsLabel, getUiSettingsLabel } from "../../presentation/settings.ts";
import { ACCENTS } from "../accent.ts";
import { DEFAULT_CHANNEL_ACCENT } from "../build-channel.ts";
import { LOG_LEVELS } from "../../types/logging.ts";
import type { ByteUnitSystem, PostApplyActionBehavior } from "../../types/settings.ts";
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
  detailedViewEnabled: boolean;
  accent: string;
  language: string;
  byteUnits: ByteUnitSystem;
  logLevel: string;
  weavePackage: string;
  postApplyDownloadBehavior: PostApplyActionBehavior;
  postApplyTestBehavior: PostApplyActionBehavior;
  betaToolsEnabled: boolean;
  emulatorSaveStorageEnabled: boolean;
  offlineCopyEnabled: boolean;
  onboardingEnabled: boolean;
  fixChecksum: boolean;
  identifiedOutputName: boolean;
  requireInputChecksumMatch: boolean;
  compressionProfile: string;
  chdCreateCdCodecs: string;
  chdCreateDvdCodecs: string;
  rvzCodec: string;
  rvzBlockSize: number;
  sevenZipCodec: string;
  zipCodec: string;
  threads: number | "auto";
};

type SettingsDraftState = Omit<SettingsState, "rvzBlockSize" | "threads"> & {
  rvzBlockSize: number | string;
  threads: number | string;
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
  label?: string;
  labelId?: MessageId;
};

type SettingsFieldKey = keyof SettingsState;
type SettingsFieldKind = "select" | "checkbox" | "choice-checkbox" | "text" | "number" | "range" | "hidden";

type SettingsUiState = {
  chdEnabled: boolean;
  rvzEnabled: boolean;
  sevenZipEnabled: boolean;
  zipEnabled: boolean;
  threadsEnabled: boolean;
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
  labelId?: MessageId;
  layout?: "default" | "large";
  validationLabel?: string;
  codecOptions?: CompressionCodecOption[];
  codecSuggestions?: CompressionCodecOption[];
  options?: SettingsChoiceOption[];
  validValues?: string[];
  placeholder?: DynamicSettingsText;
  suggestion?: (context: SettingsFieldContext, localizer: Localizer) => string;
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

function getDefaultThreads(): number {
  return getDefaultBrowserThreadCount(typeof globalThis === "undefined" ? undefined : globalThis);
}

// The build channel picks the starting dye lot so nightly/beta look distinct
// before anyone touches settings; picking an accent overrides it for good.
function getDefaultAccent(): string {
  return DEFAULT_CHANNEL_ACCENT;
}

function getDefaultLanguage(): string {
  const browserLanguage = negotiateLocale(getBrowserLocaleCandidates());
  const fullMatch = normalizeChoiceSetting(browserLanguage, SETTINGS_VALID_LANGUAGES, "");
  if (fullMatch) return fullMatch;
  return normalizeChoiceSetting(browserLanguage.slice(0, 2), SETTINGS_VALID_LANGUAGES, "en");
}

const SETTINGS_FIELD_ORDER = [
  "defaultCompression",
  "accent",
  "language",
  "byteUnits",
  "logLevel",
  "detailedViewEnabled",
  "betaToolsEnabled",
  "emulatorSaveStorageEnabled",
  "offlineCopyEnabled",
  "onboardingEnabled",
  "fixChecksum",
  "identifiedOutputName",
  "requireInputChecksumMatch",
  "weavePackage",
  "postApplyDownloadBehavior",
  "postApplyTestBehavior",
  "compressionProfile",
  "chdCreateCdCodecs",
  "chdCreateDvdCodecs",
  "rvzCodec",
  "rvzBlockSize",
  "sevenZipCodec",
  "zipCodec",
  "threads",
] as const satisfies readonly SettingsFieldKey[];
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

/**
 * The settings panel's sections, in display order. Shared with Find so a
 * setting can be reached by name from anywhere in the app. `title` is the stable
 * English key (anchor ids, Find keywords); `titleId` is what the UI shows.
 */
const SETTINGS_PANEL_SECTIONS: ReadonlyArray<{ fields: SettingsFieldKey[]; title: string; titleId?: MessageId }> = [
  {
    fields: [
      "language",
      "accent",
      "byteUnits",
      "logLevel",
      "detailedViewEnabled",
      "offlineCopyEnabled",
      "onboardingEnabled",
      "betaToolsEnabled",
    ],
    title: "Webapp",
    titleId: "ui.settings.section.webapp",
  },
  {
    fields: [
      "weavePackage",
      "postApplyDownloadBehavior",
      "postApplyTestBehavior",
      "emulatorSaveStorageEnabled",
      "fixChecksum",
      "identifiedOutputName",
      "requireInputChecksumMatch",
    ],
    title: "Behavior",
    titleId: "ui.settings.section.behavior",
  },
  {
    fields: ["defaultCompression", "compressionProfile", "threads"],
    title: "Compression",
    titleId: "ui.settings.section.compression",
  },
  {
    fields: ["zipCodec", "sevenZipCodec", "rvzCodec", "chdCreateCdCodecs", "chdCreateDvdCodecs"],
    title: "Codecs",
    titleId: "ui.settings.section.codecs",
  },
  { fields: ["rvzBlockSize"], title: "RVZ" },
];

/** Anchor id of a settings panel group; the console's jump links scroll to it. */
const settingsGroupId = (title: string) => `settings-group-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/**
 * Fields the console hides until Advanced is on: tuning knobs whose
 * defaults suit almost everyone. Hidden fields keep their saved values.
 */
const ADVANCED_SETTINGS_FIELDS: ReadonlySet<SettingsFieldKey> = new Set<SettingsFieldKey>([
  "threads",
  "zipCodec",
  "sevenZipCodec",
  "rvzCodec",
  "chdCreateCdCodecs",
  "chdCreateDvdCodecs",
  "rvzBlockSize",
]);

const POST_APPLY_LABEL_IDS: Readonly<Record<string, MessageId>> = {
  Automatically: "ui.settings.option.postApply.autoShow",
  "With a button": "ui.settings.option.postApply.show",
  Never: "ui.settings.option.postApply.hide",
};
const withPostApplyLabelId = (option: { label: string; value: string }): SettingsChoiceOption => ({
  ...option,
  labelId: POST_APPLY_LABEL_IDS[option.label] as MessageId,
});

const SETTINGS_FIELD_METADATA: { [K in SettingsFieldKey]: SettingsFieldMetadata<K> } = {
  betaToolsEnabled: {
    defaultValue: false,
    id: "settings-beta-tools-enabled",
    key: "betaToolsEnabled",
    kind: "checkbox",
    label: getSettingsLabel("betaToolsEnabled"),
    labelId: "settings.betaToolsEnabled",
    layout: "large",
  },
  byteUnits: {
    defaultValue: "decimal",
    id: "settings-byte-units",
    key: "byteUnits",
    suggestion: (_context, localizer) => localizer.message("ui.settings.suggestion.byteUnits"),
    kind: "select",
    label: getSettingsLabel("byteUnits"),
    labelId: "settings.byteUnits",
    options: [
      { labelId: "ui.settings.option.byteUnits.decimal", value: "decimal" },
      { labelId: "ui.settings.option.byteUnits.binary", value: "binary" },
    ],
    validationLabel: "File size units",
    validValues: ["decimal", "binary"],
  },
  weavePackage: {
    defaultValue: "patches",
    id: "settings-weave-package",
    key: "weavePackage",
    suggestion: (_context, localizer) => localizer.message("ui.settings.suggestion.weavePackage"),
    kind: "select",
    label: getSettingsLabel("weavePackage"),
    labelId: "settings.weavePackage",
    options: [
      { labelId: "ui.settings.option.weavePackage.patches", value: "patches" },
      { labelId: "ui.settings.option.weavePackage.rom", value: "rom" },
    ],
    validationLabel: "What a shared weave includes",
    validValues: ["patches", "rom"],
  },
  emulatorSaveStorageEnabled: {
    defaultValue: true,
    id: "settings-emulator-save-storage-enabled",
    key: "emulatorSaveStorageEnabled",
    suggestion: (_context, localizer) => localizer.message("ui.settings.suggestion.emulatorSaveStorage"),
    kind: "checkbox",
    label: getSettingsLabel("emulatorSaveStorageEnabled"),
    labelId: "settings.emulatorSaveStorageEnabled",
    layout: "large",
  },
  postApplyDownloadBehavior: {
    defaultValue: "auto-show",
    id: "settings-post-apply-download-behavior",
    key: "postApplyDownloadBehavior",
    suggestion: (_context, localizer) => localizer.message("ui.settings.suggestion.postApplyDownload"),
    kind: "select",
    label: getSettingsLabel("postApplyDownloadBehavior"),
    labelId: "settings.postApplyDownloadBehavior",
    options: POST_APPLY_DOWNLOAD_BEHAVIOR_OPTIONS.map(withPostApplyLabelId),
    validationLabel: "Download after patching",
    validValues: POST_APPLY_DOWNLOAD_BEHAVIOR_OPTIONS.map((option) => option.value),
  },
  postApplyTestBehavior: {
    defaultValue: "show",
    id: "settings-post-apply-test-behavior",
    key: "postApplyTestBehavior",
    suggestion: (_context, localizer) => localizer.message("ui.settings.suggestion.postApplyTest"),
    kind: "select",
    label: getSettingsLabel("postApplyTestBehavior"),
    labelId: "settings.postApplyTestBehavior",
    options: POST_APPLY_TEST_BEHAVIOR_OPTIONS.map(withPostApplyLabelId),
    validationLabel: "Open Test after patching",
    validValues: POST_APPLY_TEST_BEHAVIOR_OPTIONS.map((option) => option.value),
  },
  chdCreateCdCodecs: {
    codecOptions: getCompressionCodecOptions("chdCreateCdCodecs"),
    codecSuggestions: getCompressionCodecSuggestions("chdCreateCdCodecs"),
    defaultValue: COMPRESSION_DEFAULTS.chdCreateCdCodecs,
    disabled: ({ uiState }) => !uiState.chdEnabled,
    id: "settings-chd-createcd-codecs",
    key: "chdCreateCdCodecs",
    suggestion: (_context, localizer) =>
      localizer.message("ui.settings.suggestion.codecValuesLevels", {
        levels: codecLevelRangeText("chdCreateCdCodecs"),
        values: codecValuesText("chdCreateCdCodecs"),
      }),
    kind: "text",
    label: getUiSettingsLabel("chdCd"),
    labelId: "ui.settings.chdCd",
    placeholder: codecDefaultPlaceholderText("chdCreateCdCodecs"),
    validationLabel: "CD codecs",
  },
  chdCreateDvdCodecs: {
    codecOptions: getCompressionCodecOptions("chdCreateDvdCodecs"),
    codecSuggestions: getCompressionCodecSuggestions("chdCreateDvdCodecs"),
    defaultValue: COMPRESSION_DEFAULTS.chdCreateDvdCodecs,
    disabled: ({ uiState }) => !uiState.chdEnabled,
    id: "settings-chd-createdvd-codecs",
    key: "chdCreateDvdCodecs",
    suggestion: (_context, localizer) =>
      localizer.message("ui.settings.suggestion.codecValuesLevels", {
        levels: codecLevelRangeText("chdCreateDvdCodecs"),
        values: codecValuesText("chdCreateDvdCodecs"),
      }),
    kind: "text",
    label: getUiSettingsLabel("chdDvd"),
    labelId: "ui.settings.chdDvd",
    placeholder: codecDefaultPlaceholderText("chdCreateDvdCodecs"),
    validationLabel: "DVD codecs",
  },
  compressionProfile: {
    defaultValue: "max",
    id: "settings-compression-profile",
    key: "compressionProfile",
    suggestion: (_context, localizer) =>
      localizer.message("ui.settings.suggestion.compressionProfile", {
        other: formatLevelRange(STANDARD_CODEC_MIN_LEVEL, STANDARD_CODEC_MAX_LEVEL),
        zstd: formatLevelRange(ZSTD_CODEC_MIN_LEVEL, ZSTD_CODEC_MAX_LEVEL),
      }),
    kind: "range",
    label: getSettingsLabel("compressionProfile"),
    labelId: "settings.compressionProfile",
    max: COMPRESSION_PROFILES.length - 1,
    min: 0,
    scaleLabels: [...COMPRESSION_PROFILE_LABELS],
    step: 1,
    validationLabel: "Compression level",
    validValues: [...COMPRESSION_PROFILES],
  },
  defaultCompression: {
    defaultValue: "zip/special",
    id: "settings-default-compression",
    key: "defaultCompression",
    suggestion: (_context, localizer) => localizer.message("ui.settings.suggestion.defaultCompression"),
    kind: "select",
    label: getSettingsLabel("defaultCompression"),
    labelId: "settings.defaultCompression",
    options: [
      {
        label: "ROM-specific format, else .7z",
        labelId: "ui.settings.option.defaultCompression.sevenZipSpecial",
        value: "7z/special",
      },
      {
        label: "Default: ROM-specific format, else plain file or .zip",
        labelId: "ui.settings.option.defaultCompression.zipSpecial",
        value: "zip/special",
      },
      {
        label: "ROM-specific format only",
        labelId: "ui.settings.option.defaultCompression.specialOnly",
        value: "special only",
      },
      { labelId: "ui.settings.option.defaultCompression.sevenZipOnly", value: "7z only" },
      { labelId: "ui.settings.option.defaultCompression.zipOnly", value: "zip only" },
      { labelId: "ui.settings.option.defaultCompression.none", value: "none" },
    ],
    validationLabel: "Type",
    validValues: ["7z/special", "zip/special", "special only", "7z only", "zip only", "none"],
  },
  detailedViewEnabled: {
    defaultValue: false,
    id: "settings-detailed-view-enabled",
    key: "detailedViewEnabled",
    suggestion: (_context, localizer) => localizer.message("ui.settings.suggestion.detailedView"),
    kind: "checkbox",
    label: getSettingsLabel("detailedViewEnabled"),
    labelId: "settings.detailedViewEnabled",
    layout: "large",
  },
  fixChecksum: {
    defaultValue: false,
    id: "settings-fix-checksum",
    key: "fixChecksum",
    kind: "checkbox",
    label: getSettingsLabel("fixChecksum"),
    labelId: "settings.fixChecksum",
    layout: "large",
  },
  identifiedOutputName: {
    defaultValue: true,
    id: "settings-identified-output-name",
    key: "identifiedOutputName",
    suggestion: (_context, localizer) => localizer.message("ui.settings.suggestion.identifiedOutputName"),
    kind: "checkbox",
    label: getSettingsLabel("identifiedOutputName"),
    labelId: "settings.identifiedOutputName",
    layout: "large",
  },
  accent: {
    defaultValue: getDefaultAccent,
    id: "settings-accent",
    key: "accent",
    kind: "select",
    label: getSettingsLabel("accent"),
    labelId: "settings.accent",
    options: ACCENTS.map((accent) => ({ label: accent.label, value: accent.value })),
    validationLabel: "Accent",
  },
  language: {
    defaultValue: getDefaultLanguage,
    id: "settings-language",
    key: "language",
    kind: "select",
    label: getSettingsLabel("language"),
    labelId: "settings.language",
    // Only shipped catalogs appear in the language picker.
    options: LOCALE_OPTIONS.map((locale) => ({ label: locale.label, value: locale.value })),
    validationLabel: "Language",
  },
  logLevel: {
    defaultValue: getDefaultWebappLogLevel,
    id: "settings-log-level",
    key: "logLevel",
    suggestion: (_context, localizer) => localizer.message("ui.settings.suggestion.logLevel"),
    kind: "select",
    label: getSettingsLabel("logLevel"),
    labelId: "settings.logLevel",
    options: [
      { labelId: "ui.patch.off", value: "off" },
      { labelId: "ui.settings.option.logLevel.error", value: "error" },
      { labelId: "ui.settings.option.logLevel.warn", value: "warn" },
      { label: "Info", value: "info" },
      { label: "Debug", value: "debug" },
      { label: "Trace", value: "trace" },
    ],
    validationLabel: "Log level",
    validValues: [...LOG_LEVELS],
  },
  onboardingEnabled: {
    defaultValue: true,
    id: "settings-onboarding-enabled",
    key: "onboardingEnabled",
    kind: "checkbox",
    label: getSettingsLabel("onboardingEnabled"),
    labelId: "settings.onboardingEnabled",
    layout: "large",
  },
  offlineCopyEnabled: {
    defaultValue: true,
    id: "settings-offline-copy-enabled",
    key: "offlineCopyEnabled",
    suggestion: (_context, localizer) => localizer.message("settings.offlineCopyHelp"),
    kind: "checkbox",
    label: getSettingsLabel("offlineCopyEnabled"),
    labelId: "settings.offlineCopyEnabled",
    layout: "large",
  },
  requireInputChecksumMatch: {
    defaultValue: true,
    id: "settings-require-input-checksum-match",
    key: "requireInputChecksumMatch",
    kind: "checkbox",
    label: getSettingsLabel("requireInputChecksumMatch"),
    labelId: "settings.requireInputChecksumMatch",
    layout: "large",
  },
  rvzBlockSize: {
    defaultValue: COMPRESSION_DEFAULTS.rvzBlockSize,
    disabled: ({ uiState }) => !uiState.rvzEnabled,
    id: "settings-rvz-block-size",
    key: "rvzBlockSize",
    suggestion: (_context, localizer) =>
      localizer.message("ui.settings.suggestion.rvzBlockSize", { value: COMPRESSION_DEFAULTS.rvzBlockSize }),
    kind: "number",
    label: getUiSettingsLabel("rvzBlockSize"),
    labelId: "ui.settings.rvzBlockSize",
    max: 2147483647,
    min: 1,
    step: 1,
    validationLabel: "RVZ block size",
  },
  rvzCodec: {
    codecOptions: getCompressionCodecOptions("rvzCodec"),
    defaultValue: COMPRESSION_DEFAULTS.rvzCodec,
    disabled: ({ uiState }) => !uiState.rvzEnabled,
    id: "settings-rvz-codec",
    key: "rvzCodec",
    suggestion: (_context, localizer) =>
      localizer.message("ui.settings.suggestion.codecLevel", {
        codec: COMPRESSION_DEFAULTS.rvzCodec,
        range: codecLevelRange(COMPRESSION_DEFAULTS.rvzCodec, ZSTD_CODEC_MIN_LEVEL, ZSTD_CODEC_MAX_LEVEL),
      }),
    kind: "text",
    label: getUiSettingsLabel("rvzCodec"),
    labelId: "ui.settings.rvzCodec",
    placeholder: `${COMPRESSION_DEFAULTS.rvzCodec}:${getCodecMaxLevel(COMPRESSION_DEFAULTS.rvzCodec, ZSTD_CODEC_MAX_LEVEL)}`,
    validationLabel: "RVZ codec",
  },
  sevenZipCodec: {
    codecOptions: getCompressionCodecOptions("sevenZipCodec"),
    defaultValue: COMPRESSION_DEFAULTS.sevenZipCodec,
    id: "settings-7z-codec",
    key: "sevenZipCodec",
    suggestion: (_context, localizer) =>
      localizer.message("ui.settings.suggestion.codecLevel", {
        codec: COMPRESSION_DEFAULTS.sevenZipCodec,
        range: codecLevelRange(COMPRESSION_DEFAULTS.sevenZipCodec, STANDARD_CODEC_MIN_LEVEL, STANDARD_CODEC_MAX_LEVEL),
      }),
    kind: "text",
    label: getUiSettingsLabel("sevenZipCodec"),
    labelId: "ui.settings.sevenZipCodec",
    placeholder: `${COMPRESSION_DEFAULTS.sevenZipCodec}:${getCodecMaxLevel(
      COMPRESSION_DEFAULTS.sevenZipCodec,
      STANDARD_CODEC_MAX_LEVEL,
    )}`,
    validationLabel: "7z codec",
  },
  threads: {
    defaultValue: "auto",
    disabled: ({ uiState }) => !uiState.threadsEnabled,
    id: "settings-worker-threads",
    key: "threads",
    suggestion: ({ uiState }, localizer) =>
      localizer.message(
        uiState.threadsEnabled ? "ui.settings.suggestion.threadsThreaded" : "ui.settings.suggestion.threadsSingle",
      ),
    kind: "number",
    label: getSettingsLabel("threads"),
    labelId: "settings.threads",
    max: 64,
    min: 0,
    placeholder: "auto",
    step: 1,
    validationLabel: "Threads",
  },
  zipCodec: {
    codecOptions: getCompressionCodecOptions("zipCodec"),
    defaultValue: COMPRESSION_DEFAULTS.zipCodec,
    disabled: ({ uiState }) => !uiState.zipEnabled,
    id: "settings-zip-codec",
    key: "zipCodec",
    suggestion: (_context, localizer) =>
      localizer.message("ui.settings.suggestion.zipCodec", {
        codec: COMPRESSION_DEFAULTS.zipCodec,
        levels: codecLevelRangeText("zipCodec"),
        values: codecValuesText("zipCodec"),
      }),
    kind: "text",
    label: getUiSettingsLabel("zipCodec"),
    labelId: "ui.settings.zipCodec",
    placeholder: `${ZIP_ZSTD_CODEC}:${getCodecMaxLevel(ZIP_ZSTD_CODEC, ZSTD_CODEC_MAX_LEVEL)}`,
    validationLabel: "ZIP codec",
  },
};

const getSettingsChoiceValues = <K extends SettingsFieldKey>(fieldKey: K): string[] => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  if (Array.isArray(field.codecOptions)) return getCompressionCodecValues(fieldKey);
  if (Array.isArray(field.validValues)) return [...field.validValues];
  if (Array.isArray(field.options)) return field.options.map((option) => option.value);
  return [];
};

const getSettingsChoiceLabel = (option: SettingsChoiceOption, localizer: Localizer): string =>
  option.labelId ? localizer.message(option.labelId) : (option.label ?? option.value);

const getSettingsFieldLabel = (fieldKey: SettingsFieldKey, localizer: Localizer): string => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  return field.labelId ? localizer.message(field.labelId) : field.label || fieldKey;
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
  (fieldKey) => SETTINGS_FIELD_METADATA[fieldKey].kind !== "hidden",
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
    threadsEnabled: canUseThreadedWasm(),
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
  uiState: SettingsUiState,
  localizer: Localizer,
): string | undefined => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  return field.suggestion?.({ settings, uiState }, localizer);
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
  SettingsChoiceOption,
  SettingsDraft,
  SettingsDraftState,
  SettingsFieldKey,
  SettingsState,
  SettingsUiState,
  SettingsValidation,
  StorageLike,
};
export {
  ADVANCED_SETTINGS_FIELDS,
  copySettings,
  settingsGroupId,
  SETTINGS_PANEL_SECTIONS,
  getCompressionProfileFromIndex,
  getDefaultSettings,
  getDefaultThreads,
  getSettingsChoiceLabel,
  getSettingsChoiceValues,
  getSettingsFieldDefaultValue,
  getSettingsFieldId,
  getSettingsFieldLabel,
  getSettingsFieldMax,
  getSettingsFieldMin,
  getSettingsFieldPlaceholder,
  getSettingsFieldSuggestion,
  getSettingsFieldValidationLabel,
  getSettingsUiState,
  isSettingsDraftFieldNumeric,
  isSettingsFieldDisabled,
  LOCAL_STORAGE_SETTINGS_ID,
  normalizeChoiceSetting,
  SETTINGS_FIELD_ID_TO_KEY,
  SETTINGS_FIELD_METADATA,
  SETTINGS_FIELD_ORDER,
  SETTINGS_PANEL_FIELD_ORDER,
  SETTINGS_VALID_COMPRESSION_PROFILES,
};
