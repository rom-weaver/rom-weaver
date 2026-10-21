import { createElement, useState } from "react";
import { expect, test, vi } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  clickApplyButton,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  selectFileInput,
  selectFileInputs,
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

test("one enabled patch or cheat allows Apply and off entries leave the output unchanged", async () => {
  window.history.replaceState(null, "", "/apply-patches?guide=apply");
  const rom = await loadFixtureFile(NES_ROM);
  const original = new Uint8Array(await rom.arrayBuffer());
  const patch = new File(
    [new Uint8Array([0x50, 0x41, 0x54, 0x43, 0x48, 0, 0, 0xa8, 0, 1, 0x7f, 0x45, 0x4f, 0x46])],
    "neighbor.ips",
  );
  const outputs = [];
  const createObjectURL = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    if (blob.size === original.length) outputs.push(blob);
    return createObjectURL(blob);
  });
  mount(createElement(ApplyPatchForm, { defaultSettings: { output: { compression: "none" } } }));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  selectFileInputs(document.getElementById("rom-weaver-input-file-unified"), [rom, patch]);
  await clickButtonByText("Add cheats to the patch order");
  await addPracticeCheat("Make the greeting start with M");
  await clickButtonByText("Close");
  const patchToggle = () => document.querySelector('input[aria-label="Include neighbor"]');
  const cheatToggle = () => document.querySelector('input[aria-label="Include Make the greeting start with M"]');
  await expect.poll(() => patchToggle()?.checked).toBe(true);
  await expect.poll(() => cheatToggle()?.checked).toBe(true);
  patchToggle().click();
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  expect((await waitForApplyOutcome())?.kind).toBe("download");
  await expect.poll(() => outputs.length).toBe(1);
  const cheatOnly = original.slice();
  cheatOnly[0xa7] = 0x0d;
  expect(new Uint8Array(await outputs[0].arrayBuffer())).toEqual(cheatOnly);

  cheatToggle().click();
  await expect.poll(() => document.getElementById("rom-weaver-button-apply")?.disabled).toBe(true);
  expect(cheatToggle()).not.toBeNull();
  patchToggle().click();
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  expect((await waitForApplyOutcome())?.kind).toBe("download");
  await expect.poll(() => outputs.length).toBe(2);
  const patchOnly = original.slice();
  patchOnly[0xa8] = 0x7f;
  expect(new Uint8Array(await outputs[1].arrayBuffer())).toEqual(patchOnly);
});

test("removing cheat controls preserves ROM-only batch queueing", async () => {
  window.history.replaceState(null, "", "/apply-patches?guide=apply");
  const rom = await loadFixtureFile(NES_ROM);
  const second = new File([rom], "second.nes");
  const Harness = () => {
    const [inputs, setInputs] = useState([]);
    return createElement(
      "div",
      null,
      createElement("button", { type: "button", onClick: () => setInputs([rom, second]) }, "Add second ROM"),
      createElement(ApplyPatchForm, {
        inputs,
        onInputsChange: setInputs,
        defaultSettings: { output: { compression: "zip" } },
      }),
    );
  };
  mount(createElement(Harness));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), rom);
  await clickButtonByText("Add cheats to the patch order");
  await addPracticeCheat("Make the greeting start with M");
  await clickButtonByText("Close");
  await waitForApplyButtonEnabled();

  await clickButtonByText("Add second ROM");

  await expect.poll(() => document.querySelectorAll('button[aria-label="Remove ROM"]').length).toBe(2);
  expect(document.querySelectorAll(".cheat-card").length).toBe(0);
  await expect.poll(() => document.getElementById("rom-weaver-button-apply")?.disabled).toBe(false);
  await clickApplyButton();
  await expect
    .poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "")
    .toContain("Waiting for other actions");
});
