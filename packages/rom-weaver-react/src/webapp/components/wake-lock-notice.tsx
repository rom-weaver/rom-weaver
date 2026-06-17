import { useEffect, useRef, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { WakeLockBanner } from "./shell.tsx";

const logger = createLogger("wake-lock-notice");

const DEFAULT_WAKE_LOCK_WARNING =
  "Screen wake lock is unavailable. Keep this tab visible and prevent the device from sleeping while processing runs.";

type WakeLockSentinelLike = {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
};

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

/**
 * Holds a screen wake lock while a job runs and surfaces the loom wake-lock
 * banner: informational while the lock is held, a warning when the lock is
 * unavailable. Dismissal lasts for the current activation.
 */
function ProcessingWakeLockNotice({ active }: { active: boolean }) {
  const localizer = useUiLocalizer();
  const [warningMessage, setWarningMessage] = useState("");
  const [lockHeld, setLockHeld] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    setDismissed(false);
    const releaseSentinel = () => {
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      setLockHeld(false);
      if (!sentinel || sentinel.released) return;
      void sentinel.release().catch(() => undefined);
    };
    if (!active) {
      setWarningMessage("");
      releaseSentinel();
      return;
    }
    if (typeof document === "undefined" || typeof navigator === "undefined") return;
    const wakeLockNavigator = navigator as NavigatorWithWakeLock;
    if (!wakeLockNavigator.wakeLock?.request) {
      logger.trace("Wake lock API unavailable");
      setWarningMessage(DEFAULT_WAKE_LOCK_WARNING);
      return;
    }

    let disposed = false;
    const handleRelease = () => {
      sentinelRef.current = null;
      setLockHeld(false);
      if (disposed || !active) return;
      if (document.visibilityState === "visible") void acquireWakeLock();
      else setWarningMessage(DEFAULT_WAKE_LOCK_WARNING);
    };
    const acquireWakeLock = async () => {
      if (disposed || sentinelRef.current || document.visibilityState === "hidden") return;
      try {
        const sentinel = await wakeLockNavigator.wakeLock.request("screen");
        if (disposed) {
          void sentinel.release().catch(() => undefined);
          return;
        }
        logger.trace("Wake lock acquired");
        sentinelRef.current = sentinel;
        setLockHeld(true);
        setWarningMessage("");
        sentinel.addEventListener?.("release", handleRelease);
      } catch (_err) {
        setWarningMessage(DEFAULT_WAKE_LOCK_WARNING);
      }
    };
    const handleVisibilityChange = () => {
      if (!active) return;
      if (document.visibilityState === "visible") {
        void acquireWakeLock();
        return;
      }
      releaseSentinel();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void acquireWakeLock();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      releaseSentinel();
    };
  }, [active]);

  const open = active && !dismissed && (!!warningMessage || lockHeld);
  return (
    <WakeLockBanner onDismiss={() => setDismissed(true)} open={open}>
      {warningMessage || localizer.message("ui.wakelock.text")}
    </WakeLockBanner>
  );
}

export { ProcessingWakeLockNotice };
