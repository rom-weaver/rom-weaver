import type { ApplyPatchFormSettings } from "./patcher-form.ts";

const getLegacyCompressionWorkerThreads = (settings: ApplyPatchFormSettings): number | string | undefined => {
  const legacyThreads = (settings as { compression?: { workerThreads?: unknown } }).compression?.workerThreads;
  if (typeof legacyThreads === "number" || typeof legacyThreads === "string") return legacyThreads;
  return undefined;
};

const createStageSettingsKey = ({
  containerInputsEnabled,
  settings,
  workerThreads,
}: {
  containerInputsEnabled: boolean;
  settings: ApplyPatchFormSettings;
  workerThreads?: number | string;
}) =>
  JSON.stringify(
    {
      input: {
        ...settings.input,
        containerInputsEnabled,
      },
      limits: settings.limits,
      workers: {
        ...settings.workers,
        threads: settings.workers?.threads ?? getLegacyCompressionWorkerThreads(settings) ?? workerThreads,
      },
    },
    (_key, value) => (typeof value === "function" ? "[function]" : value),
  );

export { createStageSettingsKey, getLegacyCompressionWorkerThreads };
