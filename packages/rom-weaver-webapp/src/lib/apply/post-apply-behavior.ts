import type { PostApplyActionBehavior } from "../../types/settings.ts";

type PostApplyActionBehaviorOption = {
  automatic: boolean;
  label: string;
  value: PostApplyActionBehavior;
  visible: boolean;
};

type PostApplyBehaviorSettings = {
  postApplyDownloadBehavior: PostApplyActionBehavior;
  postApplyTestBehavior: PostApplyActionBehavior;
};

const DEFAULT_POST_APPLY_DOWNLOAD_BEHAVIOR_OPTION: PostApplyActionBehaviorOption = {
  automatic: true,
  label: "Auto Start & DL Again Button (Default)",
  value: "auto-show",
  visible: true,
};

const DEFAULT_POST_APPLY_TEST_BEHAVIOR_OPTION: PostApplyActionBehaviorOption = {
  automatic: false,
  label: "Show After Apply (Default)",
  value: "show",
  visible: true,
};

/**
 * The Settings dialog and the embeddable Apply form MUST use the same
 * post-apply options. The public React package cannot import from `webapp/`.
 */
const POST_APPLY_DOWNLOAD_BEHAVIOR_OPTIONS: readonly PostApplyActionBehaviorOption[] = [
  DEFAULT_POST_APPLY_DOWNLOAD_BEHAVIOR_OPTION,
  {
    automatic: false,
    label: "DL Again Button",
    value: "show",
    visible: true,
  },
];

const POST_APPLY_TEST_BEHAVIOR_OPTIONS: readonly PostApplyActionBehaviorOption[] = [
  DEFAULT_POST_APPLY_TEST_BEHAVIOR_OPTION,
  {
    automatic: true,
    label: "Auto Test & Show After Apply",
    value: "auto-show",
    visible: true,
  },
  {
    automatic: false,
    label: "Hide Button",
    value: "hide",
    visible: false,
  },
];

const findPostApplyActionBehaviorOption = (
  value: unknown,
  options: readonly PostApplyActionBehaviorOption[],
  fallback: PostApplyActionBehaviorOption,
): PostApplyActionBehaviorOption => options.find((option) => option.value === value) || fallback;

const postApplyDownloadBehaviorOption = (value: unknown): PostApplyActionBehaviorOption =>
  findPostApplyActionBehaviorOption(
    value,
    POST_APPLY_DOWNLOAD_BEHAVIOR_OPTIONS,
    DEFAULT_POST_APPLY_DOWNLOAD_BEHAVIOR_OPTION,
  );

const postApplyTestBehaviorOption = (value: unknown): PostApplyActionBehaviorOption =>
  findPostApplyActionBehaviorOption(value, POST_APPLY_TEST_BEHAVIOR_OPTIONS, DEFAULT_POST_APPLY_TEST_BEHAVIOR_OPTION);

const normalizePostApplyDownloadBehavior = (value: unknown): PostApplyActionBehavior => {
  if (value === "hide") return "show";
  if (value === "auto-hide") return "auto-show";
  return postApplyDownloadBehaviorOption(value).value;
};

const normalizePostApplyTestBehavior = (value: unknown): PostApplyActionBehavior => {
  if (value === "auto-hide") return "auto-show";
  return postApplyTestBehaviorOption(value).value;
};

const migrateLegacyPostApplyBehavior = (value: unknown, showTestButton = true): PostApplyBehaviorSettings => {
  const visibleTestBehavior: PostApplyActionBehavior = showTestButton ? "show" : "hide";
  const automaticTestBehavior: PostApplyActionBehavior = "auto-show";

  if (value === "auto-test" || value === "show-download-test") {
    return { postApplyDownloadBehavior: "show", postApplyTestBehavior: automaticTestBehavior };
  }
  if (value === "auto-test-download" || value === "download-test") {
    return { postApplyDownloadBehavior: "auto-show", postApplyTestBehavior: automaticTestBehavior };
  }
  if (value === "none" || value === "show-download-show-test") {
    return { postApplyDownloadBehavior: "show", postApplyTestBehavior: visibleTestBehavior };
  }
  if (value === "show-download") {
    return { postApplyDownloadBehavior: "show", postApplyTestBehavior: "hide" };
  }
  if (value === "show-test") {
    return { postApplyDownloadBehavior: "show", postApplyTestBehavior: "show" };
  }
  if (value === "test") {
    return { postApplyDownloadBehavior: "show", postApplyTestBehavior: "auto-show" };
  }
  if (value === "download") {
    return { postApplyDownloadBehavior: "auto-show", postApplyTestBehavior: "hide" };
  }
  return { postApplyDownloadBehavior: "auto-show", postApplyTestBehavior: visibleTestBehavior };
};

const postApplyDownloadBehaviorWithFallback = (value: unknown): PostApplyActionBehavior =>
  normalizePostApplyDownloadBehavior(value);

export {
  migrateLegacyPostApplyBehavior,
  normalizePostApplyDownloadBehavior,
  normalizePostApplyTestBehavior,
  postApplyDownloadBehaviorOption,
  postApplyDownloadBehaviorWithFallback,
  postApplyTestBehaviorOption,
  POST_APPLY_DOWNLOAD_BEHAVIOR_OPTIONS,
  POST_APPLY_TEST_BEHAVIOR_OPTIONS,
};
