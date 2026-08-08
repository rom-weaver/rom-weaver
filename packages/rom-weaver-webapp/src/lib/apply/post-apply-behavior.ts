import type { PostApplyRomBehavior } from "../../types/settings.ts";

/**
 * What a finished apply does on its own. Shared because both the Settings
 * dialog (`webapp/`) and the embeddable Apply form (`public/react/`) offer the
 * same choice, and `public/react` must not import from `webapp/`.
 */
const POST_APPLY_ROM_BEHAVIOR_OPTIONS: ReadonlyArray<{ label: string; value: PostApplyRomBehavior }> = [
  { label: "Download automatically", value: "auto-download" },
  { label: "Test automatically", value: "auto-test" },
  { label: "Test and download", value: "auto-test-download" },
  { label: "Do nothing", value: "none" },
];

export { POST_APPLY_ROM_BEHAVIOR_OPTIONS };
