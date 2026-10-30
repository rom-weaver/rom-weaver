import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { browserVfs } from "../../src/platform/browser/workflow-runtime-vfs-cleanup.ts";
import { waitForBrowserOpfsBootCleanup } from "../../src/storage/browser/browser-opfs-cleanup.ts";
import { prepareTabScratch } from "./fixtures/tab-scratch.js";

test("Reset page removes this tab's scratch and preserves another page's outputs and parsed weave", async () => {
  const previousUrl = location.href;
  history.replaceState(null, "", "/apply-rom-patches");
  const root = document.createElement("div");
  root.id = "webapp-root";
  document.body.append(root);
  await import("../../src/webapp/webapp.ts");
  await waitForBrowserOpfsBootCleanup();
  await expect.element(page.getByRole("button", { name: "Reset", exact: true })).toBeVisible();
  const ownScratch = await prepareTabScratch();
  const otherPage = window.open("about:blank", `scratch-${crypto.randomUUID()}`);
  expect(otherPage).not.toBeNull();
  try {
    const fixtureUrl = new URL("./fixtures/tab-scratch.js", import.meta.url).href;
    const script = otherPage.document.createElement("script");
    script.type = "module";
    // The popup MUST supply Vitest's import hook because it runs outside the test iframe.
    script.textContent = `
      import { prepareTabScratch } from ${JSON.stringify(fixtureUrl)};
      globalThis.__vitest_browser_runner__ = { wrapDynamicImport: (load) => load() };
      globalThis.scratchReady = prepareTabScratch();
    `;
    otherPage.document.body.append(script);
    await expect.poll(() => !!otherPage.scratchReady).toBe(true);
    const otherScratch = await otherPage.scratchReady;
    try {
      expect(otherScratch.paths).toHaveLength(3);
      expect(otherScratch.paths[0]).toMatch(/^\/work\/operations\//);
      expect(otherScratch.paths.slice(1).every((path) => path.startsWith("/work/weave-parse/"))).toBe(true);
      expect(await Promise.all(otherScratch.paths.map((path) => browserVfs.stat(path)))).not.toContain(null);
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Reset page", exact: true }).click();
      await expect
        .poll(async () => Promise.all(ownScratch.paths.map((path) => browserVfs.stat(path))))
        .toEqual([null, null, null]);
      expect(await Promise.all(otherScratch.paths.map((path) => browserVfs.stat(path)))).not.toContain(null);
      expect(await otherScratch.verify()).toEqual({
        outputMatches: true,
        romBytes: [0, 1, 2, 3],
        patchBytes: Array.from(new TextEncoder().encode("PATCHEOF")),
        appliedBytes: [0, 1, 2, 3],
      });
    } finally {
      await otherScratch.cleanup();
    }
  } finally {
    otherPage.close();
    await ownScratch.cleanup();
    root.remove();
    history.replaceState(null, "", previousUrl);
  }
});
