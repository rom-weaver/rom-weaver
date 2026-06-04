import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import { useEffect, useRef, useState } from "react";
import { Banner } from "./shell.tsx";

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

function ProcessingWakeLockNotice({ active }: { active: boolean }) {
  const [warningMessage, setWarningMessage] = useState("");
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    const releaseSentinel = () => {
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
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
      setWarningMessage(DEFAULT_WAKE_LOCK_WARNING);
      return;
    }

    let disposed = false;
    const handleRelease = () => {
      sentinelRef.current = null;
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
        sentinelRef.current = sentinel;
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

  if (!(active && warningMessage)) return null;
  return (
    <Banner icon={<TriangleAlert aria-hidden="true" />} warn>
      {warningMessage}
    </Banner>
  );
}

export { ProcessingWakeLockNotice };
