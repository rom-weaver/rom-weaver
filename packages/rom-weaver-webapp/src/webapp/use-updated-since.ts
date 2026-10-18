import { useCallback, useEffect, useState } from "react";
import { resolveUpdatedSince, type UpdatedSince, writeLastSeenVersion } from "./last-seen-version.ts";
import type { WebappView } from "./webapp-state-types.ts";

/**
 * The update a returning visitor has not acknowledged yet; dismissing the banner or opening What's new acknowledges it.
 * `since` outlives that acknowledgement for the page's lifetime, so What's new keeps marking the releases it covers.
 */
const useUpdatedSince = (currentView: WebappView) => {
  const [since, setSince] = useState<UpdatedSince | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  // Resolved after mount: the prerendered shell has no storage, and hydration must match it.
  useEffect(() => {
    setSince(resolveUpdatedSince());
  }, []);
  const acknowledge = useCallback(() => {
    setAcknowledged(true);
    writeLastSeenVersion();
  }, []);
  const readingWhatsNew = currentView === "whats-new";
  useEffect(() => {
    if (since && readingWhatsNew && !acknowledged) acknowledge();
  }, [acknowledge, acknowledged, readingWhatsNew, since]);
  return { acknowledge, announce: Boolean(since) && !acknowledged && !readingWhatsNew, since };
};

export { useUpdatedSince };
