import * as v from "valibot";
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
  SETTINGS_LEVEL_OVERRIDE_FIELDS,
} from "./settings-metadata.ts";

const logger = createLogger("settings");

const SETTINGS_STORAGE_VERSION = 5;

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
const BOOLEAN_SETTINGS_FIELDS = ["betaToolsEnabled", "fixChecksum"] as const satisfies readonly SettingsFieldKey[];
const ALWAYS_VALIDATE_CHOICE_FIELDS = [
  "defaultCompression",
  "language",
  "logLevel",
  "manifestPackage",
  "compressionProfile",
] as const satisfies readonly SettingsFieldKey[];
const CHD_CODEC_FIELDS = ["chdCreateCdCodecs", "chdCreateDvdCodecs"] as const satisfies readonly SettingsFieldKey[];
const SINGLE_CODEC_FIELDS = ["rvzCodec", "sevenZipCodec", "zipCodec"] as const satisfies readonly SettingsFieldKey[];
const FORMAT_CODEC_FIELDS = [
  ...SINGLE_CODEC_FIELDS,
  ...CHD_CODEC_FIELDS,
] as const satisfies readonly SettingsFieldKey[];
const isLevelOverrideField = (fieldKey: SettingsFieldKey): boolean =>
  (SETTINGS_LEVEL_OVERRIDE_FIELDS as readonly SettingsFieldKey[]).includes(fieldKey);
const isSingleCodecField = (fieldKey: SettingsFieldKey): boolean =>
  (SINGLE_CODEC_FIELDS as readonly SettingsFieldKey[]).includes(fieldKey);

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
    return normalizeValidatedCodecSetting(fieldKey, parsedValue, allowLevels, validCodecs);
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
  const parsedValue = v.safeParse(storedStringOrNumberSchema, value);
  try {
    return parseIntegerInRange(parsedValue.success ? parsedValue.output : value, {
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
    chdCreateCdCodecs: compression.chdCreateCdCodecs,
    chdCreateDvdCodecs: compression.chdCreateDvdCodecs,
    compressionProfile: compression.profile,
    defaultCompression: commonSettings.defaultCompression,
    fixChecksum: patch.fixChecksum,
    language: commonSettings.language,
    logLevel: commonSettings.logLevel,
    manifestPackage: isRecord(applySettings.output) ? applySettings.output.manifestPackage : undefined,
    requireInputChecksumMatch: validation.requireInputChecksumMatch,
    rvzBlockSize: compression.rvzBlockSize,
    rvzCodec: compression.rvzCodec,
    rvzCompressionLevel: compression.rvzCompressionLevel,
    sevenZipCodec: compression.sevenZipCodec,
    sevenZipLevel: compression.sevenZipLevel,
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

    const manifestPackage = readStoredField(storedStringSchema, loadedSettings.manifestPackage);
    if (manifestPackage !== undefined)
      settings.manifestPackage = normalizeChoiceField("manifestPackage", manifestPackage, settings.manifestPackage);

    const betaToolsEnabled = readStoredField(storedBooleanSchema, loadedSettings.betaToolsEnabled);
    if (betaToolsEnabled !== undefined) settings.betaToolsEnabled = betaToolsEnabled;

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

    const workerThreads = readStoredField(storedStringOrNumberSchema, loadedSettings.workerThreads);
    if (workerThreads !== undefined)
      settings.workerThreads = normalizeStoredWorkerThreads(
        workerThreads,
        resolveWorkerThreadsNumericFallback(settings.workerThreads),
      );
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
    if (fieldKey === "betaToolsEnabled" || fieldKey === "language" || fieldKey === "logLevel") {
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
    if (fieldKey === "manifestPackage") {
      storedSettings.apply = {
        ...storedSettings.apply,
        output: { ...storedSettings.apply?.output, manifestPackage: value },
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
    if (isLevelOverrideField(fieldKey)) continue;
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
  applyDefaultFields(validation.settings, SETTINGS_LEVEL_OVERRIDE_FIELDS);
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
      compressionProfile: settings.compressionProfile,
      defaultCompression: settings.defaultCompression,
      fixChecksum: settings.fixChecksum,
      language: settings.language,
      logLevel: settings.logLevel,
      manifestPackage: settings.manifestPackage,
      requireInputChecksumMatch: settings.requireInputChecksumMatch !== false,
      rvzBlockSize: settings.rvzBlockSize,
      rvzCodec: compressionLevels.rvzCodec,
      rvzCompressionLevel: compressionLevels.rvzCompressionLevel,
      sevenZipCodec: compressionLevels.sevenZipCodec,
      sevenZipLevel: compressionLevels.sevenZipLevel,
      workerThreads: settings.workerThreads,
      z3dsCompressionLevel: compressionLevels.z3dsCompressionLevel,
      zipCodec: compressionLevels.zipCodec,
      zipLevel: compressionLevels.zipLevel,
    },
    extraSettings || {},
  );
};

export {
  buildSettingsForWebapp,
  getDefaultSettings,
  loadSettings,
  SETTINGS_STORAGE_VERSION,
  serializeSettingsForStorage,
  validateSettingsDraft,
};
