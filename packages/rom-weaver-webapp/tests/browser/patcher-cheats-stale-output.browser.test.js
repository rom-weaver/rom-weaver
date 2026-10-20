import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  clickApplyButton,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  selectFileInput,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

const NES_ROM = "tests/fixtures/cheats/hello-world.nes";

const clickButtonByText = async (text) => {
  await expect
    .poll(() =>
      [...document.querySelectorAll("button")].some(
        (button) =>
          (button.textContent?.includes(text) || button.getAttribute("aria-label") === text) && !button.disabled,
      ),
    )
    .toBe(true);
  [...document.querySelectorAll("button")]
    .find(
      (button) =>
        (button.textContent?.includes(text) || button.getAttribute("aria-label") === text) && !button.disabled,
    )
    .click();
};

const addPracticeCheat = async (name) => {
  await clickButtonByText(`Add ${name}`);
};

test("changing the cheat list retires a finished apply result", async () => {
  // The guided Apply flow unlocks the practice cheat catalog for the practice ROM.
  window.history.replaceState(null, "", "/apply-patches?guide=apply");
  mount(
    createElement(ApplyPatchForm, {
      cheatsPage: true,
      defaultSettings: { output: { compression: "none" } },
    }),
  );
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(NES_ROM));

  await clickButtonByText("Add cheats to the patch order");
  await addPracticeCheat("Make the greeting start with M");
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome?.kind).toBe("download");

  await addPracticeCheat("Change the background color");

  // The finished output baked one cheat, so a second cheat MUST put Apply back.
  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply")?.textContent || "", { timeout: 30000 })
    .not.toContain("Download");
});
