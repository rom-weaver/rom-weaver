import type { PostApplyRomBehavior } from "../../types/settings.ts";

type PostApplyAutomaticAction = "download" | "test" | null;

type PostApplyRomBehaviorOption = {
  automaticAction: PostApplyAutomaticAction;
  hideDownload?: boolean;
  hideTest?: boolean;
  label: string;
  value: PostApplyRomBehavior;
};

const DEFAULT_POST_APPLY_ROM_BEHAVIOR_OPTION: PostApplyRomBehaviorOption = {
  automaticAction: "download",
  label: "Download & Show Test (Default)",
  value: "download-show-test",
};

/**
 * What a finished apply does on its own. Shared because both the Settings
 * dialog (`webapp/`) and the embeddable Apply form (`public/react/`) offer the
 * same choice, and `public/react` must not import from `webapp/`.
 */
const POST_APPLY_ROM_BEHAVIOR_OPTIONS: readonly PostApplyRomBehaviorOption[] = [
  DEFAULT_POST_APPLY_ROM_BEHAVIOR_OPTION,
  {
    automaticAction: null,
    label: "Show Download & Show Test",
    value: "show-download-show-test",
  },
  {
    automaticAction: "test",
    label: "Show Download & Test",
    value: "show-download-test",
  },
  {
    automaticAction: null,
    hideTest: true,
    label: "Show Download Only",
    value: "show-download",
  },
  {
    automaticAction: null,
    hideDownload: true,
    label: "Show Test Only",
    value: "show-test",
  },
  {
    automaticAction: "test",
    hideDownload: true,
    hideTest: true,
    label: "Test Only",
    value: "test",
  },
  {
    automaticAction: "download",
    hideDownload: true,
    hideTest: true,
    label: "Download Only",
    value: "download",
  },
];

const postApplyRomBehaviorOption = (value: unknown): PostApplyRomBehaviorOption =>
  POST_APPLY_ROM_BEHAVIOR_OPTIONS.find((option) => option.value === value) || DEFAULT_POST_APPLY_ROM_BEHAVIOR_OPTION;

const normalizePostApplyRomBehavior = (value: unknown): PostApplyRomBehavior => {
  const current = POST_APPLY_ROM_BEHAVIOR_OPTIONS.find((option) => option.value === value)?.value;
  if (current) return current;
  if (value === "auto-test") return "show-download-test";
  if (value === "none") return "show-download-show-test";
  return DEFAULT_POST_APPLY_ROM_BEHAVIOR_OPTION.value;
};

const migrateLegacyPostApplyRomBehavior = (value: unknown, showTestButton = true): PostApplyRomBehavior => {
  if (value === "auto-test") return "show-download-test";
  if (value === "none") return showTestButton ? "show-download-show-test" : "show-download";
  if (value === "auto-test-download") return showTestButton ? "download-show-test" : "download";
  return showTestButton ? "download-show-test" : "download";
};

const postApplyRomBehaviorWithDownloadFallback = (value: unknown): PostApplyRomBehavior => {
  const option = postApplyRomBehaviorOption(normalizePostApplyRomBehavior(value));
  if (!option.hideDownload) return option.value;
  return option.hideTest ? "show-download" : "show-download-show-test";
};

export {
  migrateLegacyPostApplyRomBehavior,
  normalizePostApplyRomBehavior,
  postApplyRomBehaviorOption,
  postApplyRomBehaviorWithDownloadFallback,
  POST_APPLY_ROM_BEHAVIOR_OPTIONS,
};
