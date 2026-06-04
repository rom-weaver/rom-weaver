import * as v from "valibot";
import {
  CHD_CODEC_LEVEL_MAX,
  getChdCodecsForMode,
  normalizeArchiveCompressionLevelForFormat,
  normalizeBrowserThreadCount,
  normalizeCodecList,
  normalizeCodecListWithFallback,
  normalizeCompressionProfile,
  normalizeIntegerInRange,
  normalizeSevenZipCodec,
  normalizeZipCodec,
  parseIntegerInRange,
  resolveCompressionLevels,
} from "./settings-compression.ts";
import type {
  SettingsDraft,
  SettingsDraftState,
  SettingsFieldKey,
  SettingsState,
  SettingsValidation,
  StorageLike,
} from "./settings-metadata.ts";
import {
  getDefaultSettings,
  getDefaultWorkerThreads,
  getSettingsChoiceValues,
  getSettingsFieldDefaultValue,
  getSettingsFieldId,
  getSettingsFieldMax,
  getSettingsFieldMin,
  getSettingsFieldValidationLabel,
  isSettingsFieldDisabled,
  LOCAL_STORAGE_SETTINGS_ID,
  normalizeChoiceSetting,
  SETTINGS_FIELD_ORDER,
  SETTINGS_VALID_CHD_OUTPUT_MODES,
  SETTINGS_VALID_OUTPUT_COMPRESSION,
} from "./settings-metadata.ts";

const CODEC_WITH_OPTIONAL_LEVEL_REGEX = /^([a-z0-9_+-]+)(?::(\d+))?$/;
const CODEC_NAME_CAPTURE_REGEX = /^([a-z0-9_+-]+)$/;
const SETTINGS_STORAGE_VERSION = 5;

type RuntimeSharedSettings = Omit<
  SettingsState,
  "erudaDevTools" | "rvzCompressionLevel" | "z3dsCompressionLevel" | "sevenZipLevel" | "zipLevel"
> & {
  rvzCompressionLevel: number;
  z3dsCompressionLevel: number | "default";
  sevenZipLevel: number;
  zipLevel: number;
};

type GroupedStoredSettings = {
  apply?: {
    compression?: Record<string, unknown>;
    output?: Record<string, unknown>;
    patch?: Record<string, unknown>;
    validation?: Record<string, unknown>;
  };
  common?: Record<string, unknown>;
  create?: {
    compression?: Record<string, unknown>;
    output?: Record<string, unknown>;
  };
  storage?: Record<string, unknown>;
  version?: number;
};

type CodecListOptions = NonNullable<Parameters<typeof normalizeCodecList>[1]>;

const storedStringSchema = v.string();
const storedBooleanSchema = v.boolean();
const storedStringOrNumberSchema = v.union([v.string(), v.number()]);
const BOOLEAN_SETTINGS_FIELDS = [
  "specialCompression",
  "fixChecksum",
  "rvzScrub",
  "erudaDevTools",
] as const satisfies readonly SettingsFieldKey[];
const HIDDEN_DEFAULT_SETTINGS_FIELDS = [
  "compressionFormat",
  "chdOutputMode",
] as const satisfies readonly SettingsFieldKey[];
const ALWAYS_VALIDATE_CHOICE_FIELDS = [
  "defaultArchive",
  "language",
  "logLevel",
  "compressionProfile",
] as const satisfies readonly SettingsFieldKey[];
const CONDITIONAL_CHOICE_FIELDS = [
  "rvzCompression",
  "sevenZipCodec",
  "zipCodec",
] as const satisfies readonly SettingsFieldKey[];
const CHD_CODEC_FIELDS = ["chdCreateCdCodecs", "chdCreateDvdCodecs"] as const satisfies readonly SettingsFieldKey[];
const OPTIONAL_INTEGER_FIELDS = [
  "rvzCompressionLevel",
  "z3dsCompressionLevel",
  "sevenZipLevel",
  "zipLevel",
] as const satisfies readonly SettingsFieldKey[];

const readStoredField = <T>(schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>, value: unknown): T | undefined => {
  const result = v.safeParse(schema, value);
  return result.success ? result.output : undefined;
};

const copyObject = <T extends Record<string, unknown>>(source: T): T => Object.assign({}, source);

const getFieldChoiceValues = (fieldKey: SettingsFieldKey): readonly string[] => getSettingsChoiceValues(fieldKey);

const getNumericFieldRange = (
  fieldKey: SettingsFieldKey,
  settings: SettingsState,
): {
  min: number;
  max: number;
} => {
  const min = getSettingsFieldMin(fieldKey, settings);
  const max = getSettingsFieldMax(fieldKey, settings);
  if (typeof min !== "number" || typeof max !== "number")
    throw new Error(`Settings field ${fieldKey} is missing numeric bounds`);
  return { max, min };
};

const getFieldValidationMessage = (fieldKey: SettingsFieldKey, message: string) =>
  `${getSettingsFieldValidationLabel(fieldKey)} ${message}`;

const normalizeChoiceField = <K extends SettingsFieldKey>(
  fieldKey: K,
  value: unknown,
  fallback: SettingsState[K],
): SettingsState[K] =>
  normalizeChoiceSetting(value, getFieldChoiceValues(fieldKey), String(fallback)) as SettingsState[K];

const normalizeCodecSetting = (
  fieldKey: SettingsFieldKey,
  value: unknown,
  fallback: string,
  allowLevels = false,
): string => {
  const validCodecs = getFieldChoiceValues(fieldKey);
  const raw = String(value || "").trim();
  if (!raw) return "";
  const codecs = raw
    .split(",")
    .map((codec) => codec.trim().toLowerCase())
    .filter(Boolean);
  if (!codecs.length) return "";
  for (const codecValue of codecs) {
    const match = allowLevels
      ? codecValue.match(CODEC_WITH_OPTIONAL_LEVEL_REGEX)
      : codecValue.match(CODEC_NAME_CAPTURE_REGEX);
    if (!match) return fallback;
    const codec = match[1] || "";
    if (validCodecs.indexOf(codec) === -1) return fallback;
    if (match[2] !== undefined) {
      const level = parseInt(match[2], 10);
      const maxLevel = CHD_CODEC_LEVEL_MAX[codec];
      if (!Number.isFinite(level) || maxLevel === undefined || level < 0 || level > maxLevel) return fallback;
    }
  }
  return codecs.join(",");
};

const createCodecListOptions = (
  fieldKey: SettingsFieldKey,
  allowLevels = false,
  validCodecs = getFieldChoiceValues(fieldKey),
): CodecListOptions => ({
  allowLevels,
  isValidCodec: (codec) => validCodecs.indexOf(codec) !== -1,
  isValidLevel: (codec, level) => {
    const maxLevel = CHD_CODEC_LEVEL_MAX[codec];
    return maxLevel !== undefined && level >= 0 && level <= maxLevel;
  },
});

const normalizeStoredCodecSetting = (
  fieldKey: SettingsFieldKey,
  value: string | string[] | number | null | undefined,
  fallback: string,
  allowLevels = false,
): string => {
  return normalizeCodecListWithFallback(value, fallback, createCodecListOptions(fieldKey, allowLevels));
};

const normalizeIntegerField = (
  fieldKey: SettingsFieldKey,
  value: string | number | null | undefined,
  fallback: number,
  settings: SettingsState,
): number => {
  const { max, min } = getNumericFieldRange(fieldKey, settings);
  return normalizeIntegerInRange(value, {
    fallback,
    max,
    min,
  }) as number;
};

const normalizeOptionalIntegerFieldInput = (value: unknown): string | number | null | undefined =>
  typeof value === "string" || typeof value === "number" || value === null || value === undefined
    ? value
    : String(value);

const normalizeOptionalIntegerField = (
  fieldKey: SettingsFieldKey,
  value: unknown,
  fallback: number | "",
  settings: SettingsState,
): number | "" => {
  const { max, min } = getNumericFieldRange(fieldKey, settings);
  return normalizeIntegerInRange(normalizeOptionalIntegerFieldInput(value), {
    fallback,
    max,
    min,
  }) as number | "";
};

const normalizePositiveIntegerField = (
  fieldKey: SettingsFieldKey,
  value: unknown,
  fallback: number,
  settings: SettingsState,
): number => {
  const { max, min } = getNumericFieldRange(fieldKey, settings);
  const parsed = parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
};

const normalizeStoredWorkerThreads = (
  value: string | number | null | undefined,
  fallback = getDefaultWorkerThreads(),
): SettingsState["workerThreads"] => {
  if (typeof value === "string" && value.trim().toLowerCase() === "auto") return "auto";
  return normalizeBrowserThreadCount(value, undefined, fallback);
};

const resolveWorkerThreadsNumericFallback = (value: SettingsState["workerThreads"]): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : getDefaultWorkerThreads();

const assignSetting = <K extends SettingsFieldKey>(settings: SettingsState, fieldKey: K, value: SettingsState[K]) => {
  settings[fieldKey] = value;
};

const isValidationFieldEnabled = (fieldKey: SettingsFieldKey, settings: SettingsState): boolean =>
  !isSettingsFieldDisabled(fieldKey, settings as SettingsDraftState);

const applyDefaultFields = (settings: SettingsState, fieldKeys: readonly SettingsFieldKey[]) => {
  for (const fieldKey of fieldKeys) assignSetting(settings, fieldKey, getSettingsFieldDefaultValue(fieldKey));
};

const applyBooleanFields = (
  rawDraft: SettingsDraft,
  settings: SettingsState,
  fieldKeys: readonly (typeof BOOLEAN_SETTINGS_FIELDS)[number][],
) => {
  for (const fieldKey of fieldKeys)
    assignSetting(settings, fieldKey, !!readStoredField(storedBooleanSchema, rawDraft[fieldKey]));
};

const validateMetadataChoiceField = <K extends SettingsFieldKey>(
  fieldKey: K,
  rawDraft: SettingsDraft,
  validation: SettingsValidation,
): SettingsState[K] => validateChoiceSetting(fieldKey, rawDraft[fieldKey], validation);

const normalizeMetadataChoiceField = <K extends SettingsFieldKey>(
  fieldKey: K,
  rawDraft: SettingsDraft,
  settings: SettingsState,
): SettingsState[K] => normalizeChoiceField(fieldKey, rawDraft[fieldKey], settings[fieldKey]);

const validateConditionalChoiceField = <K extends SettingsFieldKey>(
  fieldKey: K,
  rawDraft: SettingsDraft,
  validation: SettingsValidation,
  settings: SettingsState,
): SettingsState[K] =>
  isValidationFieldEnabled(fieldKey, validation.settings)
    ? validateMetadataChoiceField(fieldKey, rawDraft, validation)
    : normalizeMetadataChoiceField(fieldKey, rawDraft, settings);

const validateConditionalCodecField = (
  fieldKey: SettingsFieldKey,
  rawDraft: SettingsDraft,
  validation: SettingsValidation,
  settings: SettingsState,
): string =>
  isValidationFieldEnabled(fieldKey, validation.settings)
    ? validateCodecList(fieldKey, rawDraft[fieldKey] as string | string[] | number | null | undefined, validation, true)
    : normalizeCodecSetting(fieldKey, rawDraft[fieldKey], settings[fieldKey] as string, true);

const validateConditionalOptionalIntegerField = (
  fieldKey: SettingsFieldKey,
  rawDraft: SettingsDraft,
  validation: SettingsValidation,
  settings: SettingsState,
): number | "" =>
  isValidationFieldEnabled(fieldKey, validation.settings)
    ? normalizeOptionalIntegerOverride(fieldKey, rawDraft[fieldKey], validation)
    : normalizeOptionalIntegerField(fieldKey, rawDraft[fieldKey], settings[fieldKey] as number | "", settings);

const validateConditionalPositiveIntegerField = (
  fieldKey: SettingsFieldKey,
  rawDraft: SettingsDraft,
  validation: SettingsValidation,
  settings: SettingsState,
): number =>
  isValidationFieldEnabled(fieldKey, validation.settings)
    ? normalizeIntegerSetting(fieldKey, rawDraft[fieldKey] as string | number | null | undefined, validation)
    : normalizePositiveIntegerField(fieldKey, rawDraft[fieldKey], settings[fieldKey] as number, settings);

const validateChoiceSetting = <K extends SettingsFieldKey>(
  fieldKey: K,
  value: unknown,
  validation: SettingsValidation,
): SettingsState[K] => {
  const validValues = getFieldChoiceValues(fieldKey);
  const result = v.safeParse(v.picklist(validValues), typeof value === "string" ? value.toLowerCase() : String(value));
  if (!result.success) {
    validation.messages.push(getFieldValidationMessage(fieldKey, `valid values: ${validValues.join(", ")}.`));
    validation.invalidFields.push(getSettingsFieldId(fieldKey));
    return String(validValues[0] || "") as SettingsState[K];
  }
  return result.output as SettingsState[K];
};

const validateCodecList = (
  fieldKey: SettingsFieldKey,
  value: string | string[] | number | null | undefined,
  validation: SettingsValidation,
  allowLevels = false,
): string => {
  const validCodecs = getFieldChoiceValues(fieldKey);
  try {
    const parsedValue = v.parse(v.union([v.string(), v.array(v.string()), v.number(), v.null(), v.undefined()]), value);
    return normalizeCodecList(parsedValue, createCodecListOptions(fieldKey, allowLevels, validCodecs));
  } catch {
    validation.messages.push(getFieldValidationMessage(fieldKey, `valid values: ${validCodecs.join(", ")}.`));
    validation.invalidFields.push(getSettingsFieldId(fieldKey));
    const raw = String(value || "").trim();
    if (!raw) return "";
    return raw;
  }
};

const normalizeIntegerSetting = (
  fieldKey: SettingsFieldKey,
  value: string | number | null | undefined,
  validation: SettingsValidation,
  settings: SettingsState = validation.settings,
): number => {
  const { max, min } = getNumericFieldRange(fieldKey, settings);
  const parsedValue = v.safeParse(storedStringOrNumberSchema, value);
  try {
    return parseIntegerInRange(parsedValue.success ? parsedValue.output : value, {
      failureMessage: getFieldValidationMessage(fieldKey, `valid values: ${min}-${max}.`),
      max,
      min,
      requireExactString: true,
    }) as number;
  } catch {
    validation.messages.push(getFieldValidationMessage(fieldKey, `valid values: ${min}-${max}.`));
    validation.invalidFields.push(getSettingsFieldId(fieldKey));
    return normalizeIntegerInRange(value, {
      fallback: min,
      max,
      min,
    }) as number;
  }
};

const normalizeWorkerThreadsSetting = (
  value: string | number | null | undefined,
  validation: SettingsValidation,
  settings: SettingsState = validation.settings,
): SettingsState["workerThreads"] => {
  const parsedValue = v.safeParse(storedStringOrNumberSchema, value);
  const normalizedRaw = String(parsedValue.success ? parsedValue.output : (value ?? ""))
    .trim()
    .toLowerCase();
  if (normalizedRaw === "auto") return "auto";
  const { max, min } = getNumericFieldRange("workerThreads", settings);
  try {
    const parsed = parseIntegerInRange(parsedValue.success ? parsedValue.output : value, {
      failureMessage: getFieldValidationMessage("workerThreads", `valid values: auto, ${min}-${max}.`),
      max,
      min,
      requireExactString: true,
    }) as number;
    return normalizeStoredWorkerThreads(parsed, resolveWorkerThreadsNumericFallback(settings.workerThreads));
  } catch {
    validation.messages.push(getFieldValidationMessage("workerThreads", `valid values: auto, ${min}-${max}.`));
    validation.invalidFields.push(getSettingsFieldId("workerThreads"));
    return settings.workerThreads;
  }
};

const normalizeOptionalIntegerOverride = (
  fieldKey: SettingsFieldKey,
  value: unknown,
  validation: SettingsValidation,
  settings: SettingsState = validation.settings,
): number | "" => {
  const nullableNumber = v.safeParse(v.union([v.string(), v.number(), v.null(), v.undefined()]), value);
  const raw = String(nullableNumber.success ? (nullableNumber.output ?? "") : (value ?? "")).trim();
  if (!raw) return "";
  return normalizeIntegerSetting(fieldKey, raw, validation, settings);
};

const materializeChdCodecSettings = (source?: SettingsState | null): SettingsState => {
  const settings = copyObject(source || getDefaultSettings()) as SettingsState;
  settings.chdCreateCdCodecs = getChdCodecsForMode("cd", {
    chdCreateCdCodecs: settings.chdCreateCdCodecs,
    chdCreateDvdCodecs: settings.chdCreateDvdCodecs,
    compressionProfile: settings.compressionProfile,
  });
  settings.chdCreateDvdCodecs = getChdCodecsForMode("dvd", {
    chdCreateCdCodecs: settings.chdCreateCdCodecs,
    chdCreateDvdCodecs: settings.chdCreateDvdCodecs,
    compressionProfile: settings.compressionProfile,
  });
  return settings;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const resetStoredSettings = (storageObject: StorageLike, reason: string) => {
  console.warn(`Resetting stored settings: ${reason}`);
  storageObject?.removeItem?.(LOCAL_STORAGE_SETTINGS_ID);
};

const readGroupedStoredSettings = (source: Record<string, unknown>): Record<string, unknown> => {
  const grouped = source as GroupedStoredSettings;
  const applySettings = isRecord(grouped.apply) ? grouped.apply : {};
  const createSettings = isRecord(grouped.create) ? grouped.create : {};
  const commonSettings = isRecord(grouped.common) ? grouped.common : {};
  const storageSettings = isRecord(grouped.storage) ? grouped.storage : {};
  const applyCompression = isRecord(applySettings.compression) ? applySettings.compression : {};
  const createCompression = isRecord(createSettings.compression) ? createSettings.compression : {};
  const compression = Object.fromEntries(
    [...Object.entries(createCompression), ...Object.entries(applyCompression)].filter(
      ([, value]) => value !== undefined,
    ),
  );
  const patch = isRecord(applySettings.patch) ? applySettings.patch : {};
  const validation = isRecord(applySettings.validation) ? applySettings.validation : {};
  return {
    chdCreateCdCodecs: compression.chdCreateCdCodecs,
    chdCreateDvdCodecs: compression.chdCreateDvdCodecs,
    compressionProfile: compression.profile,
    defaultArchive: commonSettings.defaultArchive,
    erudaDevTools: commonSettings.erudaDevTools,
    fixChecksum: patch.fixChecksum,
    language: commonSettings.language,
    logLevel: commonSettings.logLevel,
    requireInputChecksumMatch: validation.requireInputChecksumMatch,
    requireOutputChecksumMatch: validation.requireOutputChecksumMatch,
    rvzBlockSize: compression.rvzBlockSize,
    rvzCompression: compression.rvzCompression,
    rvzCompressionLevel: compression.rvzCompressionLevel,
    rvzScrub: compression.rvzScrub,
    sevenZipCodec: compression.sevenZipCodec,
    sevenZipLevel: compression.sevenZipLevel,
    specialCompression: commonSettings.specialCompression,
    workerThreads: compression.workerThreads,
    z3dsCompressionLevel: compression.z3dsCompressionLevel,
    zipCodec: compression.zipCodec,
    zipLevel: compression.zipLevel,
    ...storageSettings,
  };
};

const loadSettings = (storage?: StorageLike): SettingsState => {
  const settings = getDefaultSettings();
  const storageObject =
    storage === undefined
      ? (() => {
          if (typeof localStorage === "undefined") {
            return null;
          }
          return localStorage;
        })()
      : storage;
  if (!storageObject || typeof storageObject.getItem !== "function") return settings;
  const rawValue = storageObject.getItem(LOCAL_STORAGE_SETTINGS_ID);
  if (!rawValue) return settings;

  try {
    const parsedSettings = JSON.parse(rawValue) as Record<string, unknown> | null;
    if (!isRecord(parsedSettings)) {
      resetStoredSettings(storageObject, "settings payload is not an object");
      return settings;
    }
    if (parsedSettings.version !== SETTINGS_STORAGE_VERSION) {
      resetStoredSettings(storageObject, `expected version ${SETTINGS_STORAGE_VERSION}`);
      return settings;
    }
    if (!(isRecord(parsedSettings.common) || isRecord(parsedSettings.apply) || isRecord(parsedSettings.create))) {
      resetStoredSettings(storageObject, "settings payload is not grouped");
      return settings;
    }
    const loadedSettings = readGroupedStoredSettings(parsedSettings);

    const language = readStoredField(storedStringSchema, loadedSettings.language);
    if (language !== undefined) settings.language = normalizeChoiceField("language", language, settings.language);

    const logLevel = readStoredField(storedStringSchema, loadedSettings.logLevel);
    if (logLevel !== undefined) settings.logLevel = normalizeChoiceField("logLevel", logLevel, settings.logLevel);

    const fixChecksum = readStoredField(storedBooleanSchema, loadedSettings.fixChecksum);
    if (fixChecksum !== undefined) settings.fixChecksum = fixChecksum;

    const requireInputChecksumMatch = readStoredField(storedBooleanSchema, loadedSettings.requireInputChecksumMatch);
    if (requireInputChecksumMatch !== undefined) settings.requireInputChecksumMatch = requireInputChecksumMatch;

    const requireOutputChecksumMatch = readStoredField(storedBooleanSchema, loadedSettings.requireOutputChecksumMatch);
    if (requireOutputChecksumMatch !== undefined) settings.requireOutputChecksumMatch = requireOutputChecksumMatch;

    const compressionProfile = readStoredField(storedStringSchema, loadedSettings.compressionProfile);
    if (compressionProfile !== undefined)
      settings.compressionProfile = normalizeCompressionProfile(compressionProfile, settings.compressionProfile);

    const chdCreateCdCodecs = readStoredField(storedStringSchema, loadedSettings.chdCreateCdCodecs);
    if (chdCreateCdCodecs !== undefined)
      settings.chdCreateCdCodecs = normalizeStoredCodecSetting(
        "chdCreateCdCodecs",
        chdCreateCdCodecs,
        settings.chdCreateCdCodecs,
        true,
      );

    const chdCreateDvdCodecs = readStoredField(storedStringSchema, loadedSettings.chdCreateDvdCodecs);
    if (chdCreateDvdCodecs !== undefined)
      settings.chdCreateDvdCodecs = normalizeStoredCodecSetting(
        "chdCreateDvdCodecs",
        chdCreateDvdCodecs,
        settings.chdCreateDvdCodecs,
        true,
      );

    const rvzCompression = readStoredField(storedStringSchema, loadedSettings.rvzCompression);
    if (rvzCompression !== undefined)
      settings.rvzCompression = normalizeChoiceField("rvzCompression", rvzCompression, settings.rvzCompression);

    const rvzCompressionLevel = readStoredField(storedStringOrNumberSchema, loadedSettings.rvzCompressionLevel);
    if (rvzCompressionLevel !== undefined)
      settings.rvzCompressionLevel = normalizeOptionalIntegerField(
        "rvzCompressionLevel",
        rvzCompressionLevel,
        settings.rvzCompressionLevel,
        settings,
      );

    const rvzBlockSize = readStoredField(storedStringOrNumberSchema, loadedSettings.rvzBlockSize);
    if (rvzBlockSize !== undefined)
      settings.rvzBlockSize = normalizePositiveIntegerField(
        "rvzBlockSize",
        rvzBlockSize,
        settings.rvzBlockSize,
        settings,
      );

    const rvzScrub = readStoredField(storedBooleanSchema, loadedSettings.rvzScrub);
    if (rvzScrub !== undefined) settings.rvzScrub = rvzScrub;

    const z3dsCompressionLevel = readStoredField(storedStringOrNumberSchema, loadedSettings.z3dsCompressionLevel);
    if (z3dsCompressionLevel !== undefined)
      settings.z3dsCompressionLevel = normalizeOptionalIntegerField(
        "z3dsCompressionLevel",
        z3dsCompressionLevel,
        settings.z3dsCompressionLevel,
        settings,
      );

    const sevenZipCodec = readStoredField(storedStringSchema, loadedSettings.sevenZipCodec);
    if (sevenZipCodec !== undefined)
      settings.sevenZipCodec = normalizeChoiceField("sevenZipCodec", sevenZipCodec, settings.sevenZipCodec);

    const sevenZipLevel = readStoredField(storedStringOrNumberSchema, loadedSettings.sevenZipLevel);
    if (sevenZipLevel !== undefined)
      settings.sevenZipLevel = normalizeOptionalIntegerField(
        "sevenZipLevel",
        sevenZipLevel,
        settings.sevenZipLevel,
        settings,
      );

    const zipCodec = readStoredField(storedStringSchema, loadedSettings.zipCodec);
    if (zipCodec !== undefined) settings.zipCodec = normalizeChoiceField("zipCodec", zipCodec, settings.zipCodec);

    const zipLevel = readStoredField(storedStringOrNumberSchema, loadedSettings.zipLevel);
    if (zipLevel !== undefined)
      settings.zipLevel = normalizeOptionalIntegerField("zipLevel", zipLevel, settings.zipLevel, settings);

    const workerThreads = readStoredField(storedStringOrNumberSchema, loadedSettings.workerThreads);
    if (workerThreads !== undefined)
      settings.workerThreads = normalizeStoredWorkerThreads(
        workerThreads,
        resolveWorkerThreadsNumericFallback(settings.workerThreads),
      );

    const erudaDevTools = readStoredField(storedBooleanSchema, loadedSettings.erudaDevTools);
    if (erudaDevTools !== undefined) settings.erudaDevTools = erudaDevTools;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    resetStoredSettings(storageObject, message);
  }

  settings.compressionFormat = getSettingsFieldDefaultValue("compressionFormat");
  settings.chdOutputMode = getSettingsFieldDefaultValue("chdOutputMode");

  return settings;
};

const serializeSettingsForStorage = (source?: SettingsState | null): string | null => {
  const settings = source || getDefaultSettings();
  const defaultSettings = getDefaultSettings();
  const canonicalSettings = materializeChdCodecSettings(settings);
  const canonicalDefaults = materializeChdCodecSettings({
    ...defaultSettings,
    compressionProfile: settings.compressionProfile,
  });
  const storedSettings: GroupedStoredSettings = {
    apply: {},
    common: {},
    create: {},
    storage: {},
    version: SETTINGS_STORAGE_VERSION,
  };
  const storeSetting = <K extends SettingsFieldKey>(fieldKey: K, value: SettingsState[K]) => {
    if (fieldKey === "defaultArchive" || fieldKey === "specialCompression") {
      (storedSettings.common as Record<string, unknown>)[fieldKey] = value;
      return;
    }
    if (fieldKey === "language" || fieldKey === "logLevel" || fieldKey === "erudaDevTools") {
      (storedSettings.common as Record<string, unknown>)[fieldKey] = value;
      return;
    }
    if (fieldKey === "fixChecksum") {
      storedSettings.apply = {
        ...storedSettings.apply,
        patch: { ...storedSettings.apply?.patch, fixChecksum: value },
      };
      return;
    }
    if (fieldKey === "requireInputChecksumMatch" || fieldKey === "requireOutputChecksumMatch") {
      storedSettings.apply = {
        ...storedSettings.apply,
        validation: { ...storedSettings.apply?.validation, [fieldKey]: value },
      };
      return;
    }
    const compressionKey = fieldKey === "compressionProfile" ? "profile" : fieldKey;
    storedSettings.apply = {
      ...storedSettings.apply,
      compression: {
        ...storedSettings.apply?.compression,
        [compressionKey]: value,
      },
    };
    storedSettings.create = {
      ...storedSettings.create,
      compression: {
        ...storedSettings.create?.compression,
        [compressionKey]: value,
      },
    };
  };
  for (const fieldKey of SETTINGS_FIELD_ORDER) {
    if (fieldKey === "chdCreateCdCodecs" || fieldKey === "chdCreateDvdCodecs") {
      if (canonicalSettings[fieldKey] !== canonicalDefaults[fieldKey]) storeSetting(fieldKey, settings[fieldKey]);
      continue;
    }
    if (settings[fieldKey] !== defaultSettings[fieldKey]) storeSetting(fieldKey, settings[fieldKey]);
  }
  const hasStoredSettings =
    Object.keys(storedSettings.common || {}).length > 0 ||
    Object.keys(storedSettings.apply?.compression || {}).length > 0 ||
    Object.keys(storedSettings.apply?.patch || {}).length > 0 ||
    Object.keys(storedSettings.apply?.validation || {}).length > 0 ||
    Object.keys(storedSettings.create?.compression || {}).length > 0 ||
    Object.keys(storedSettings.storage || {}).length > 0;
  return hasStoredSettings ? JSON.stringify(storedSettings) : null;
};

const validateSettingsDraft = (rawDraft: SettingsDraft, currentSettings?: SettingsState | null): SettingsValidation => {
  const settings = currentSettings || getDefaultSettings();
  const validation: SettingsValidation = {
    invalidFields: [],
    messages: [],
    settings: copyObject(settings) as SettingsState,
  };

  applyDefaultFields(validation.settings, HIDDEN_DEFAULT_SETTINGS_FIELDS);
  for (const fieldKey of ALWAYS_VALIDATE_CHOICE_FIELDS)
    assignSetting(validation.settings, fieldKey, validateMetadataChoiceField(fieldKey, rawDraft, validation));
  applyBooleanFields(rawDraft, validation.settings, BOOLEAN_SETTINGS_FIELDS);
  validation.settings.requireInputChecksumMatch =
    readStoredField(storedBooleanSchema, rawDraft.requireInputChecksumMatch) !== false;
  validation.settings.requireOutputChecksumMatch =
    readStoredField(storedBooleanSchema, rawDraft.requireOutputChecksumMatch) !== false;

  for (const fieldKey of CHD_CODEC_FIELDS)
    assignSetting(
      validation.settings,
      fieldKey,
      validateConditionalCodecField(fieldKey, rawDraft, validation, settings),
    );
  for (const fieldKey of CONDITIONAL_CHOICE_FIELDS)
    assignSetting(
      validation.settings,
      fieldKey,
      validateConditionalChoiceField(fieldKey, rawDraft, validation, settings),
    );
  for (const fieldKey of OPTIONAL_INTEGER_FIELDS)
    assignSetting(
      validation.settings,
      fieldKey,
      validateConditionalOptionalIntegerField(fieldKey, rawDraft, validation, settings),
    );
  validation.settings.rvzBlockSize = validateConditionalPositiveIntegerField(
    "rvzBlockSize",
    rawDraft,
    validation,
    settings,
  );
  validation.settings.workerThreads = normalizeWorkerThreadsSetting(rawDraft.workerThreads, validation);

  return validation;
};

const buildSettingsForWebapp = (source?: SettingsState | null, extraSettings?: Record<string, unknown>) => {
  const settings = materializeChdCodecSettings(source || getDefaultSettings());
  const compressionLevels = resolveCompressionLevels(settings);
  return Object.assign(
    {
      chdCreateCdCodecs: settings.chdCreateCdCodecs,
      chdCreateDvdCodecs: settings.chdCreateDvdCodecs,
      chdOutputMode: getSettingsFieldDefaultValue("chdOutputMode"),
      compressionFormat: getSettingsFieldDefaultValue("compressionFormat"),
      compressionProfile: settings.compressionProfile,
      defaultArchive: settings.defaultArchive,
      fixChecksum: settings.fixChecksum,
      language: settings.language,
      logLevel: settings.logLevel,
      requireInputChecksumMatch: settings.requireInputChecksumMatch !== false,
      requireOutputChecksumMatch: settings.requireOutputChecksumMatch !== false,
      rvzBlockSize: settings.rvzBlockSize,
      rvzCompression: settings.rvzCompression,
      rvzCompressionLevel: compressionLevels.rvzCompressionLevel,
      rvzScrub: settings.rvzScrub,
      sevenZipCodec: settings.sevenZipCodec,
      sevenZipLevel: compressionLevels.sevenZipLevel,
      specialCompression: settings.specialCompression,
      workerThreads: settings.workerThreads,
      z3dsCompressionLevel: compressionLevels.z3dsCompressionLevel,
      zipCodec: settings.zipCodec,
      zipLevel: compressionLevels.zipLevel,
    },
    extraSettings || {},
  );
};

const createDefaultRuntimeSharedSettings = (): RuntimeSharedSettings =>
  buildSettingsForWebapp(getDefaultSettings()) as RuntimeSharedSettings;

const normalizeRuntimeSharedSettingsSource = (source?: Record<string, unknown> | null): RuntimeSharedSettings => {
  const settings = createDefaultRuntimeSharedSettings();
  const defaultSettings = getDefaultSettings();
  const rvzCompressionLevelMin = getNumericFieldRange("rvzCompressionLevel", defaultSettings).min;
  const z3dsCompressionLevelMin = getNumericFieldRange("z3dsCompressionLevel", defaultSettings).min;
  if (!source || typeof source !== "object") return settings;

  if (typeof source.language === "string")
    settings.language = normalizeChoiceField("language", source.language, settings.language);
  if (typeof source.defaultArchive === "string")
    settings.defaultArchive = normalizeChoiceField("defaultArchive", source.defaultArchive, settings.defaultArchive);
  if (typeof source.specialCompression === "boolean") settings.specialCompression = source.specialCompression;
  if (typeof source.logLevel === "string")
    settings.logLevel = normalizeChoiceField("logLevel", source.logLevel, settings.logLevel);
  if (typeof source.fixChecksum === "boolean") settings.fixChecksum = source.fixChecksum;
  if (typeof source.requireInputChecksumMatch === "boolean")
    settings.requireInputChecksumMatch = source.requireInputChecksumMatch;
  if (typeof source.requireOutputChecksumMatch === "boolean")
    settings.requireOutputChecksumMatch = source.requireOutputChecksumMatch;
  if (
    typeof source.compressionProfile === "string" ||
    typeof source.compressionProfile === "number" ||
    typeof source.compressionProfile === "boolean"
  )
    settings.compressionProfile = normalizeCompressionProfile(source.compressionProfile, settings.compressionProfile);
  if (typeof source.compressionFormat === "string")
    settings.compressionFormat = normalizeChoiceSetting(
      source.compressionFormat,
      SETTINGS_VALID_OUTPUT_COMPRESSION,
      settings.compressionFormat,
    );
  if (typeof source.chdOutputMode === "string")
    settings.chdOutputMode = normalizeChoiceSetting(
      source.chdOutputMode,
      SETTINGS_VALID_CHD_OUTPUT_MODES,
      settings.chdOutputMode,
    );
  if (typeof source.chdCreateCdCodecs === "string")
    settings.chdCreateCdCodecs =
      source.chdCreateCdCodecs.trim() === ""
        ? ""
        : normalizeStoredCodecSetting("chdCreateCdCodecs", source.chdCreateCdCodecs, settings.chdCreateCdCodecs, true);
  if (typeof source.chdCreateDvdCodecs === "string")
    settings.chdCreateDvdCodecs =
      source.chdCreateDvdCodecs.trim() === ""
        ? ""
        : normalizeStoredCodecSetting(
            "chdCreateDvdCodecs",
            source.chdCreateDvdCodecs,
            settings.chdCreateDvdCodecs,
            true,
          );
  if (typeof source.rvzCompression === "string")
    settings.rvzCompression = normalizeChoiceField("rvzCompression", source.rvzCompression, settings.rvzCompression);
  if (typeof source.rvzCompressionLevel === "number" || typeof source.rvzCompressionLevel === "string")
    settings.rvzCompressionLevel = normalizeIntegerField(
      "rvzCompressionLevel",
      source.rvzCompressionLevel,
      rvzCompressionLevelMin,
      defaultSettings,
    );
  if (typeof source.rvzBlockSize === "number" || typeof source.rvzBlockSize === "string")
    settings.rvzBlockSize = normalizePositiveIntegerField(
      "rvzBlockSize",
      source.rvzBlockSize,
      settings.rvzBlockSize,
      defaultSettings,
    );
  if (typeof source.rvzScrub === "boolean") settings.rvzScrub = source.rvzScrub;
  if (source.z3dsCompressionLevel === "default") settings.z3dsCompressionLevel = "default";
  else if (typeof source.z3dsCompressionLevel === "number" || typeof source.z3dsCompressionLevel === "string")
    settings.z3dsCompressionLevel = normalizeIntegerField(
      "z3dsCompressionLevel",
      source.z3dsCompressionLevel,
      z3dsCompressionLevelMin,
      defaultSettings,
    );
  if (typeof source.sevenZipCodec === "string")
    settings.sevenZipCodec = normalizeSevenZipCodec(source.sevenZipCodec, settings.sevenZipCodec);
  if (typeof source.sevenZipLevel === "number" || typeof source.sevenZipLevel === "string")
    settings.sevenZipLevel = normalizeArchiveCompressionLevelForFormat(
      "7z",
      settings.sevenZipCodec,
      source.sevenZipLevel,
      settings.sevenZipLevel,
    );
  else
    settings.sevenZipLevel = normalizeArchiveCompressionLevelForFormat(
      "7z",
      settings.sevenZipCodec,
      settings.sevenZipLevel,
      settings.sevenZipLevel,
    );
  if (typeof source.zipCodec === "string") settings.zipCodec = normalizeZipCodec(source.zipCodec, settings.zipCodec);
  if (typeof source.zipLevel === "number" || typeof source.zipLevel === "string")
    settings.zipLevel = normalizeArchiveCompressionLevelForFormat(
      "zip",
      settings.zipCodec,
      source.zipLevel,
      settings.zipLevel,
    );
  else
    settings.zipLevel = normalizeArchiveCompressionLevelForFormat(
      "zip",
      settings.zipCodec,
      settings.zipLevel,
      settings.zipLevel,
    );
  if (typeof source.workerThreads === "number" || typeof source.workerThreads === "string")
    settings.workerThreads = normalizeStoredWorkerThreads(
      source.workerThreads,
      resolveWorkerThreadsNumericFallback(settings.workerThreads),
    );

  return settings;
};

const normalizeRuntimeSettingsUpdate = (
  update?: Record<string, unknown> | null,
  current?: Record<string, unknown> | null,
): RuntimeSharedSettings => {
  const currentSettings = normalizeRuntimeSharedSettingsSource(current);
  const sanitizedUpdate = Object.fromEntries(Object.entries(update || {}).filter(([, value]) => value !== undefined));
  const nextSettings = normalizeRuntimeSharedSettingsSource({
    ...currentSettings,
    ...sanitizedUpdate,
  });
  if (Object.hasOwn(sanitizedUpdate, "compressionProfile")) {
    const derivedLevels = resolveCompressionLevels({
      compressionProfile: nextSettings.compressionProfile,
      rvzCompression: nextSettings.rvzCompression,
      rvzCompressionLevel: "",
      sevenZipCodec: nextSettings.sevenZipCodec,
      sevenZipLevel: "",
      z3dsCompressionLevel: nextSettings.z3dsCompressionLevel === "default" ? "default" : "",
      zipCodec: nextSettings.zipCodec,
      zipLevel: "",
    });
    if (!Object.hasOwn(sanitizedUpdate, "rvzCompressionLevel"))
      nextSettings.rvzCompressionLevel = Number(derivedLevels.rvzCompressionLevel);
    if (!Object.hasOwn(sanitizedUpdate, "z3dsCompressionLevel"))
      nextSettings.z3dsCompressionLevel =
        derivedLevels.z3dsCompressionLevel === "default" ? "default" : Number(derivedLevels.z3dsCompressionLevel);
    if (!Object.hasOwn(sanitizedUpdate, "sevenZipLevel"))
      nextSettings.sevenZipLevel = Number(derivedLevels.sevenZipLevel);
    if (!Object.hasOwn(sanitizedUpdate, "zipLevel")) nextSettings.zipLevel = Number(derivedLevels.zipLevel);
  }
  return nextSettings;
};

export {
  buildSettingsForWebapp,
  createDefaultRuntimeSharedSettings,
  getDefaultSettings,
  getDefaultWorkerThreads,
  loadSettings,
  normalizeRuntimeSettingsUpdate,
  SETTINGS_STORAGE_VERSION,
  serializeSettingsForStorage,
  validateSettingsDraft,
};
