import { createContext, useContext, useMemo } from "react";
import { createLogger } from "../../lib/logging.ts";
import type {
  ApplyPatchFormSettings,
  ApplyWorkflowSettings,
  CreatePatchFormSettings,
  CreateWorkflowSettings,
  RomWeaverReactSettings,
  RomWeaverSettingsProviderProps,
} from "./public-types.ts";

type RomWeaverSettingsContextValue = {
  assetBaseUrl?: string;
  settings: Partial<RomWeaverReactSettings>;
};

const RomWeaverSettingsContext = createContext<RomWeaverSettingsContextValue>({ settings: {} });
const APPLY_OUTPUT_COMPRESSION_VALUES = new Set(["auto", "7z", "chd", "none", "rvz", "z3ds", "zip"]);
const CREATE_OUTPUT_COMPRESSION_VALUES = new Set(["7z", "none", "zip"]);
const DEFAULT_COMPRESSION_VALUES = new Set([
  "auto",
  "7z/special",
  "zip/special",
  "special only",
  "7z only",
  "zip only",
  "none",
]);
type SettingsRecord = Record<string, RuntimeValue | undefined>;
type DefaultCompressionMode = NonNullable<ApplyWorkflowSettings["defaultCompression"]>;
type ArchiveDefaultCompression = "7z" | "none" | "zip";
type OutputContainerSettings = NonNullable<NonNullable<ApplyWorkflowSettings["output"]>["container"]>;
type ApplyCompatibilitySettings = NonNullable<ApplyWorkflowSettings["compatibility"]>;
type ApplyLoggingSettings = NonNullable<ApplyWorkflowSettings["logging"]>;
type ApplyValidationSettings = NonNullable<ApplyWorkflowSettings["validation"]>;
type WorkflowLogRecord = {
  details?: Record<string, unknown>;
  level?: string;
  message?: string;
  namespace?: string;
};

const workflowLoggerByNamespace = new Map<string, ReturnType<typeof createLogger>>();

const getWorkflowLogger = (namespace: string) => {
  const key = namespace || "runtime:rom-weaver";
  const existing = workflowLoggerByNamespace.get(key);
  if (existing) return existing;
  const created = createLogger(key);
  workflowLoggerByNamespace.set(key, created);
  return created;
};

const emitDefaultWorkflowLog = (record: WorkflowLogRecord) => {
  const level = String(record?.level || "")
    .trim()
    .toLowerCase();
  const message = String(record?.message || "").trim();
  if (!message) return;
  const namespace = String(record?.namespace || "").trim() || "runtime:rom-weaver";
  const details =
    record?.details && typeof record.details === "object" && !Array.isArray(record.details) ? record.details : {};
  const logger = getWorkflowLogger(namespace);
  if (level === "error") logger.error(message, details);
  else if (level === "warn") logger.warn(message, details);
  else if (level === "info") logger.info(message, details);
  else if (level === "debug") logger.debug(message, details);
  else logger.trace(message, details);
};

function RomWeaverSettingsProvider({ children, settings = {}, assetBaseUrl }: RomWeaverSettingsProviderProps) {
  const normalizedAssetBaseUrl = typeof assetBaseUrl === "string" && assetBaseUrl.trim() ? assetBaseUrl.trim() : "";
  const value = useMemo(
    () => ({
      ...(normalizedAssetBaseUrl ? { assetBaseUrl: normalizedAssetBaseUrl } : {}),
      settings: { ...settings },
    }),
    [normalizedAssetBaseUrl, settings],
  );
  return <RomWeaverSettingsContext.Provider value={value}>{children}</RomWeaverSettingsContext.Provider>;
}

const useRomWeaverSettings = () => useContext(RomWeaverSettingsContext).settings;
const useRomWeaverAssetBaseUrl = () => useContext(RomWeaverSettingsContext).assetBaseUrl;

const useApplySettings = () => {
  const settings = useRomWeaverSettings();
  return useMemo(() => toApplyWorkflowSettings(settings as ApplyPatchFormSettings), [settings]);
};

const normalizeLegacyDefaultArchive = (value: RuntimeValue): ArchiveDefaultCompression => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "none") return "none";
  return normalized === "7z" ? "7z" : "zip";
};

const defaultCompressionFromLegacySettings = (settings: SettingsRecord): DefaultCompressionMode => {
  const defaultArchive = normalizeLegacyDefaultArchive(settings.defaultArchive);
  const specialCompression = typeof settings.specialCompression === "boolean" ? settings.specialCompression : true;
  if (!specialCompression) {
    if (defaultArchive === "7z") return "7z only";
    if (defaultArchive === "none") return "none";
    return "zip only";
  }
  if (defaultArchive === "7z") return "7z/special";
  if (defaultArchive === "none") return "special only";
  return "zip/special";
};

const normalizeDefaultCompression = (value: RuntimeValue, fallback: DefaultCompressionMode = "auto") => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return DEFAULT_COMPRESSION_VALUES.has(normalized) ? (normalized as DefaultCompressionMode) : fallback;
};

const getDefaultCompressionMode = (settings: RuntimeValue | undefined): DefaultCompressionMode => {
  const source = toRecord(settings);
  if (source.defaultCompression !== undefined) return normalizeDefaultCompression(source.defaultCompression);
  return defaultCompressionFromLegacySettings(source);
};

const getDefaultCompressionArchive = (mode: DefaultCompressionMode): ArchiveDefaultCompression => {
  if (mode === "7z/special" || mode === "7z only") return "7z";
  if (mode === "none" || mode === "special only") return "none";
  return "zip";
};

const allowsDefaultCompressionSpecial = (mode: DefaultCompressionMode): boolean =>
  mode === "auto" || mode === "7z/special" || mode === "zip/special" || mode === "special only";

const normalizeCreateOutputCompression = (
  value: RuntimeValue,
  fallbackMode: DefaultCompressionMode,
): NonNullable<CreateWorkflowSettings["output"]>["compression"] => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (CREATE_OUTPUT_COMPRESSION_VALUES.has(normalized))
    return normalized as NonNullable<CreateWorkflowSettings["output"]>["compression"];
  return getDefaultCompressionArchive(fallbackMode);
};

const isRecord = (value: RuntimeValue | undefined): value is SettingsRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

const toRecord = (value: RuntimeValue | undefined): SettingsRecord => (isRecord(value) ? value : {});

const readFirstDefined = (...values: Array<RuntimeValue | undefined>) => {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

const normalizeApplyOutputCompression = (
  value: RuntimeValue,
): NonNullable<ApplyWorkflowSettings["output"]>["compression"] | undefined => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (APPLY_OUTPUT_COMPRESSION_VALUES.has(normalized))
    return normalized as NonNullable<ApplyWorkflowSettings["output"]>["compression"];
  return undefined;
};

const normalizeSevenZipCodec = (_value: RuntimeValue): OutputContainerSettings["sevenZipCodec"] => "lzma2";

const getNormalizedWorkflowSettings = (
  settings: ApplyPatchFormSettings | CreatePatchFormSettings,
  workerThreads?: RuntimeValue,
) => {
  const source = toRecord(settings as RuntimeValue);
  const output = toRecord(source.output);
  const outputContainer = toRecord(output.container);
  const compressionSettings = toRecord(source.compression);
  const workers = toRecord(source.workers);
  const compatibility = toRecord(source.compatibility);
  const validation = toRecord(source.validation);
  const logging = toRecord(source.logging);
  const configuredLogSink = typeof logging.sink === "function" ? logging.sink : undefined;

  return {
    compatibility: {
      ...compatibility,
      fixChecksum: readFirstDefined(compatibility.fixChecksum, source.fixChecksum) as
        | ApplyCompatibilitySettings["fixChecksum"]
        | undefined,
    },
    logging: {
      ...logging,
      level: readFirstDefined(logging.level, source.logLevel) as ApplyLoggingSettings["level"] | undefined,
      sink: (configuredLogSink || emitDefaultWorkflowLog) as ApplyLoggingSettings["sink"] | undefined,
    },
    output: {
      ...output,
      compression: readFirstDefined(output.compression, source.compressionFormat, compressionSettings.format),
      container: {
        ...outputContainer,
        profile: readFirstDefined(outputContainer.profile, source.compressionProfile, compressionSettings.profile) as
          | OutputContainerSettings["profile"]
          | undefined,
        sevenZipCodec: normalizeSevenZipCodec(
          readFirstDefined(outputContainer.sevenZipCodec, source.sevenZipCodec, compressionSettings.sevenZipCodec),
        ),
        sevenZipLevel: readFirstDefined(
          outputContainer.sevenZipLevel,
          source.sevenZipLevel,
          compressionSettings.sevenZipLevel,
        ) as OutputContainerSettings["sevenZipLevel"] | undefined,
        z3dsCompressionLevel: readFirstDefined(
          outputContainer.z3dsCompressionLevel,
          source.z3dsCompressionLevel,
          compressionSettings.z3dsCompressionLevel,
        ) as OutputContainerSettings["z3dsCompressionLevel"] | undefined,
        zipCodec: readFirstDefined(outputContainer.zipCodec, source.zipCodec, compressionSettings.zipCodec) as
          | OutputContainerSettings["zipCodec"]
          | undefined,
        zipLevel: readFirstDefined(outputContainer.zipLevel, source.zipLevel, compressionSettings.zipLevel) as
          | OutputContainerSettings["zipLevel"]
          | undefined,
      },
    },
    validation: {
      ...validation,
      requireInputChecksumMatch: readFirstDefined(
        validation.requireInputChecksumMatch,
        source.requireInputChecksumMatch,
      ) as ApplyValidationSettings["requireInputChecksumMatch"] | undefined,
      requireOutputChecksumMatch: readFirstDefined(
        validation.requireOutputChecksumMatch,
        source.requireOutputChecksumMatch,
      ) as ApplyValidationSettings["requireOutputChecksumMatch"] | undefined,
    },
    workers: {
      ...workers,
      threads: readFirstDefined(
        workers.threads,
        source.workerThreads,
        compressionSettings.workerThreads,
        workerThreads,
      ),
    },
  };
};

const toApplyWorkflowSettings = (
  settings: ApplyPatchFormSettings,
  workerThreads?: RuntimeValue,
): ApplyWorkflowSettings => {
  const normalized = getNormalizedWorkflowSettings(settings, workerThreads);
  const defaultCompression = getDefaultCompressionMode(settings as RuntimeValue);
  return {
    ...settings,
    compatibility: normalized.compatibility,
    defaultCompression,
    logging: normalized.logging,
    output: {
      ...normalized.output,
      compression: normalizeApplyOutputCompression(normalized.output.compression),
    },
    validation: normalized.validation,
    workers: normalized.workers,
  };
};

const toCreateWorkflowSettings = (
  settings: CreatePatchFormSettings,
  outputName: string,
  workerThreads?: RuntimeValue,
): CreateWorkflowSettings => {
  const normalized = getNormalizedWorkflowSettings(settings, workerThreads);
  const defaultCompression = getDefaultCompressionMode(settings as RuntimeValue);
  return {
    ...settings,
    defaultCompression,
    logging: normalized.logging,
    output: {
      ...normalized.output,
      compression: normalizeCreateOutputCompression(normalized.output.compression, defaultCompression),
      outputName,
    },
    workers: normalized.workers,
  };
};

const getCreateSettingsOutputName = (settings: CreatePatchFormSettings) => settings.output?.outputName || "";

const useCreateSettings = () => {
  const settings = useRomWeaverSettings();
  return useMemo<CreatePatchFormSettings>(
    () =>
      toCreateWorkflowSettings(
        settings as CreatePatchFormSettings,
        getCreateSettingsOutputName(settings as CreatePatchFormSettings),
      ),
    [settings],
  );
};

export {
  allowsDefaultCompressionSpecial,
  getCreateSettingsOutputName,
  getDefaultCompressionArchive,
  getDefaultCompressionMode,
  normalizeCreateOutputCompression,
  normalizeDefaultCompression,
  RomWeaverSettingsProvider,
  toApplyWorkflowSettings,
  toCreateWorkflowSettings,
  useApplySettings,
  useCreateSettings,
  useRomWeaverAssetBaseUrl,
  useRomWeaverSettings,
};
