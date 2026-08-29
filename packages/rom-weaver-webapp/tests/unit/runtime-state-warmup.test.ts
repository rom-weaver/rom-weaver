// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { installingRuntimeLabel, resolveRuntimeState } from "../../src/webapp/components/shell.tsx";

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
});
