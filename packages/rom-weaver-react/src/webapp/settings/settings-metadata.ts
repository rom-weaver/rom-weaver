import { getBrowserLocaleCandidates, negotiateLocale } from "../../presentation/localization/index.ts";
import { getSettingsLabel } from "../../presentation/settings.ts";
import { LOG_LEVELS } from "../../types/logging.ts";
import {
  COMPRESSION_PROFILES,
  canUseThreadedWasm,
  getCompressionProfileFromIndex,
  getCompressionProfileIndex,
  getCompressionProfileLabel,
  getDefaultBrowserThreadCount,
  SEVEN_ZIP_COMPRESSION_METHODS,
  ZIP_COMPRESSION_METHODS,
} from "./settings-compression.ts";

const LOCAL_STORAGE_SETTINGS_ID = "rom-weaver-settings";

type SettingsState = {
  defaultArchive: string;
  specialCompression: boolean;
  language: string;
  logLevel: string;
  fixChecksum: boolean;
  requireInputChecksumMatch: boolean;
  requireOutputChecksumMatch: boolean;
  compressionProfile: string;
  compressionFormat: string;
  chdOutputMode: string;
  chdCreateCdCodecs: string;
  chdCreateDvdCodecs: string;
  rvzCompression: string;
  rvzCompressionLevel: number | "";
  rvzBlockSize: number;
  rvzScrub: boolean;
  z3dsCompressionLevel: number | "";
  sevenZipCodec: string;
  sevenZipLevel: number | "";
  zipCodec: string;
  zipLevel: number | "";
  workerThreads: number | "auto";
  erudaDevTools: boolean;
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
  "defaultArchive",
  "specialCompression",
  "language",
  "logLevel",
  "fixChecksum",
  "requireInputChecksumMatch",
  "requireOutputChecksumMatch",
  "compressionProfile",
  "compressionFormat",
  "chdOutputMode",
  "chdCreateCdCodecs",
  "chdCreateDvdCodecs",
  "rvzCompression",
  "rvzCompressionLevel",
  "rvzBlockSize",
  "rvzScrub",
  "z3dsCompressionLevel",
  "sevenZipCodec",
  "sevenZipLevel",
  "zipCodec",
  "zipLevel",
  "workerThreads",
  "erudaDevTools",
] as const satisfies readonly SettingsFieldKey[];

const SETTINGS_FIELD_METADATA: { [K in SettingsFieldKey]: SettingsFieldMetadata<K> } = {
  chdCreateCdCodecs: {
    defaultValue: "cdlz,cdzl,cdfl",
    disabled: ({ uiState }) => !uiState.chdEnabled,
    id: "settings-chd-createcd-codecs",
    key: "chdCreateCdCodecs",
    kind: "text",
    label: getSettingsLabel("chdCreateCdCodecs"),
    labelDataLocalize: "Create CD codecs",
    placeholder: "cdlz:9,cdzl:9,cdfl:8",
    suggestion:
      "Valid values: cdzs, cdlz, cdzl, cdfl. Optional levels: cdzs[:0-22], cdlz[:0-9], cdzl[:0-9], cdfl[:0-8]",
    suggestionDataLocalize:
      "Valid values: cdzs, cdlz, cdzl, cdfl. Optional levels: cdzs[:0-22], cdlz[:0-9], cdzl[:0-9], cdfl[:0-8]",
    validationLabel: "Create CD codecs",
    validValues: ["cdzs", "cdlz", "cdzl", "cdfl"],
  },
  chdCreateDvdCodecs: {
    defaultValue: "lzma,zlib,huff,flac",
    disabled: ({ uiState }) => !uiState.chdEnabled,
    id: "settings-chd-createdvd-codecs",
    key: "chdCreateDvdCodecs",
    kind: "text",
    label: getSettingsLabel("chdCreateDvdCodecs"),
    labelDataLocalize: "Create DVD codecs",
    placeholder: "lzma:9,zlib:9,huff,flac:8",
    suggestion:
      "Valid values: zstd, lzma, zlib, huff, flac. Optional levels: zstd[:0-22], lzma[:0-9], zlib[:0-9], huff, flac[:0-8]",
    suggestionDataLocalize:
      "Valid values: zstd, lzma, zlib, huff, flac. Optional levels: zstd[:0-22], lzma[:0-9], zlib[:0-9], huff, flac[:0-8]",
    validationLabel: "Create DVD codecs",
    validValues: ["zstd", "lzma", "zlib", "huff", "flac"],
  },
  chdOutputMode: {
    defaultValue: "auto",
    id: "settings-chd-output-mode",
    key: "chdOutputMode",
    kind: "hidden",
    validValues: ["auto", "cd", "dvd"],
  },
  compressionFormat: {
    defaultValue: "auto",
    id: "settings-output-compression",
    key: "compressionFormat",
    kind: "hidden",
    validValues: ["auto", "chd", "rvz", "z3ds", "7z", "zip", "none"],
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
    scaleLabels: ["Min", "Very Low", "Low", "Medium", "High", "Very High", "Max"],
    step: 1,
    suggestion: "Default: Max. RVZ/7z zstd levels: 0, 3, 5, 12, 19, 21, 22. ZIP/other levels: 0, 2, 3, 5, 7, 8, 9.",
    suggestionDataLocalize:
      "Default: Max. RVZ/7z zstd levels: 0, 3, 5, 12, 19, 21, 22. ZIP/other levels: 0, 2, 3, 5, 7, 8, 9.",
    validationLabel: "Level",
    validValues: [...COMPRESSION_PROFILES],
  },
  defaultArchive: {
    defaultValue: "zip",
    id: "settings-default-archive",
    key: "defaultArchive",
    kind: "select",
    label: "Default archive",
    options: [
      { label: "Raw", value: "none" },
      { label: ".zip", value: "zip" },
      { label: ".7z", value: "7z" },
    ],
    suggestion: "Default: .zip",
    validationLabel: "Default archive",
    validValues: ["none", "zip", "7z"],
  },
  erudaDevTools: {
    defaultValue: false,
    id: "settings-eruda-dev-tools",
    key: "erudaDevTools",
    kind: "checkbox",
    label: getSettingsLabel("erudaDevTools"),
    labelDataLocalize: "Enable Eruda dev tools",
    layout: "large",
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
    defaultValue: "warn",
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
    suggestion: "Default: Warnings. Debug and Trace include detailed workflow progress.",
    validationLabel: "Log level",
    validValues: [...LOG_LEVELS],
  },
  requireInputChecksumMatch: {
    defaultValue: true,
    id: "settings-require-input-checksum-match",
    key: "requireInputChecksumMatch",
    kind: "checkbox",
    label: getSettingsLabel("requireInputChecksumMatch"),
    labelDataLocalize: "Require input match",
    layout: "large",
  },
  requireOutputChecksumMatch: {
    defaultValue: true,
    id: "settings-require-output-checksum-match",
    key: "requireOutputChecksumMatch",
    kind: "checkbox",
    label: getSettingsLabel("requireOutputChecksumMatch"),
    labelDataLocalize: "Require output match",
    layout: "large",
  },
  rvzBlockSize: {
    defaultValue: 131072,
    disabled: ({ uiState }) => !uiState.rvzEnabled,
    id: "settings-rvz-block-size",
    key: "rvzBlockSize",
    kind: "number",
    label: getSettingsLabel("rvzBlockSize"),
    labelDataLocalize: "RVZ block size",
    max: 2147483647,
    min: 1,
    step: 1,
    suggestion: "Default: 131072",
    suggestionDataLocalize: "Valid values: 1-2147483647",
    validationLabel: "RVZ block size",
  },
  rvzCompression: {
    defaultValue: "zstd",
    disabled: ({ uiState }) => !uiState.rvzEnabled,
    id: "settings-rvz-compression",
    key: "rvzCompression",
    kind: "select",
    label: getSettingsLabel("rvzCompression"),
    labelDataLocalize: "Compression",
    options: [
      { label: "zstd", value: "zstd" },
      { label: "lzma", value: "lzma" },
      { label: "lzma2", value: "lzma2" },
      { label: "bzip2", value: "bzip2" },
      { label: "None", value: "none" },
    ],
    validationLabel: "Compression",
    validValues: ["none", "zstd", "bzip2", "lzma", "lzma2"],
  },
  rvzCompressionLevel: {
    defaultValue: "",
    disabled: ({ uiState }) => !uiState.rvzEnabled,
    id: "settings-rvz-compression-level",
    key: "rvzCompressionLevel",
    kind: "number",
    label: getSettingsLabel("rvzCompressionLevel"),
    labelDataLocalize: "Compression level override",
    max: 22,
    min: 0,
    placeholder: "Uses Compression Level",
    step: 1,
    suggestion: "Optional override. Blank uses the compression profile. Valid values: 0-22.",
    suggestionDataLocalize: "Optional override. Blank uses the compression profile. Valid values: 0-22.",
    validationLabel: "RVZ compression level override",
  },
  rvzScrub: {
    defaultValue: false,
    disabled: ({ uiState }) => !uiState.rvzEnabled,
    id: "settings-rvz-scrub",
    key: "rvzScrub",
    kind: "checkbox",
    label: getSettingsLabel("rvzScrub"),
    labelDataLocalize: "Scrub junk data",
    layout: "large",
  },
  sevenZipCodec: {
    defaultValue: "lzma2",
    disabled: ({ uiState }) => !uiState.sevenZipEnabled,
    id: "settings-7z-codec",
    key: "sevenZipCodec",
    kind: "select",
    label: getSettingsLabel("sevenZipCodec"),
    labelDataLocalize: "Codec",
    options: [
      { label: "LZMA2 (default)", value: "lzma2" },
      { label: "Zstandard (zstd)", value: "zstd" },
    ],
    validationLabel: "Codec",
    validValues: [...SEVEN_ZIP_COMPRESSION_METHODS],
  },
  sevenZipLevel: {
    defaultValue: "",
    disabled: ({ uiState }) => !uiState.sevenZipEnabled,
    id: "settings-7z-level",
    key: "sevenZipLevel",
    kind: "number",
    label: getSettingsLabel("sevenZipLevel"),
    labelDataLocalize: "Compression level override",
    max: ({ settings }) => (settings.sevenZipCodec === "zstd" ? 22 : 9),
    min: 0,
    placeholder: "Uses Compression Level",
    step: 1,
    suggestion: ({ settings }) =>
      settings.sevenZipCodec === "zstd"
        ? "Optional override. Blank uses the compression profile. Valid values: 0-22."
        : "Optional override. Blank uses the compression profile. Valid values: 0-9.",
    suggestionDataLocalize: "Optional override. Blank uses the compression profile. Valid values: 0-9.",
    validationLabel: "7z compression level override",
  },
  specialCompression: {
    defaultValue: true,
    id: "settings-special-compression",
    key: "specialCompression",
    kind: "checkbox",
    label: "Use special compression",
    suggestion:
      "When enabled, special output formats like CHD, RVZ, and Z3DS are chosen automatically when the input supports them.",
    validationLabel: "Special compression",
  },
  workerThreads: {
    defaultValue: "auto",
    disabled: ({ uiState }) => !uiState.workerThreadsEnabled,
    id: "settings-worker-threads",
    key: "workerThreads",
    kind: "number",
    label: getSettingsLabel("workerThreads"),
    labelDataLocalize: "Worker threads",
    max: 64,
    min: 0,
    placeholder: "auto",
    step: 1,
    suggestion: ({ uiState }) =>
      uiState.workerThreadsEnabled
        ? "Valid values: auto, 0-64. Use 0 to disable threaded bundles."
        : "Valid values: auto or 1.",
    validationLabel: "Worker threads",
  },
  z3dsCompressionLevel: {
    defaultValue: "",
    id: "settings-z3ds-compression-level",
    key: "z3dsCompressionLevel",
    kind: "number",
    label: getSettingsLabel("z3dsCompressionLevel"),
    labelDataLocalize: "Compression level override",
    max: 22,
    min: 0,
    placeholder: "Uses Compression Level",
    step: 1,
    suggestion: "Optional override. Blank uses the compression profile. Valid values: 0-22.",
    suggestionDataLocalize: "Optional override. Blank uses the compression profile. Valid values: 0-22.",
    validationLabel: "Z3DS compression level override",
  },
  zipCodec: {
    defaultValue: "deflate",
    disabled: ({ uiState }) => !uiState.zipEnabled,
    id: "settings-zip-codec",
    key: "zipCodec",
    kind: "select",
    label: getSettingsLabel("zipCodec"),
    labelDataLocalize: "ZIP codec",
    options: [
      { label: "Deflate (ZIP default)", value: "deflate" },
      { label: "Store (no compression)", value: "store" },
      { label: "Zstandard (ZIPX / .zipx)", value: "zstd" },
    ],
    suggestion: "zstd writes ZIPX-compatible .zipx output.",
    suggestionDataLocalize: "Use zstd to create ZIPX (.zipx) output.",
    validationLabel: "ZIP codec",
    validValues: [...ZIP_COMPRESSION_METHODS],
  },
  zipLevel: {
    defaultValue: "",
    disabled: ({ settings, uiState }) => !uiState.zipEnabled || settings.zipCodec === "store",
    id: "settings-zip-level",
    key: "zipLevel",
    kind: "number",
    label: getSettingsLabel("zipLevel"),
    labelDataLocalize: "ZIP compression level override",
    max: ({ settings }) => (settings.zipCodec === "zstd" ? 22 : 9),
    min: 0,
    placeholder: "Uses Compression Level",
    step: 1,
    suggestion: ({ settings }) =>
      settings.zipCodec === "store"
        ? "Unused for Store. Blank uses the compression profile."
        : settings.zipCodec === "zstd"
          ? "Optional override. Blank uses the compression profile. Valid values: 0-22."
          : "Optional override. Blank uses the compression profile. Valid values: 0-9.",
    suggestionDataLocalize: ({ settings }) =>
      settings.zipCodec === "zstd"
        ? "Optional override. Blank uses the compression profile. Valid values: 0-22."
        : "Optional override. Blank uses the compression profile. Valid values: 0-9.",
    validationLabel: "ZIP compression level override",
  },
};

const getSettingsChoiceValues = <K extends SettingsFieldKey>(fieldKey: K): string[] => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
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

const LANGUAGE_OPTIONS = Array.isArray(SETTINGS_FIELD_METADATA.language.options)
  ? SETTINGS_FIELD_METADATA.language.options.map((option) => ({ ...option }))
  : [];
const SETTINGS_VALID_LANGUAGES = getSettingsChoiceValues("language");
const SETTINGS_VALID_LOG_LEVELS = getSettingsChoiceValues("logLevel");
const SETTINGS_VALID_OUTPUT_COMPRESSION = getSettingsChoiceValues("compressionFormat");
const SETTINGS_VALID_CHD_OUTPUT_MODES = getSettingsChoiceValues("chdOutputMode");
const SETTINGS_VALID_CHD_CREATECD_CODECS = getSettingsChoiceValues("chdCreateCdCodecs");
const SETTINGS_VALID_CHD_CREATEDVD_CODECS = getSettingsChoiceValues("chdCreateDvdCodecs");
const SETTINGS_VALID_SEVEN_ZIP_CODECS = getSettingsChoiceValues("sevenZipCodec");
const SETTINGS_VALID_ZIP_CODECS = getSettingsChoiceValues("zipCodec");
const SETTINGS_VALID_RVZ_COMPRESSION = getSettingsChoiceValues("rvzCompression");
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

const getSettingsUiState = (source: SettingsDraftState): SettingsUiState => ({
  chdEnabled: source.compressionFormat === "auto" || source.compressionFormat === "chd",
  compressionProfileIndex: getCompressionProfileIndex(SETTINGS_VALID_COMPRESSION_PROFILES, source.compressionProfile),
  compressionProfileLabel: getCompressionProfileLabel(source.compressionProfile),
  rvzEnabled: source.compressionFormat === "auto" || source.compressionFormat === "rvz",
  sevenZipEnabled: source.compressionFormat === "auto" || source.compressionFormat === "7z",
  workerThreadsEnabled: canUseThreadedWasm(),
  zipEnabled: source.compressionFormat === "auto" || source.compressionFormat === "zip",
});

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
  DynamicSettingsBoolean,
  DynamicSettingsNumber,
  DynamicSettingsText,
  NumericDraftValue,
  SettingsChoiceOption,
  SettingsDraft,
  SettingsDraftState,
  SettingsFieldContext,
  SettingsFieldKey,
  SettingsFieldKind,
  SettingsFieldMetadata,
  SettingsState,
  SettingsUiState,
  SettingsValidation,
  StorageLike,
};
export {
  canUseThreadedWasm,
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
  LANGUAGE_OPTIONS,
  LOCAL_STORAGE_SETTINGS_ID,
  normalizeChoiceSetting,
  SETTINGS_FIELD_ID_TO_KEY,
  SETTINGS_FIELD_METADATA,
  SETTINGS_FIELD_ORDER,
  SETTINGS_PANEL_FIELD_ORDER,
  SETTINGS_VALID_CHD_CREATECD_CODECS,
  SETTINGS_VALID_CHD_CREATEDVD_CODECS,
  SETTINGS_VALID_CHD_OUTPUT_MODES,
  SETTINGS_VALID_COMPRESSION_PROFILES,
  SETTINGS_VALID_LANGUAGES,
  SETTINGS_VALID_LOG_LEVELS,
  SETTINGS_VALID_OUTPUT_COMPRESSION,
  SETTINGS_VALID_RVZ_COMPRESSION,
  SETTINGS_VALID_SEVEN_ZIP_CODECS,
  SETTINGS_VALID_ZIP_CODECS,
};
