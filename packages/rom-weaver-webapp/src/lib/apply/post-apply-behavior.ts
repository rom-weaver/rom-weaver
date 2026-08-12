import type { PostApplyRomBehavior } from "../../types/settings.ts";

type PostApplyAutomaticAction = "download" | "test" | null;

type PostApplyRomBehaviorOption = {
  automaticAction: PostApplyAutomaticAction;
  label: string;
  showDownload: boolean;
  showTest: boolean;
  value: PostApplyRomBehavior;
};

const DEFAULT_POST_APPLY_ROM_BEHAVIOR_OPTION: PostApplyRomBehaviorOption = {
  automaticAction: "download",
  label: "Download & Show Test (Default)",
  showDownload: false,
  showTest: true,
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
    showDownload: true,
    showTest: true,
    value: "show-download-show-test",
  },
  {
    automaticAction: "test",
    label: "Show Download & Test",
    showDownload: true,
    showTest: false,
    value: "show-download-test",
  },
  {
    automaticAction: null,
    label: "Show Download Only",
    showDownload: true,
    showTest: false,
    value: "show-download",
  },
  {
    automaticAction: null,
    label: "Show Test Only",
    showDownload: false,
    showTest: true,
    value: "show-test",
  },
  {
    automaticAction: "test",
    label: "Test Only",
    showDownload: false,
    showTest: false,
    value: "test",
  },
  {
    automaticAction: "download",
    label: "Download Only",
    showDownload: false,
    showTest: false,
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
  if (option.showDownload) return option.value;
  return option.showTest ? "show-download-show-test" : "show-download";
};

export {
  migrateLegacyPostApplyRomBehavior,
  normalizePostApplyRomBehavior,
  postApplyRomBehaviorOption,
  postApplyRomBehaviorWithDownloadFallback,
  POST_APPLY_ROM_BEHAVIOR_OPTIONS,
};
