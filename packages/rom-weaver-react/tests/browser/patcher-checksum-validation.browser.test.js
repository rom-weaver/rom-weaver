import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { inertDialogController, useLocalApplyPatchFormSession } from "../../src/public/react/patcher-form-session.ts";
import {
  clickApplyButton,
  getInputStackRows,
  getPatchStackRows,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_ROM,
  selectFileInput,
  VALID_BPS,
  VALID_UPS,
  WRONG_INPUT_BPS,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
  waitForState,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

const createChecksumOverrideHarnessElement = (
  applyPatchesSpy,
  stagedPatchInfoOverrides = {},
  stagedInputInfoOverrides = {},
) => {
  const inputFile = new File([new Uint8Array([0, 1, 2, 3])], "game.bin", {
    type: "application/octet-stream",
  });
  const patchFile = new File([new Uint8Array([0x42, 0x50, 0x53, 0x31])], "change.bps", {
    type: "application/octet-stream",
  });
  const stagedInputInfo = {
    checksums: {
      crc32: "00000000",
      md5: "d41d8cd98f00b204e9800998ecf8427e",
      sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    },
    fileName: "game.bin",
    id: "input-1",
    order: 0,
    parentCompressions: [
      {
        decompressionTimeMs: 5,
        fileName: "roms.zip",
        outputSize: 4096,
        sourceSize: 8192,
      },
    ],
    size: 4096,
    sourceSize: 4096,
    ...stagedInputInfoOverrides,
  };
  const stagedPatchInfo = {
    checksumPreflightMismatch: true,
    fileName: "change.bps",
    id: "patch-1",
    order: 0,
    parentCompressions: [
      {
        decompressionTimeMs: 7,
        fileName: "patches.7z",
        outputSize: 4096,
        sourceSize: 16384,
      },
    ],
    size: 4096,
    sourceSize: 4096,
    targetLabel: "Target: game.bin",
    validationActualValue: "size=4 B, crc32=00000000",
    validationLabel: "Expected",
    validationMessage: "Actual input",
    validationState: "invalid",
    validationValues: ["size=4.10 KB (4096 B)", "min_size=1.02 KB (1024 B)", "crc32=deadbeef"],
    ...stagedPatchInfoOverrides,
  };
  const Harness = () => {
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches: applyPatchesSpy,
        applyReady: true,
        defaultSettings: {
          output: {
            compression: "none",
          },
          validation: {
            requireInputChecksumMatch: true,
          },
        },
        downloadOutput: () => undefined,
        inputs: [inputFile],
        patches: [patchFile],
        stageInput: async (_snapshot, handlers) => {
          handlers.onState(stagedInputInfo);
          handlers.onChecksum(stagedInputInfo);
          return [stagedInputInfo];
        },
        stagePatches: async () => [stagedPatchInfo],
      });
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };
  return createElement(Harness);
};

test("strict checksum mismatch blocks apply until override is checked", async () => {
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        validation: {
          requireInputChecksumMatch: true,
        },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(WRONG_INPUT_BPS));

  const checksumOverrideCheckbox = await waitForState(() => {
    const checkbox = document.getElementById("rom-weaver-checkbox-checksum-override");
    return checkbox instanceof HTMLInputElement ? checkbox : null;
  }, 60000);
  expect(checksumOverrideCheckbox).toBeInstanceOf(HTMLInputElement);
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-patch-stack .file.bad .cks-match.bad"), {
      timeout: 60000,
    })
    .not.toBeNull();
  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply") instanceof HTMLButtonElement, {
      timeout: 30000,
    })
    .toBe(true);
  const applyButton = document.getElementById("rom-weaver-button-apply");
  expect(applyButton).toBeInstanceOf(HTMLButtonElement);
  expect(applyButton.disabled).toBe(false);

  checksumOverrideCheckbox.click();
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  await expect.poll(() => checksumOverrideCheckbox.checked, { timeout: 30000 }).toBe(false);

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind).toBe("download");
});

test("source-check patch formats report runtime patch validation success", async () => {
  for (const patchPath of [VALID_BPS, VALID_UPS]) {
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: {
          output: {
            compression: "none",
          },
        },
      }),
    );

    await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

    selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
    selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(patchPath));

    // BPS/UPS declare source requirements, so the card keeps its Checks drawer; the
    // pass verdict is the drawer-header mark, not an in-body banner.
    const validation = await waitForState(() => {
      const element = document.querySelector("#rom-weaver-list-patch-stack .file.ok");
      if (!(element instanceof HTMLElement)) return null;
      return element.querySelector(".cks-match:not(.bad)") ? element : null;
    }, 60000);
    expect(validation).toBeInstanceOf(HTMLElement);
    expect(validation.textContent).toContain("Checks");
  }
});

test("checksum override dispatch uses one-shot validation relax", async () => {
  const applyPatchesSpy = vi.fn(async () => {
    throw new Error("forced apply failure");
  });
  mount(createChecksumOverrideHarnessElement(applyPatchesSpy));

  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply") instanceof HTMLButtonElement, { timeout: 30000 })
    .toBe(true);
  const applyButton = document.getElementById("rom-weaver-button-apply");
  expect(applyButton).toBeInstanceOf(HTMLButtonElement);
  expect(applyButton.disabled).toBe(false);

  const checksumOverrideCheckbox = await waitForState(() => {
    const checkbox = document.getElementById("rom-weaver-checkbox-checksum-override");
    return checkbox instanceof HTMLInputElement ? checkbox : null;
  }, 30000);
  expect(checksumOverrideCheckbox).toBeInstanceOf(HTMLInputElement);
  checksumOverrideCheckbox.click();

  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply") instanceof HTMLButtonElement, { timeout: 30000 })
    .toBe(true);
  await expect.poll(() => applyButton.disabled, { timeout: 30000 }).toBe(false);
  applyButton.click();

  await expect.poll(() => applyPatchesSpy.mock.calls.length, { timeout: 30000 }).toBe(1);
  await expect.poll(() => checksumOverrideCheckbox.checked, { timeout: 30000 }).toBe(false);
  const callInput = applyPatchesSpy.mock.calls[0]?.[0];
  expect(callInput?.options?.validation?.requireInputChecksumMatch).toBe(false);
});

test("expected validation sizes retain raw byte metadata and hide legacy actual input text", async () => {
  mount(createChecksumOverrideHarnessElement(vi.fn(async () => undefined)));

  const patchRow = await waitForState(() => {
    const row = getPatchStackRows()[0];
    if (!(row instanceof HTMLElement)) return null;
    return row.textContent?.includes("4.10 KB (4096 B)") ? row : null;
  }, 30000);
  expect(patchRow).toBeInstanceOf(HTMLElement);
  expect(patchRow?.textContent).toContain("1.02 KB (1024 B)");
  await expect
    .poll(
      () =>
        document.querySelector(
          "#rom-weaver-list-input-stack .rom-weaver-input-stack-file span[data-size-bytes='8192 B']",
        ),
      { timeout: 30000 },
    )
    .not.toBeNull();
  const inputTimingLabel = Array.from(
    document.querySelectorAll("#rom-weaver-list-input-stack .rom-weaver-input-stack-file span"),
  ).find((entry) => entry.textContent?.trim().startsWith("time:"));
  expect(inputTimingLabel?.getAttribute("data-size-bytes") || null).toBeNull();
  await expect
    .poll(
      () =>
        document.querySelector(
          "#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file span[data-size-bytes='16384 B']",
        ),
      { timeout: 30000 },
    )
    .not.toBeNull();

  const statusText = patchRow?.textContent || "";
  expect(statusText).not.toMatch(/size=4 B/i);
  expect(statusText).not.toMatch(/crc32=/i);
});

test("ROM info panel shows checksum variant rows", async () => {
  mount(
    createChecksumOverrideHarnessElement(
      vi.fn(async () => undefined),
      {},
      {
        checksumVariants: [
          {
            checksums: {
              crc32: "00000000",
              md5: "d41d8cd98f00b204e9800998ecf8427e",
              sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
            },
            id: "raw",
            label: "Raw",
          },
          {
            checksums: {
              crc32: "12345678",
              md5: "0123456789abcdef0123456789abcdef",
              sha1: "0123456789abcdef0123456789abcdef01234567",
            },
            id: "remove-header",
            label: "Remove header",
          },
        ],
      },
    ),
  );

  // Variants render as labeled sub-groups ("Remove header") inside the single
  // "Checks" drawer with their own BYTES/CRC32/MD5/SHA-1 value table; the raw
  // variant is folded into the main checksums.
  const inputRow = await waitForState(() => {
    const row = getInputStackRows()[0];
    if (!(row instanceof HTMLElement)) return null;
    return row.textContent?.includes("Checks") && row.textContent.includes("Remove header") ? row : null;
  }, 30000);
  expect(inputRow.textContent).toContain("Remove header");
  expect(inputRow.textContent).toContain("12345678");
  expect(inputRow.textContent).toContain("0123456789abcdef0123456789abcdef");
  expect(inputRow.textContent).toContain("0123456789abcdef0123456789abcdef01234567");
  expect(inputRow.textContent).not.toContain("Raw");
});

test("requirement-less patch passes without a Checks drawer", async () => {
  mount(
    createChecksumOverrideHarnessElement(
      vi.fn(async () => undefined),
      {
        checksumPreflightMismatch: false,
        validationActualValue: "",
        validationLabel: "Validation",
        validationMessage: "Patch validation passed",
        validationState: "valid",
        validationValues: ["dry-run apply"],
      },
    ),
  );

  // A dry-run-only patch declares no requirements: the ok mark rides the card
  // itself and no Checks drawer renders.
  const validation = await waitForState(() => {
    const element = document.querySelector("#rom-weaver-list-patch-stack .file.ok");
    return element instanceof HTMLElement ? element : null;
  }, 30000);
  expect(validation.textContent).not.toContain("Checks");
});
