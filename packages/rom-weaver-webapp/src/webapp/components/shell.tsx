import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
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

/** Update-ready banner inside a {@link Reveal}. */
const UpdateBanner = ({
  open,
  title,
  onReload,
  onDismiss,
  onOpenWhatsNew,
}: {
  open: boolean;
  title: string;
  onReload: () => void;
  onDismiss: () => void;
  onOpenWhatsNew: () => void;
}) => {
  const localizer = useUiLocalizer();
  return (
    <Reveal open={open}>
      <div className="updates update-ready" role="status">
        <span aria-hidden="true" className="updates-pulse" />
        <span className="updates-text">
          <b>{localizer.message("ui.update.ready")}</b>{" "}
          <button
            aria-label={`${localizer.message("ui.update.whatsNew")}: ${title}`}
            className="updates-ver mono"
            onClick={onOpenWhatsNew}
            type="button"
          >
            {localizer.message("ui.update.whatsNew")}
          </button>
        </span>
        <button className="btn slim primary" onClick={onReload} type="button">
          {localizer.message("ui.update.reload")}
        </button>
        <BannerDismissButton label={localizer.message("ui.common.dismiss")} onDismiss={onDismiss} />
      </div>
    </Reveal>
  );
};

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
  UpdateBanner,
};
