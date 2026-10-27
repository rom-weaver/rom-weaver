import { createElement } from "react";
import { expect, onTestFinished, test, vi } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  clickApplyButton,
  installPatcherTestHooks,
  mount,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

const original = new Uint8Array([0, 1, 2, 3]);
const fixtures = [
  {
    modified: new Uint8Array([0, 1, 9, 3]),
    patch: new Uint8Array([
      85, 80, 83, 49, 132, 132, 130, 11, 0, 19, 134, 185, 139, 216, 95, 77, 104, 5, 100, 242, 162,
    ]),
  },
  {
    modified: new Uint8Array([0, 1, 9, 3, 4, 5]),
    patch: new Uint8Array([
      85, 80, 83, 49, 132, 134, 130, 11, 0, 128, 4, 5, 0, 19, 134, 185, 139, 75, 72, 234, 231, 211, 149, 51, 212,
    ]),
  },
];

test.each(fixtures.flatMap((fixture) => ["forward", "reverse"].map((direction) => ({ ...fixture, direction }))))(
  "strict UPS $direction applies with $modified.length target bytes",
  async ({ modified, patch, direction }) => {
    const input = direction === "reverse" ? modified : original;
    const expected = direction === "reverse" ? original : modified;
    const outputs = [];
    const createObjectURL = URL.createObjectURL.bind(URL);
    const urlSpy = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      if (blob.size === expected.length) outputs.push(blob);
      return createObjectURL(blob);
    });
    onTestFinished(() => urlSpy.mockRestore());
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: true } },
        pageDrop: { files: [new File([input], "game.bin"), new File([patch], "change.ups")], id: 1 },
      }),
    );
    await expect
      .poll(() => document.getElementById("rom-weaver-patch-chain-chip-0")?.textContent, { timeout: 60000 })
      .toBe("Verified");
    await waitForApplyButtonEnabled();
    const expectedChecks = document.getElementById("rom-weaver-rom-expected-checks");
    expect(expectedChecks?.querySelector(".ck-mark.bad")).toBeNull();
    expect(expectedChecks?.querySelector(".ck-mark.ok")).not.toBeNull();
    expect(document.querySelector("#rom-weaver-list-input-stack .file.bad")).toBeNull();
    expect(document.querySelector("#rom-weaver-list-input-stack .file.ok")).not.toBeNull();
    expect(document.getElementById("rom-weaver-checkbox-checksum-override")?.checked ?? false).toBe(false);
    await clickApplyButton();
    expect((await waitForApplyOutcome())?.kind).toBe("download");
    await expect.poll(() => outputs.length).toBe(1);
    expect(new Uint8Array(await outputs[0].arrayBuffer())).toEqual(expected);
  },
  120000,
);

test("strict UPS rejects an unrelated ROM", async () => {
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: true } },
      pageDrop: {
        files: [new File([new Uint8Array([9, 8, 7, 6])], "wrong.bin"), new File([fixtures[0].patch], "change.ups")],
        id: 1,
      },
    }),
  );
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-patch-stack .file.bad"), { timeout: 60000 })
    .not.toBeNull();
  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply")?.matches(':disabled, [aria-disabled="true"]'))
    .toBe(true);
  expect(document.getElementById("rom-weaver-checkbox-checksum-override")?.checked ?? false).toBe(false);
});
