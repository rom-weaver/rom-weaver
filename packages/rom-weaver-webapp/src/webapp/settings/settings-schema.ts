import { getCompressionCodecLevelMax, getCompressionCodecLevelMin } from "../../lib/compression/codec-fields.ts";
import { createLogger } from "../../lib/logging.ts";
import {
  getChdCodecsForMode,
  normalizeBrowserThreadCount,
  normalizeCodecList,
  normalizeCodecListWithFallback,
  normalizeCompressionProfile,
  normalizeIntegerInRange,
  parseIntegerInRange,
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
  getDefaultThreads,
  getSettingsChoiceValues,
  getSettingsFieldId,
  getSettingsFieldMax,
  getSettingsFieldMin,
  getSettingsFieldValidationLabel,
  isSettingsFieldDisabled,
  LOCAL_STORAGE_SETTINGS_ID,
  normalizeChoiceSetting,
  SETTINGS_FIELD_ORDER,
} from "./settings-metadata.ts";

const logger = createLogger("settings");

const SETTINGS_STORAGE_VERSION = 6;
// Versions whose payload loads under the current schema, so stored settings
// survive the upgrade; the next save rewrites the payload at the current
// version. A version bump must keep its predecessors loadable - list the old
// version here (additive changes load as-is because the loader defaults every
// missing field) or reshape the payload before the field reads. Wiping is a
// last resort for payloads that cannot be mapped. v6 only added
// postApplyRomBehavior, so v5 loads unchanged; v4 and older never shipped
// publicly and are not worth mapping.
const COMPATIBLE_PRIOR_STORAGE_VERSIONS = new Set<number>([5]);

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

type StoredSchema<T> = (value: unknown) => value is T;

const storedStringSchema: StoredSchema<string> = (value): value is string => typeof value === "string";
const storedBooleanSchema: StoredSchema<boolean> = (value): value is boolean => typeof value === "boolean";
const storedStringOrNumberSchema: StoredSchema<string | number> = (value): value is string | number =>
  typeof value === "string" || typeof value === "number";
const isCodecSettingValue = (value: unknown): value is string | string[] | number | null | undefined =>
  typeof value === "string" ||
  typeof value === "number" ||
  value === null ||
  value === undefined ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));
const BOOLEAN_SETTINGS_FIELDS = [
  "betaToolsEnabled",
  "onboardingEnabled",
  "fixChecksum",
] as const satisfies readonly SettingsFieldKey[];
const ALWAYS_VALIDATE_CHOICE_FIELDS = [
  "defaultCompression",
  "accent",
  "language",
  "logLevel",
  "bundlePackage",
  "postApplyRomBehavior",
  "compressionProfile",
] as const satisfies readonly SettingsFieldKey[];
const CHD_CODEC_FIELDS = ["chdCreateCdCodecs", "chdCreateDvdCodecs"] as const satisfies readonly SettingsFieldKey[];
const SINGLE_CODEC_FIELDS = ["rvzCodec", "sevenZipCodec", "zipCodec"] as const satisfies readonly SettingsFieldKey[];
const FORMAT_CODEC_FIELDS = [
  ...SINGLE_CODEC_FIELDS,
  ...CHD_CODEC_FIELDS,
] as const satisfies readonly SettingsFieldKey[];
const isSingleCodecField = (fieldKey: SettingsFieldKey): boolean =>
  (SINGLE_CODEC_FIELDS as readonly SettingsFieldKey[]).includes(fieldKey);

const readStoredField = <T>(schema: StoredSchema<T>, value: unknown): T | undefined =>
  schema(value) ? value : undefined;

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

const formatLevelRange = (min: number, max: number): string => `${min}..${max}`;

const getCodecLevelMax = (fieldKey: SettingsFieldKey, codec: string): number | null => {
  return getCompressionCodecLevelMax(fieldKey, codec);
};

const getCodecLevelMin = (fieldKey: SettingsFieldKey, codec: string): number | null => {
  return getCompressionCodecLevelMin(fieldKey, codec);
};

const getCodecValidationMessage = (fieldKey: SettingsFieldKey, validCodecs: readonly string[]): string => {
  const levelHints = validCodecs.map((codec) => {
    const maxLevel = getCodecLevelMax(fieldKey, codec);
    const minLevel = getCodecLevelMin(fieldKey, codec) ?? 0;
    return maxLevel === null ? codec : `${codec}[:${formatLevelRange(minLevel, maxLevel)}]`;
  });
  return `valid values: ${validCodecs.join(", ")}. Optional levels: ${levelHints.join(", ")}.`;
};

const createCodecListOptions = (
  fieldKey: SettingsFieldKey,
  allowLevels = false,
  validCodecs = getFieldChoiceValues(fieldKey),
): CodecListOptions => ({
  allowLevels,
  isValidCodec: (codec) => validCodecs.indexOf(codec) !== -1,
  isValidLevel: (codec, level) => {
    const maxLevel = getCodecLevelMax(fieldKey, codec);
    const minLevel = getCodecLevelMin(fieldKey, codec) ?? 0;
    return maxLevel !== null && level >= minLevel && level <= maxLevel;
  },
});

const normalizeValidatedCodecSetting = (
  fieldKey: SettingsFieldKey,
  value: string | string[] | number | null | undefined,
  allowLevels = false,
  validCodecs = getFieldChoiceValues(fieldKey),
): string => {
  const normalized = normalizeCodecList(value, createCodecListOptions(fieldKey, allowLevels, validCodecs));
  if (isSingleCodecField(fieldKey) && normalized.split(",").filter(Boolean).length > 1) {
    throw new Error(`Expected one codec for ${fieldKey}`);
  }
  return normalized;
};

const normalizeCodecSetting = (
  fieldKey: SettingsFieldKey,
  value: string | string[] | number | null | undefined,
  fallback: string,
  allowLevels = false,
): string => {
  try {
    const normalized = normalizeValidatedCodecSetting(fieldKey, value, allowLevels);
    return normalized || fallback;
  } catch {
    return fallback;
  }
};

const normalizeStoredCodecSetting = (
  fieldKey: SettingsFieldKey,
  value: string | string[] | number | null | undefined,
  fallback: string,
  allowLevels = false,
): string => {
  if (isSingleCodecField(fieldKey)) return normalizeCodecSetting(fieldKey, value, fallback, allowLevels);
  return normalizeCodecListWithFallback(value, fallback, createCodecListOptions(fieldKey, allowLevels));
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

const normalizeStoredThreads = (
  value: string | number | null | undefined,
  fallback = getDefaultThreads(),
): SettingsState["threads"] => {
  if (typeof value === "string" && value.trim().toLowerCase() === "auto") return "auto";
  return normalizeBrowserThreadCount(value, undefined, fallback);
};

const resolveThreadsNumericFallback = (value: SettingsState["threads"]): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : getDefaultThreads();

const assignSetting = <K extends SettingsFieldKey>(settings: SettingsState, fieldKey: K, value: SettingsState[K]) => {
  settings[fieldKey] = value;
};

const isValidationFieldEnabled = (fieldKey: SettingsFieldKey, settings: SettingsState): boolean =>
  !isSettingsFieldDisabled(fieldKey, settings as SettingsDraftState);

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

const validateConditionalCodecField = (
  fieldKey: SettingsFieldKey,
  rawDraft: SettingsDraft,
  validation: SettingsValidation,
  settings: SettingsState,
): string =>
  isValidationFieldEnabled(fieldKey, validation.settings)
    ? validateCodecList(fieldKey, rawDraft[fieldKey] as string | string[] | number | null | undefined, validation, true)
    : normalizeCodecSetting(
        fieldKey,
        rawDraft[fieldKey] as string | string[] | number | null | undefined,
        settings[fieldKey] as string,
        true,
      );

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
  const normalized = typeof value === "string" ? value.toLowerCase() : String(value);
  if (!validValues.includes(normalized)) {
    validation.messages.push(getFieldValidationMessage(fieldKey, `valid values: ${validValues.join(", ")}.`));
    validation.invalidFields.push(getSettingsFieldId(fieldKey));
    return String(validValues[0] || "") as SettingsState[K];
  }
  return normalized as SettingsState[K];
};

const validateCodecList = (
  fieldKey: SettingsFieldKey,
  value: string | string[] | number | null | undefined,
  validation: SettingsValidation,
  allowLevels = false,
): string => {
  const validCodecs = getFieldChoiceValues(fieldKey);
  try {
    if (!isCodecSettingValue(value)) throw new TypeError("Invalid codec setting");
    return normalizeValidatedCodecSetting(fieldKey, value, allowLevels, validCodecs);
  } catch {
    validation.messages.push(getFieldValidationMessage(fieldKey, getCodecValidationMessage(fieldKey, validCodecs)));
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
  const rangeText = formatLevelRange(min, max);
  const parsedValue = readStoredField(storedStringOrNumberSchema, value);
  try {
    return parseIntegerInRange(parsedValue === undefined ? value : parsedValue, {
      failureMessage: getFieldValidationMessage(fieldKey, `valid values: ${rangeText}.`),
      max,
      min,
      requireExactString: true,
    }) as number;
  } catch {
    validation.messages.push(getFieldValidationMessage(fieldKey, `valid values: ${rangeText}.`));
    validation.invalidFields.push(getSettingsFieldId(fieldKey));
    return normalizeIntegerInRange(value, {
      fallback: min,
      max,
      min,
    }) as number;
  }
};

const normalizeThreadsSetting = (
  value: string | number | null | undefined,
  validation: SettingsValidation,
  settings: SettingsState = validation.settings,
): SettingsState["threads"] => {
  const parsedValue = readStoredField(storedStringOrNumberSchema, value);
  const normalizedRaw = String(parsedValue === undefined ? (value ?? "") : parsedValue)
    .trim()
    .toLowerCase();
  if (normalizedRaw === "auto") return "auto";
  const { max, min } = getNumericFieldRange("threads", settings);
  try {
    const parsed = parseIntegerInRange(parsedValue === undefined ? value : parsedValue, {
      failureMessage: getFieldValidationMessage("threads", `valid values: auto, ${min}-${max}.`),
      max,
      min,
      requireExactString: true,
    }) as number;
    return normalizeStoredThreads(parsed, resolveThreadsNumericFallback(settings.threads));
  } catch {
    validation.messages.push(getFieldValidationMessage("threads", `valid values: auto, ${min}-${max}.`));
    validation.invalidFields.push(getSettingsFieldId("threads"));
    return settings.threads;
  }
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
  logger.warn("Resetting stored settings", { reason });
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
    betaToolsEnabled: commonSettings.betaToolsEnabled,
    onboardingEnabled: commonSettings.onboardingEnabled,
    accent: commonSettings.accent,
    bundlePackage: isRecord(applySettings.output) ? applySettings.output.bundlePackage : undefined,
    postApplyRomBehavior: isRecord(applySettings.output) ? applySettings.output.postApplyRomBehavior : undefined,
    chdCreateCdCodecs: compression.chdCreateCdCodecs,
    chdCreateDvdCodecs: compression.chdCreateDvdCodecs,
    compressionProfile: compression.profile,
    defaultCompression: commonSettings.defaultCompression,
    fixChecksum: patch.fixChecksum,
    language: commonSettings.language,
    logLevel: commonSettings.logLevel,
    requireInputChecksumMatch: validation.requireInputChecksumMatch,
    rvzBlockSize: compression.rvzBlockSize,
    rvzCodec: compression.rvzCodec,
    sevenZipCodec: compression.sevenZipCodec,
    threads: compression.threads ?? compression.workerThreads,
    zipCodec: compression.zipCodec,
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
    if (
      parsedSettings.version !== SETTINGS_STORAGE_VERSION &&
      !COMPATIBLE_PRIOR_STORAGE_VERSIONS.has(parsedSettings.version as number)
    ) {
      resetStoredSettings(storageObject, `expected version ${SETTINGS_STORAGE_VERSION}`);
      return settings;
    }
    if (!(isRecord(parsedSettings.common) || isRecord(parsedSettings.apply) || isRecord(parsedSettings.create))) {
      resetStoredSettings(storageObject, "settings payload is not grouped");
      return settings;
    }
    const loadedSettings = readGroupedStoredSettings(parsedSettings);

    const accent = readStoredField(storedStringSchema, loadedSettings.accent);
    if (accent !== undefined) settings.accent = normalizeChoiceField("accent", accent, settings.accent);

    const language = readStoredField(storedStringSchema, loadedSettings.language);
    if (language !== undefined) settings.language = normalizeChoiceField("language", language, settings.language);

    const logLevel = readStoredField(storedStringSchema, loadedSettings.logLevel);
    if (logLevel !== undefined) settings.logLevel = normalizeChoiceField("logLevel", logLevel, settings.logLevel);

    const bundlePackage = readStoredField(storedStringSchema, loadedSettings.bundlePackage);
    if (bundlePackage !== undefined)
      settings.bundlePackage = normalizeChoiceField("bundlePackage", bundlePackage, settings.bundlePackage);

    const postApplyRomBehavior = readStoredField(storedStringSchema, loadedSettings.postApplyRomBehavior);
    if (postApplyRomBehavior !== undefined)
      settings.postApplyRomBehavior = normalizeChoiceField(
        "postApplyRomBehavior",
        postApplyRomBehavior,
        settings.postApplyRomBehavior,
      );

    const betaToolsEnabled = readStoredField(storedBooleanSchema, loadedSettings.betaToolsEnabled);
    if (betaToolsEnabled !== undefined) settings.betaToolsEnabled = betaToolsEnabled;

    const onboardingEnabled = readStoredField(storedBooleanSchema, loadedSettings.onboardingEnabled);
    if (onboardingEnabled !== undefined) settings.onboardingEnabled = onboardingEnabled;

    const defaultCompression = readStoredField(storedStringSchema, loadedSettings.defaultCompression);
    if (defaultCompression !== undefined) {
      settings.defaultCompression = normalizeChoiceField(
        "defaultCompression",
        defaultCompression,
        settings.defaultCompression,
      );
    }

    const fixChecksum = readStoredField(storedBooleanSchema, loadedSettings.fixChecksum);
    if (fixChecksum !== undefined) settings.fixChecksum = fixChecksum;

    const requireInputChecksumMatch = readStoredField(storedBooleanSchema, loadedSettings.requireInputChecksumMatch);
    if (requireInputChecksumMatch !== undefined) settings.requireInputChecksumMatch = requireInputChecksumMatch;

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

    const rvzCodec = readStoredField(storedStringSchema, loadedSettings.rvzCodec);
    if (rvzCodec !== undefined)
      settings.rvzCodec = normalizeStoredCodecSetting("rvzCodec", rvzCodec, settings.rvzCodec, true);

    const rvzBlockSize = readStoredField(storedStringOrNumberSchema, loadedSettings.rvzBlockSize);
    if (rvzBlockSize !== undefined)
      settings.rvzBlockSize = normalizePositiveIntegerField(
        "rvzBlockSize",
        rvzBlockSize,
        settings.rvzBlockSize,
        settings,
      );

    const sevenZipCodec = readStoredField(storedStringSchema, loadedSettings.sevenZipCodec);
    if (sevenZipCodec !== undefined)
      settings.sevenZipCodec = normalizeStoredCodecSetting(
        "sevenZipCodec",
        sevenZipCodec,
        settings.sevenZipCodec,
        true,
      );

    const zipCodec = readStoredField(storedStringSchema, loadedSettings.zipCodec);
    if (zipCodec !== undefined)
      settings.zipCodec = normalizeStoredCodecSetting("zipCodec", zipCodec, settings.zipCodec, true);

    const threads = readStoredField(storedStringOrNumberSchema, loadedSettings.threads);
    if (threads !== undefined)
      settings.threads = normalizeStoredThreads(threads, resolveThreadsNumericFallback(settings.threads));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    resetStoredSettings(storageObject, message);
  }

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
    if (fieldKey === "defaultCompression") {
      (storedSettings.common as Record<string, unknown>)[fieldKey] = value;
      return;
    }
    if (
      fieldKey === "accent" ||
      fieldKey === "betaToolsEnabled" ||
      fieldKey === "onboardingEnabled" ||
      fieldKey === "language" ||
      fieldKey === "logLevel"
    ) {
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
    if (fieldKey === "requireInputChecksumMatch") {
      storedSettings.apply = {
        ...storedSettings.apply,
        validation: { ...storedSettings.apply?.validation, [fieldKey]: value },
      };
      return;
    }
    if (fieldKey === "bundlePackage" || fieldKey === "postApplyRomBehavior") {
      storedSettings.apply = {
        ...storedSettings.apply,
        output: { ...storedSettings.apply?.output, [fieldKey]: value },
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
    Object.keys(storedSettings.apply?.output || {}).length > 0 ||
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

  for (const fieldKey of ALWAYS_VALIDATE_CHOICE_FIELDS)
    assignSetting(validation.settings, fieldKey, validateMetadataChoiceField(fieldKey, rawDraft, validation));
  applyBooleanFields(rawDraft, validation.settings, BOOLEAN_SETTINGS_FIELDS);
  validation.settings.requireInputChecksumMatch =
    readStoredField(storedBooleanSchema, rawDraft.requireInputChecksumMatch) !== false;

  for (const fieldKey of FORMAT_CODEC_FIELDS)
    assignSetting(
      validation.settings,
      fieldKey,
      validateConditionalCodecField(fieldKey, rawDraft, validation, settings),
    );
  validation.settings.rvzBlockSize = validateConditionalPositiveIntegerField(
    "rvzBlockSize",
    rawDraft,
    validation,
    settings,
  );
  validation.settings.threads = normalizeThreadsSetting(rawDraft.threads, validation);

  return validation;
};

export {
  getDefaultSettings,
  loadSettings,
  SETTINGS_STORAGE_VERSION,
  serializeSettingsForStorage,
  validateSettingsDraft,
};
