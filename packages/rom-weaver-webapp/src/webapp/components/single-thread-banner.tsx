import { useState } from "react";
import { Notice } from "../../public/react/components/ds/feedback.tsx";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { getServiceWorkerBootReason } from "../pwa/service-worker-boot-gate.ts";

const DISMISS_KEY = "rom-weaver-single-thread-banner-dismissed";

/**
 * Without cross-origin isolation there is no SharedArrayBuffer, so the wasm
 * pool falls back to one thread and every run takes several times longer. The
 * gate used to record that in a debug log only, leaving the slowdown looking
 * like rom-weaver being slow.
 */
const isDegradedBoot = (): boolean => {
  if (typeof window === "undefined") return false;
  if (window.crossOriginIsolated === true) return false;
  // "" means the gate has not decided yet - say nothing rather than guess.
  return getServiceWorkerBootReason() !== "";
};

const wasDismissed = (): boolean => {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
};

const SingleThreadBanner = ({ onOpenStatus }: { onOpenStatus: () => void }) => {
  const localizer = useUiLocalizer();
  const [dismissed, setDismissed] = useState(wasDismissed);
  if (dismissed || !isDegradedBoot()) return null;
  return (
    <Notice
      actions={
        <button className="btn ghost slim" onClick={onOpenStatus} type="button">
          {localizer.message("ui.log.tabStatus")}
        </button>
      }
      className="single-thread-banner"
      id="rom-weaver-single-thread-banner"
      level="warn"
      onDismiss={() => {
        setDismissed(true);
        try {
          sessionStorage.setItem(DISMISS_KEY, "1");
        } catch {
          // session storage is best-effort
        }
      }}
    >
      {localizer.message("ui.env.singleThreaded")}
    </Notice>
  );
};

export { SingleThreadBanner };
