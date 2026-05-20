import { createContext, useContext, useMemo } from "react";
import type {
  ApplyPatchFormSettings,
  ApplyWorkflowSettings,
  RomWeaverReactSettings,
  RomWeaverSettingsProviderProps,
} from "./public-types.ts";

type RomWeaverSettingsContextValue = {
  assetBaseUrl?: string;
  settings: Partial<RomWeaverReactSettings>;
};

const RomWeaverSettingsContext = createContext<RomWeaverSettingsContextValue>({ settings: {} });
const APPLY_OUTPUT_COMPRESSION_VALUES = new Set(["auto", "7z", "chd", "none", "rvz", "z3ds", "zip"]);
type SettingsRecord = Record<string, RuntimeValue | undefined>;
type OutputContainerSettings = NonNullable<NonNullable<ApplyWorkflowSettings["output"]>["container"]>;
type ApplyCompatibilitySettings = NonNullable<ApplyWorkflowSettings["compatibility"]>;
type ApplyLoggingSettings = NonNullable<ApplyWorkflowSettings["logging"]>;
type ApplyValidationSettings = NonNullable<ApplyWorkflowSettings["validation"]>;

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
  return useMemo(() => {
    const applySettings = settings as ApplyPatchFormSettings;
    return toApplyWorkflowSettings({
      ...applySettings,
      storage: {
        ...(applySettings.storage || {}),
        prefer: applySettings.storage?.prefer || "opfs",
      },
    });
  }, [settings]);
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
): NonNullable<ApplyWorkflowSettings["output"]>["compression"] => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (APPLY_OUTPUT_COMPRESSION_VALUES.has(normalized))
    return normalized as NonNullable<ApplyWorkflowSettings["output"]>["compression"];
  return "auto";
};

const normalizeSevenZipCodec = (value: RuntimeValue): OutputContainerSettings["sevenZipCodec"] =>
  String(value || "")
    .trim()
    .toLowerCase() === "zstd"
    ? "zstd"
    : "lzma2";

const getNormalizedWorkflowSettings = (settings: ApplyPatchFormSettings, workerThreads?: RuntimeValue) => {
  const source = toRecord(settings as RuntimeValue);
  const output = toRecord(source.output);
  const outputContainer = toRecord(output.container);
  const compressionSettings = toRecord(source.compression);
  const workers = toRecord(source.workers);
  const compatibility = toRecord(source.compatibility);
  const validation = toRecord(source.validation);
  const logging = toRecord(source.logging);

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
  return {
    ...settings,
    compatibility: normalized.compatibility,
    logging: normalized.logging,
    output: {
      ...normalized.output,
      compression: normalizeApplyOutputCompression(normalized.output.compression),
    },
    validation: normalized.validation,
    workers: normalized.workers,
  };
};

export {
  RomWeaverSettingsProvider,
  toApplyWorkflowSettings,
  useApplySettings,
  useRomWeaverAssetBaseUrl,
  useRomWeaverSettings,
};
