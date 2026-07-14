import { createContext, useContext, useMemo } from "react";
import { resolveCompressionLevels } from "../../lib/compression/compression-settings.ts";
import { createLogger } from "../../lib/logging.ts";
import { createBrowserLocalizer, type Localizer } from "../../presentation/localization/index.ts";
import { ROM_WEAVER_CREATE_CONTAINER_FORMATS } from "../../wasm/generated/rom-weaver-format-metadata.ts";
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
const APPLY_OUTPUT_COMPRESSION_VALUES = new Set(["auto", ...ROM_WEAVER_CREATE_CONTAINER_FORMATS, "none"]);
const CREATE_OUTPUT_COMPRESSION_VALUES = new Set([
  ...ROM_WEAVER_CREATE_CONTAINER_FORMATS.filter((format) => format === "7z" || format === "zip"),
  "none",
]);
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

/**
 * Localizer for the UI chrome (the `ui.*` catalog namespace), following the
 * Language setting and falling back to the browser locale when unset.
 */
const useUiLocalizer = (): Localizer => {
  const settings = useRomWeaverSettings();
  const language =
    typeof (settings as { language?: unknown }).language === "string"
      ? ((settings as { language?: string }).language as string)
      : undefined;
  return useMemo(() => createBrowserLocalizer(language), [language]);
};

const normalizeDefaultCompression = (value: RuntimeValue, fallback: DefaultCompressionMode = "auto") => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return DEFAULT_COMPRESSION_VALUES.has(normalized) ? (normalized as DefaultCompressionMode) : fallback;
};

const getDefaultCompressionMode = (settings: RuntimeValue | undefined): DefaultCompressionMode => {
  const source = toRecord(settings);
  return normalizeDefaultCompression(source.defaultCompression);
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

const getNormalizedWorkflowSettings = (
  settings: ApplyPatchFormSettings | CreatePatchFormSettings,
  workerThreads?: RuntimeValue,
) => {
  const source = toRecord(settings as RuntimeValue);
  const output = toRecord(source.output);
  const outputContainer = toRecord(output.container);
  const workers = toRecord(source.workers);
  const compatibility = toRecord(source.compatibility);
  const validation = toRecord(source.validation);
  const logging = toRecord(source.logging);
  const configuredLogSink = typeof logging.sink === "function" ? logging.sink : undefined;
  const hasFlatProfile = source.compressionProfile !== undefined;
  const hasFlatSevenZipCodec = source.sevenZipCodec !== undefined;
  const hasFlatRvzCodec = source.rvzCodec !== undefined;
  const hasFlatZipCodec = source.zipCodec !== undefined;
  const compressionProfile = readFirstDefined(source.compressionProfile, outputContainer.profile);
  const sevenZipCodec = readFirstDefined(source.sevenZipCodec, outputContainer.sevenZipCodec);
  const sevenZipLevel = readFirstDefined(
    source.sevenZipLevel,
    hasFlatProfile || hasFlatSevenZipCodec ? undefined : outputContainer.sevenZipLevel,
  );
  const rvzCodec = readFirstDefined(source.rvzCodec, outputContainer.rvzCodec);
  const rvzCompressionLevel = readFirstDefined(
    source.rvzCompressionLevel,
    hasFlatProfile || hasFlatRvzCodec ? undefined : outputContainer.rvzCompressionLevel,
  );
  const rvzBlockSize = readFirstDefined(source.rvzBlockSize, outputContainer.rvzBlockSize);
  const chdCreateCdCodecs = readFirstDefined(source.chdCreateCdCodecs, outputContainer.chdCreateCdCodecs);
  const chdCreateDvdCodecs = readFirstDefined(source.chdCreateDvdCodecs, outputContainer.chdCreateDvdCodecs);
  const z3dsCompressionLevel = readFirstDefined(
    source.z3dsCompressionLevel,
    hasFlatProfile ? undefined : outputContainer.z3dsCompressionLevel,
  );
  const zipCodec = readFirstDefined(source.zipCodec, outputContainer.zipCodec);
  const zipLevel = readFirstDefined(
    source.zipLevel,
    hasFlatProfile || hasFlatZipCodec ? undefined : outputContainer.zipLevel,
  );
  const compressionLevels = resolveCompressionLevels({
    compressionProfile: compressionProfile as string | null | undefined,
    rvzCodec: rvzCodec as string | null | undefined,
    rvzCompressionLevel: rvzCompressionLevel as string | number | null | undefined,
    sevenZipCodec: sevenZipCodec as string | null | undefined,
    sevenZipLevel: sevenZipLevel as string | number | null | undefined,
    z3dsCompressionLevel: z3dsCompressionLevel as string | number | "default" | null | undefined,
    zipCodec: zipCodec as string | null | undefined,
    zipLevel: zipLevel as string | number | null | undefined,
  });

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
      compression: readFirstDefined(output.compression, "auto"),
      container: {
        chdCreateCdCodecs: chdCreateCdCodecs as OutputContainerSettings["chdCreateCdCodecs"],
        chdCreateDvdCodecs: chdCreateDvdCodecs as OutputContainerSettings["chdCreateDvdCodecs"],
        chdOutputMode: "auto" as OutputContainerSettings["chdOutputMode"],
        profile: compressionLevels.compressionProfile as OutputContainerSettings["profile"],
        rvzBlockSize: rvzBlockSize as OutputContainerSettings["rvzBlockSize"],
        rvzCodec: compressionLevels.rvzCodec as OutputContainerSettings["rvzCodec"],
        rvzCompressionLevel: compressionLevels.rvzCompressionLevel as OutputContainerSettings["rvzCompressionLevel"],
        rvzScrub: false as OutputContainerSettings["rvzScrub"],
        sevenZipCodec: compressionLevels.sevenZipCodec as OutputContainerSettings["sevenZipCodec"],
        sevenZipLevel: compressionLevels.sevenZipLevel as OutputContainerSettings["sevenZipLevel"],
        z3dsCompressionLevel: compressionLevels.z3dsCompressionLevel as OutputContainerSettings["z3dsCompressionLevel"],
        zipCodec: compressionLevels.zipCodec as OutputContainerSettings["zipCodec"],
        zipLevel: compressionLevels.zipLevel as OutputContainerSettings["zipLevel"],
      },
      manifestPackage: readFirstDefined(output.manifestPackage, source.manifestPackage),
    },
    validation: {
      ...validation,
      requireInputChecksumMatch: readFirstDefined(
        validation.requireInputChecksumMatch,
        source.requireInputChecksumMatch,
      ) as ApplyValidationSettings["requireInputChecksumMatch"] | undefined,
    },
    workers: {
      ...workers,
      threads: readFirstDefined(workers.threads, source.workerThreads, workerThreads),
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
  RomWeaverSettingsProvider,
  toApplyWorkflowSettings,
  toCreateWorkflowSettings,
  useApplySettings,
  useCreateSettings,
  useRomWeaverAssetBaseUrl,
  useRomWeaverSettings,
  useUiLocalizer,
};
