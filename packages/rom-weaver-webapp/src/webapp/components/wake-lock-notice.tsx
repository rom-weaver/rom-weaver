import { useEffect, useRef } from "react";
import { createLogger } from "../../lib/logging.ts";

const logger = createLogger("wake-lock-notice");

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

/** Holds a screen wake lock while the page has pending work. */
function useScreenWakeLock(active: boolean) {
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    const releaseSentinel = () => {
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (!sentinel || sentinel.released) return;
      void sentinel.release().catch(() => undefined);
    };
    if (!active) {
      releaseSentinel();
      return;
    }
    if (typeof document === "undefined" || typeof navigator === "undefined") return;
    const wakeLockNavigator = navigator as NavigatorWithWakeLock;
    if (!wakeLockNavigator.wakeLock?.request) {
      logger.trace("Wake lock API unavailable");
      return;
    }

    let disposed = false;
    const handleRelease = () => {
      sentinelRef.current = null;
      if (disposed || !active) return;
      if (document.visibilityState === "visible") void acquireWakeLock();
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
        sentinel.addEventListener?.("release", handleRelease);
      } catch (error) {
        logger.trace("Wake lock request failed", {
          message: error instanceof Error ? error.message : String(error),
        });
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
}

export { useScreenWakeLock };
