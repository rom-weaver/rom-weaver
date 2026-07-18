import type { ApplyPatchFormSettings } from "./patcher-form.ts";

const getLegacyCompressionThreads = (settings: ApplyPatchFormSettings): number | string | undefined => {
  const legacyThreads = (settings as { compression?: { workerThreads?: unknown } }).compression?.workerThreads;
  if (typeof legacyThreads === "number" || typeof legacyThreads === "string") return legacyThreads;
  return undefined;
};

const createStageSettingsKey = ({
  containerInputsEnabled,
  settings,
  threads,
}: {
  containerInputsEnabled?: boolean;
  settings: ApplyPatchFormSettings;
  threads?: number | string;
}) => {
  const input = { ...settings.input };
  if (containerInputsEnabled !== undefined) input.containerInputsEnabled = containerInputsEnabled;
  return JSON.stringify(
    {
      input,
      workers: {
        ...settings.workers,
        threads: settings.workers?.threads ?? getLegacyCompressionThreads(settings) ?? threads,
      },
    },
    (_key, value) => (typeof value === "function" ? "[function]" : value),
  );
};

export { createStageSettingsKey, getLegacyCompressionThreads };
