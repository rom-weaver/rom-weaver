import { X } from "lucide-react";
import type { ReactNode } from "react";
import { join } from "./shell-common.tsx";
import type { WorkflowTab } from "./shell-nav.tsx";
import type { OfflineWarmupDisplayProgress, RuntimeState } from "./runtime-status.tsx";
import {
  RUNTIME_MESSAGES,
  RUNTIME_STATES,
  RuntimeGlyph,
  describeWarmupUnit,
  installingRuntimeLabel,
  offlineWarmupPercent,
  resolveRuntimeState,
} from "./runtime-status.tsx";
import { Masthead } from "./masthead.tsx";

const readPwaState = () => {
  const displayModes = ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"];
  const displayModeMatches =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? displayModes.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches)
      : false;
  const iosStandalone =
    typeof navigator !== "undefined" && (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return displayModeMatches || iosStandalone;
};

/** One motion gate for every programmatic scroll and animation in the chrome. */
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** CSS-only slide reveal wrapper (banners). JS only flips hidden + is-open. */
const Reveal = ({ open, children }: { open: boolean; children: ReactNode }) => (
  <div className={join("reveal", open && "is-open")} hidden={!open}>
    {children}
  </div>
);

const BannerDismissButton = ({ label, onDismiss }: { label: string; onDismiss: () => void }) => (
  <button aria-label={label} className="banner-x" onClick={onDismiss} title={label} type="button">
    <X aria-hidden="true" />
  </button>
);

export type { OfflineWarmupDisplayProgress, RuntimeState, WorkflowTab };
export {
  BannerDismissButton,
  describeWarmupUnit,
  installingRuntimeLabel,
  Masthead,
  offlineWarmupPercent,
  prefersReducedMotion,
  readPwaState,
  Reveal,
  RUNTIME_MESSAGES,
  resolveRuntimeState,
  RUNTIME_STATES,
  RuntimeGlyph,
};
