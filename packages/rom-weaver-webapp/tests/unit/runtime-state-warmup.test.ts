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

  it("runs both install stages on one byte scale", () => {
    // Both stages report the same combined totals, so the precache stage and
    // the warm-up stage read off one percentage instead of restarting.
    const precache = { cachedBytes: 25, cachedFiles: 3, phase: "precache" as const, ready: false };
    expect(offlineWarmupPercent({ ...precache, totalBytes: 100, totalFiles: 20 })).toBe(25);
    expect(offlineWarmupPercent({ cachedBytes: 50, ready: false, totalBytes: 100 })).toBe(50);
    expect(offlineWarmupPercent({ cachedBytes: 100, ready: false, totalBytes: 100 })).toBe(99);

    // No size map (dev, or an older bundle): entry counts carry the percent.
    expect(offlineWarmupPercent({ ...precache, cachedBytes: 0, totalBytes: 0, totalFiles: 20 })).toBe(15);

    expect(offlineWarmupPercent({ cachedBytes: 100, ready: true, totalBytes: 100 })).toBeNull();
    expect(offlineWarmupPercent({ cachedBytes: 0, ready: false, totalBytes: 0 })).toBeNull();
    expect(offlineWarmupPercent(null)).toBeNull();
  });

  it("names the stage the percent belongs to", () => {
    expect(
      installingRuntimeLabel(localizer, {
        cachedBytes: 25,
        cachedFiles: 10,
        phase: "precache",
        ready: false,
        totalBytes: 100,
        totalFiles: 20,
      }),
    ).toBe('ui.runtime.installingAppProgress:{"percent":25}');
    expect(installingRuntimeLabel(localizer, { cachedBytes: 50, ready: false, totalBytes: 100 })).toBe(
      'ui.runtime.installingProgress:{"percent":50}',
    );
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
