import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, expect, test, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { LogDialog } from "../../src/webapp/components/log-dialog.tsx";
import { setOfflineWarmupEnabled } from "../../src/webapp/pwa/offline-warmup-client.ts";
import "../../src/webapp/design-system/index.css";
import "../../src/webapp/design-system/deferred.css";

let root;
let container;

afterEach(() => {
  root?.unmount();
  container?.remove();
  setOfflineWarmupEnabled(true);
});

const initial = { cachedBytes: 3, cachedFiles: 3, phase: "precache", ready: false, totalBytes: 100, totalFiles: 10 };
const downloading = {
  ...initial,
  cachedBytes: 20,
  cachedFiles: 5,
  detail: { kind: "emulatorjs", name: "cores/mupen64plus_next-thread-wasm.data (+5)" },
  phase: "warmup",
  transferredBytes: 15,
  unit: "emulatorjs:cores/mupen64plus_next-thread-wasm.data",
};
const completed = { ...initial, cachedBytes: 100, cachedFiles: 10, ready: true, transferredBytes: 80 };

for (const width of [390, 1280]) {
  test.each([
    ["starting a download", initial, downloading],
    ["finishing a download", downloading, completed],
  ])(`one remove click survives %s at ${width}px`, async (_label, before, after) => {
    await page.viewport(width, 900);
    await expect.poll(() => window.innerWidth).toBe(width);
    container = document.createElement("div");
    container.className = "rw-app";
    document.body.appendChild(container);
    root = createRoot(container);
    const onOfflineCopyEnabledChange = vi.fn();
    const renderProgress = (offlineProgress) => {
      flushSync(() => {
        root.render(
          createElement(
            RomWeaverSettingsProvider,
            { settings: {} },
            createElement(LogDialog, {
              onClose: () => undefined,
              onLevelChange: () => undefined,
              onOfflineCopyEnabledChange,
              offlineProgress,
              open: true,
              serviceWorkerStatus: "active",
            }),
          ),
        );
      });
    };
    renderProgress(before);
    const remove = page.getByRole("button", { name: "Remove offline copy", exact: true });
    await expect.element(remove).toBeVisible();
    const columnRight = container.querySelector(".status-row dd").getBoundingClientRect().right;
    for (const detail of container.querySelectorAll(".sw-status-cell > *")) {
      expect(detail.getBoundingClientRect().right).toBeLessThanOrEqual(columnRight + 1);
    }
    remove.element().addEventListener("pointerdown", () => renderProgress(after), { once: true });

    await remove.click();

    expect(onOfflineCopyEnabledChange).toHaveBeenCalledExactlyOnceWith(false);
    await expect.element(page.getByRole("button", { name: "Removing offline copy…", exact: true })).toBeDisabled();
  });
}
