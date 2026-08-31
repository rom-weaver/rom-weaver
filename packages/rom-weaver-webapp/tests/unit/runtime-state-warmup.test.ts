// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  describeWarmupUnit,
  installingRuntimeLabel,
  offlineWarmupPercent,
  resolveRuntimeState,
} from "../../src/webapp/components/shell.tsx";

const localizer = {
  message: (id: string, values?: Record<string, unknown>) => (values ? `${id}:${JSON.stringify(values)}` : id),
};

describe("runtime state with offline warm-up gating", () => {
  it("keeps an active service worker at installing until the warm-up is ready", () => {
    expect(resolveRuntimeState("active", false, null)).toBe("installing");
    expect(resolveRuntimeState("active", false, { cachedBytes: 1, ready: false, totalBytes: 2 })).toBe("installing");
    expect(resolveRuntimeState("ready", false, { cachedBytes: 1, ready: false, totalBytes: 2 })).toBe("installing");
  });

  it("reports active and ready once the warm-up finished", () => {
    const done = { cachedBytes: 2, ready: true, totalBytes: 2 };
    expect(resolveRuntimeState("active", false, done)).toBe("active");
    expect(resolveRuntimeState("ready", false, done)).toBe("ready");
  });

  it("keeps update and disabled above the warm-up gate", () => {
    expect(resolveRuntimeState("active", true, null)).toBe("update");
    expect(resolveRuntimeState("off", false, null)).toBe("disabled");
  });

  it("labels installing with a percent when byte totals are known", () => {
    expect(installingRuntimeLabel(localizer, { cachedBytes: 50, ready: false, totalBytes: 100 })).toBe(
      'ui.runtime.installingProgress:{"percent":50}',
    );
    // Never claims 100% while not ready.
    expect(installingRuntimeLabel(localizer, { cachedBytes: 100, ready: false, totalBytes: 100 })).toBe(
      'ui.runtime.installingProgress:{"percent":99}',
    );
    expect(installingRuntimeLabel(localizer, null)).toBe("ui.runtime.installing");
    expect(installingRuntimeLabel(localizer, { cachedBytes: 0, ready: false, totalBytes: 0 })).toBe(
      "ui.runtime.installing",
    );
  });

  it("computes a whole percent only for an incomplete warm-up with known totals", () => {
    expect(offlineWarmupPercent({ cachedBytes: 25, ready: false, totalBytes: 100 })).toBe(25);
    expect(offlineWarmupPercent({ cachedBytes: 100, ready: false, totalBytes: 100 })).toBe(99);
    expect(offlineWarmupPercent({ cachedBytes: 100, ready: true, totalBytes: 100 })).toBeNull();
    expect(offlineWarmupPercent({ cachedBytes: 0, ready: false, totalBytes: 0 })).toBeNull();
    expect(offlineWarmupPercent(null)).toBeNull();
    // Precache broadcasts carry file counts only; percent falls back to them.
    expect(offlineWarmupPercent({ cachedBytes: 0, cachedFiles: 5, ready: false, totalBytes: 0, totalFiles: 20 })).toBe(
      25,
    );
    expect(offlineWarmupPercent({ cachedBytes: 0, cachedFiles: 20, ready: false, totalBytes: 0, totalFiles: 20 })).toBe(
      99,
    );
    // Known byte totals outrank file counts.
    expect(
      offlineWarmupPercent({ cachedBytes: 50, cachedFiles: 1, ready: false, totalBytes: 100, totalFiles: 20 }),
    ).toBe(50);
  });

  it("describes warm-up units for the status detail line", () => {
    // The structured detail wins and carries a group's display label.
    expect(
      describeWarmupUnit(localizer, {
        detail: { kind: "identify-group", name: "Computers" },
        unit: "identify-group:optional-computers",
      }),
    ).toBe('ui.runtime.detailIdentifyGroup:{"name":"Computers"}');
    // Without a detail the internal unit label is parsed.
    expect(describeWarmupUnit(localizer, { unit: "emulatorjs:cores/ppsspp.wasm" })).toBe(
      'ui.runtime.detailEmulatorFile:{"name":"cores/ppsspp.wasm"}',
    );
    expect(describeWarmupUnit(localizer, { unit: "unknown:thing" })).toBeNull();
    expect(describeWarmupUnit(localizer, { unit: "" })).toBeNull();
    expect(describeWarmupUnit(localizer, null)).toBeNull();
  });
});
