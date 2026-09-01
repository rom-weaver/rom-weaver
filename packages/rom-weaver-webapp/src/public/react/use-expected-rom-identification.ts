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
 * Identify a rom check that has no ROM behind it yet - a bundle's `rom.checks`,
 * or the source requirement a staged patch declares - so the workflow can name
 * the expected title and fill in the checksums the check itself omitted.
 *
 * The lookup loads the FULL identify pack set (a checksum routes to no
 * platform), so it runs off the render path and is abandoned when the check
 * changes. Every failure - an unavailable database included - resolves to
 * `undefined`: a check that cannot be identified is not a check that failed.
 *
 * Callers pass `enabled: false` once the ROM itself is staged: the staged ROM
 * is identified from its own bytes, so starting a second full pack load would
 * buy nothing. A result already found for the same check is kept, so the
 * expectation does not lose its title the moment the ROM lands.
 */
const useExpectedRomIdentification = (checks: ParsedBundleChecks | undefined, enabled = true) => {
  const key = checkKey(checks);
  // `key` already carries every digest and the size, so the effect keys on it
  // and reads the check itself through a ref - depending on the object would
  // reload the whole pack set on every render.
  const latestChecks = useLatestRef(checks);
  const [identification, setIdentification] = useState<ParsedIdentifyResolution | undefined>(undefined);
  useEffect(() => {
    if (!key) {
      setIdentification(undefined);
      return;
    }
    if (!enabled) return;
    const controller = new AbortController();
    let live = true;
    setIdentification(undefined);
    void (async () => {
      try {
        const found = await lookupExpectedRom(latestChecks.current || {}, { signal: controller.signal });
        if (!live) return;
        if (found && found.status !== "unavailable") setIdentification(found);
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
  return identification;
};

export { useExpectedRomIdentification };
