import { createElement } from "react";
import { expect, test } from "vitest";
import { CreatePatchForm } from "../../src/public/react/create-patch-form.tsx";
import { installPatcherTestHooks, loadFixtureFile, mount, selectFileInput } from "./patcher-test-shared.js";

installPatcherTestHooks();

test("Create rejects documentation-only archives with browser recovery advice", async () => {
  mount(createElement(CreatePatchForm));
  await expect.poll(() => document.getElementById("patch-builder-input-file-unified")).not.toBeNull();
  selectFileInput(
    document.getElementById("patch-builder-input-file-unified"),
    await loadFixtureFile("tests/fixtures/archives/readme-only.zip", "application/zip"),
  );
  const notice = () => document.getElementById("patch-builder-original-error-message");
  await expect.poll(() => notice()?.textContent || "", { timeout: 30000 }).not.toBe("");
  expect(notice()?.textContent).toContain("No usable ROM found");
  expect(notice()?.textContent).toContain("Choose an archive containing a ROM, or extract it and add the ROM file.");
  expect(notice()?.textContent).not.toMatch(/--no-ignore|--select|\/work\//);
  expect(document.getElementById("patch-builder-button-create")?.disabled).toBe(true);
});
