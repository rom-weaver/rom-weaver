import { afterEach, describe, expect, it, vi } from "vitest";
import { runBrowserSharedMemoryProbe } from "../../src/wasm/browser-shared-memory-probe.ts";

const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

const FULL_MAXIMUM_PAGES = 65536;
const MOBILE_CEILING_PAGES = 16384;

const originalMemory = globalThis.WebAssembly.Memory;

/**
 * This constructible double enforces a maximum size and a total construction limit.
 * The limit counts constructions, not live objects, so the ladder's accepted reservation counts toward coexistence.
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
  it("reports matching cap and refusal states for an Apple mobile engine", async () => {
    setUserAgent(IOS_SAFARI);
    stubEngine({ grantedMaximum: MOBILE_CEILING_PAGES });

    const summary = await runProbe();
    const verdict = summary.steps.at(-1);

    // The configured pre-cap agrees with this engine's refusal of the full maximum.
    expect(verdict?.name).toContain("cap setting matches full-maximum refusal");
    expect(verdict?.status).toBe("succeeded");
  });

  it("reports a refused full maximum without a configured pre-cap", async () => {
    setUserAgent(ANDROID_CHROME);
    stubEngine({ grantedMaximum: MOBILE_CEILING_PAGES });

    const summary = await runProbe();
    const verdict = summary.steps.at(-1);

    // Report the difference between full-maximum refusal and the absence of a pre-cap without judging later growth limits.
    expect(verdict?.name).toContain("cap setting differs from full-maximum refusal");
    expect(verdict?.error).toBe(
      "the engine refused the full maximum and no pre-cap is configured; the runtime can fall back",
    );
    expect(summary.failedSteps).toBeGreaterThan(0);
  });

  it("reports an accepted full maximum without a configured pre-cap", async () => {
    setUserAgent(ANDROID_CHROME);
    stubEngine({ grantedMaximum: FULL_MAXIMUM_PAGES });

    const summary = await runProbe();
    const verdict = summary.steps.at(-1);

    expect(verdict?.name).toContain("cap setting matches full-maximum refusal");
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

    // Keep the number of attempted concurrent reservations bounded even when the double accepts all of them.
    expect(report?.coexistingAtMobileCeiling).toBe(8);
    expect(summary.steps.find((step) => step.name.includes("coexisting"))?.command).toContain("8/8");
  });
});
