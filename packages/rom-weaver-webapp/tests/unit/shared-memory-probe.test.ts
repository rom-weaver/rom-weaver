import { afterEach, describe, expect, it, vi } from "vitest";
import { runBrowserSharedMemoryProbe } from "../../src/wasm/browser-shared-memory-probe.ts";

const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

const FULL_MAXIMUM_PAGES = 65536;
const MOBILE_CEILING_PAGES = 16384;

const originalMemory = globalThis.WebAssembly.Memory;

/**
 * Stand in for the engine: grant any `maximum` at or below `grantedMaximum`, refuse anything larger,
 * and refuse outright once `reservationLimit` reservations have been constructed.
 *
 * Must be a real class. `vi.fn()` with an arrow implementation is not a constructor, so every
 * `new WebAssembly.Memory(...)` throws, `tryReserve` swallows it, and the probe silently sees "no
 * maximum granted" - which makes the disagreement assertions pass for the wrong reason.
 *
 * The limit counts constructions, not live objects: JS cannot force the ladder's reservation to be
 * collected, so the coexistence expectations below account for the one it consumes.
 */
const stubEngine = ({
  grantedMaximum,
  reservationLimit = Number.POSITIVE_INFINITY,
}: {
  grantedMaximum: number;
  reservationLimit?: number;
}) => {
  let constructed = 0;
  globalThis.WebAssembly.Memory = class {
    constructor(descriptor: WebAssembly.MemoryDescriptor) {
      if ((descriptor.maximum ?? 0) > grantedMaximum) throw new RangeError("cannot reserve");
      if (constructed >= reservationLimit) throw new RangeError("out of memory");
      constructed += 1;
    }
  } as unknown as typeof WebAssembly.Memory;
};

const setUserAgent = (userAgent: string) => {
  vi.stubGlobal("navigator", { hardwareConcurrency: 8, maxTouchPoints: 5, platform: "", userAgent });
};

afterEach(() => {
  globalThis.WebAssembly.Memory = originalMemory;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const runProbe = () => runBrowserSharedMemoryProbe({ onStep: () => undefined });

describe("runBrowserSharedMemoryProbe", () => {
  it("agrees with policy when an Apple mobile engine refuses the full maximum", async () => {
    setUserAgent(IOS_SAFARI);
    stubEngine({ grantedMaximum: MOBILE_CEILING_PAGES });

    const summary = await runProbe();
    const verdict = summary.steps.at(-1);

    // Steps down AND is capped: the two agree, so the probe reports no disagreement.
    expect(verdict?.name).toContain("policy matches");
    expect(verdict?.status).toBe("succeeded");
  });

  it("flags the disagreement when a non-Apple engine also refuses the full maximum", async () => {
    setUserAgent(ANDROID_CHROME);
    stubEngine({ grantedMaximum: MOBILE_CEILING_PAGES });

    const summary = await runProbe();
    const verdict = summary.steps.at(-1);

    // The case the probe exists to catch: Android laddering down while receiving no cap would mean
    // the Apple-only split no longer describes reality.
    expect(verdict?.name).toContain("POLICY DISAGREES");
    expect(verdict?.error).toBe("engine refuses the full maximum but receives no cap");
    expect(summary.failedSteps).toBeGreaterThan(0);
  });

  it("reports no disagreement when a non-Apple engine grants the full maximum", async () => {
    setUserAgent(ANDROID_CHROME);
    stubEngine({ grantedMaximum: FULL_MAXIMUM_PAGES });

    const summary = await runProbe();
    const verdict = summary.steps.at(-1);

    expect(verdict?.name).toContain("policy matches");
    expect(verdict?.command).toContain(`granted=${FULL_MAXIMUM_PAGES}`);
    expect(verdict?.command).toContain("laddered=false");
  });

  it("counts how many mobile-ceiling reservations coexist before the engine refuses", async () => {
    setUserAgent(IOS_SAFARI);
    // The ladder consumes one reservation reaching 16384, leaving three for the coexistence probe.
    stubEngine({ grantedMaximum: MOBILE_CEILING_PAGES, reservationLimit: 4 });

    const summary = await runProbe();
    const coexistence = summary.steps.find((step) => step.name.includes("coexisting"));

    expect(coexistence?.command).toBe("3/8 reservations of 1.00 GiB coexisted");
    expect(coexistence?.status).toBe("succeeded");
  });

  it("stops at the bound rather than reserving without limit on a permissive engine", async () => {
    setUserAgent(IOS_SAFARI);
    stubEngine({ grantedMaximum: FULL_MAXIMUM_PAGES });

    const summary = await runProbe();
    const report = (globalThis as { ROM_WEAVER_SHARED_MEMORY_PROBE?: { coexistingAtMobileCeiling: number } })
      .ROM_WEAVER_SHARED_MEMORY_PROBE;

    // Without a bound this would loop until the engine gave out, which on a phone means killing the
    // tab the probe is reporting from.
    expect(report?.coexistingAtMobileCeiling).toBe(8);
    expect(summary.steps.find((step) => step.name.includes("coexisting"))?.command).toContain("8/8");
  });
});
