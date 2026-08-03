import { describe, expect, it } from "vitest";
import { isStaleWritableProbe } from "../../src/wasm/browser-opfs-runtime-env.ts";

describe("browser OPFS writable probes", () => {
  it("only treats valid probes older than one minute as stale", () => {
    const now = 1_000_000;

    expect(isStaleWritableProbe(`.rw-probe-${now - 60_000}-old`, now)).toBe(true);
    expect(isStaleWritableProbe(`.rw-probe-${now - 59_999}-active`, now)).toBe(false);
    expect(isStaleWritableProbe(`.rw-probe-${now + 60_000}-future`, now)).toBe(false);
    expect(isStaleWritableProbe(".rw-probe-not-a-timestamp", now)).toBe(false);
    expect(isStaleWritableProbe("other-file", now)).toBe(false);
  });
});
