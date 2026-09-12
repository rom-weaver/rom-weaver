import { useEffect, useState } from "react";
import { lookupExpectedRom } from "../../lib/apply/expected-rom-lookup.ts";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import type { ParsedIdentifyResolution } from "../../types/identify.ts";
import { useLatestRef } from "./use-latest-ref.ts";

/* Two checks that carry the same digests and size describe the same ROM, so the
   key - not the object - decides when a lookup re-runs. Without it every render
   would restart a pack load. */
const checkKey = (checks: ParsedBundleChecks | undefined): string => {
  const checksums = checks?.checksums || {};
  const digests = Object.keys(checksums)
    .sort()
    .map((algorithm) => `${algorithm}=${checksums[algorithm]}`)
    .join(",");
  if (!digests) return "";
  return typeof checks?.size === "number" ? `${digests}|${checks.size}` : digests;
};

/**
 * Identify expected checks before a ROM is staged, using checksum-routed packs.
 * Disable this lookup once the ROM is staged; retain a result for the same checks.
 */
const useExpectedRomIdentification = (checks: ParsedBundleChecks | undefined, enabled = true) => {
  const key = checkKey(checks);
  // Equivalent check objects MUST NOT restart the lookup on each render.
  const latestChecks = useLatestRef(checks);
  const [identified, setIdentified] = useState<{ key: string; value: ParsedIdentifyResolution } | undefined>(undefined);
  useEffect(() => {
    if (!key) {
      setIdentified(undefined);
      return;
    }
    if (!enabled) return;
    const controller = new AbortController();
    let live = true;
    setIdentified(undefined);
    void (async () => {
      try {
        const found = await lookupExpectedRom(latestChecks.current || {}, { signal: controller.signal });
        if (!live) return;
        if (found && found.status !== "unavailable") setIdentified({ key, value: found });
      } catch {
        // A checksum nobody can look up is not an apply error; the card still
        // renders the check's own values.
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [enabled, key, latestChecks]);
  return identified?.key === key ? identified.value : undefined;
};

export { useExpectedRomIdentification };
