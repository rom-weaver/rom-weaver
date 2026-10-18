import { useCallback, useEffect, useState } from "react";
import { resolveUpdatedSince, type UpdatedSince, writeLastSeenVersion } from "./last-seen-version.ts";
import type { WebappView } from "./webapp-state-types.ts";

/**
 * Tells a returning visitor the site was updated until they dismiss it or open What's new.
 * `since` outlives that acknowledgement for the page's lifetime, so What's new keeps marking the releases it covers.
 */
const useWhatsNewNotice = (currentView: WebappView) => {
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
  return { acknowledge, open: Boolean(since) && !acknowledged && !readingWhatsNew, since };
};

export { useWhatsNewNotice };
