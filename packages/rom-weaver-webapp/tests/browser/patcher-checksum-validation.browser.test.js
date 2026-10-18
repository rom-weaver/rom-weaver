import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { useLocalApplyPatchFormSession } from "../../src/public/react/patcher-form-session.ts";
import {
  buildDcpFile,
  clickApplyButton,
  getInputStackRows,
  getPatchStackRows,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  selectFileInput,
  setFormControlValue,
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
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };
  return createElement(Harness);
};

test("removing the ROM clears patch validation errors", async () => {
  const inputFile = new File([new Uint8Array([0, 1, 2, 3])], "game.bin", { type: "application/octet-stream" });
  const patchFile = new File([new Uint8Array([0x42, 0x50, 0x53, 0x31])], "change.bps", {
    type: "application/octet-stream",
  });
  const Harness = () => {
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches: vi.fn(async () => undefined),
        applyReady: true,
        defaultInputs: [inputFile],
        defaultPatches: [patchFile],
        downloadOutput: () => undefined,
        stageInput: async (_snapshot, handlers) => {
          const input = { fileName: "game.bin", id: "input-1", order: 0 };
          handlers.onState(input);
          return [input];
        },
        stagePatches: async () => [
          {
            fileName: "change.bps",
            id: "patch-1",
            order: 0,
            validationMessage: "Patch validation failed",
            validationState: "invalid",
          },
        ],
      });
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  mount(createElement(Harness));
  await expect.poll(() => document.body.textContent || "").toContain("Patch validation failed");

  const removeButton = document.querySelector("button[aria-label='Remove ROM']");
  expect(removeButton).toBeInstanceOf(HTMLButtonElement);
  removeButton.click();

  await expect.poll(() => document.body.textContent || "").not.toContain("Patch validation failed");
});

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

test("changing the output format keeps the apply-anyway override checked", async () => {
  mount(createElement(ApplyPatchForm, { defaultSettings: { validation: { requireInputChecksumMatch: true } } }));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(WRONG_INPUT_BPS));
  const checkbox = await waitForState(() => {
    const element = document.getElementById("rom-weaver-checkbox-checksum-override");
    return element instanceof HTMLInputElement ? element : null;
  }, 60000);
  checkbox.click();
  await expect.poll(() => checkbox.checked).toBe(true);
  const outputFormat = document.getElementById("rom-weaver-select-output-format");
  expect(outputFormat).toBeInstanceOf(HTMLSelectElement);
  setFormControlValue(outputFormat, "none");
  await expect.poll(() => outputFormat.value).toBe("none");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(checkbox.checked).toBe(true);
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

    // BPS/UPS declare embedded requirements, so the card's Checks drawer opens
    // by default and carries the clickable dry-apply success control.
    const validation = await waitForState(() => {
      const element = document.querySelector("#rom-weaver-list-patch-stack .file.ok");
      if (!(element instanceof HTMLElement)) return null;
      return element.querySelector(".dry-apply-info .info-btn") ? element : null;
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

test("expected validation sizes and file cards retain raw byte metadata", async () => {
  mount(createChecksumOverrideHarnessElement(vi.fn(async () => undefined)));

  const patchRow = await waitForState(() => {
    const row = getPatchStackRows()[0];
    if (!(row instanceof HTMLElement)) return null;
    return row.textContent?.includes("4.10 KB (4096 B)") ? row : null;
  }, 30000);
  expect(patchRow).toBeInstanceOf(HTMLElement);
  expect(patchRow?.textContent).toContain("1.02 KB (1024 B)");
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-input-stack .tree-size[data-size-bytes='8192']"), {
      timeout: 30000,
    })
    .not.toBeNull();
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-patch-stack .tree-size[data-size-bytes='16384']"), {
      timeout: 30000,
    })
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
            label: "Header removed",
          },
        ],
      },
    ),
  );

  // Variants render as labeled sub-groups ("Header removed") inside the single
  // "Checks" drawer with their own BYTES/CRC32/MD5/SHA-1 value table; the raw
  // variant is folded into the main checksums.
  const inputRow = await waitForState(() => {
    const row = getInputStackRows()[0];
    if (!(row instanceof HTMLElement)) return null;
    return row.textContent?.includes("Checks") && row.textContent.includes("Header removed") ? row : null;
  }, 30000);
  expect(inputRow.textContent).toContain("Header removed");
  expect(inputRow.textContent).toContain("12345678");
  expect(inputRow.textContent).toContain("0123456789abcdef0123456789abcdef");
  expect(inputRow.textContent).toContain("0123456789abcdef0123456789abcdef01234567");
  expect(inputRow.textContent).not.toContain("Raw");
});

test("requirement-less patch passes without requirement rows", async () => {
  mount(
    createChecksumOverrideHarnessElement(
      vi.fn(async () => undefined),
      {
        checksumPreflightMismatch: false,
        validationActualValue: "",
        validationLabel: "Validation",
        validationMessage: "Patch validation passed",
        validationState: "valid",
        validationValues: ["preflight validation"],
      },
    ),
  );

  // A dry-run-only patch declares no requirements: the ok mark rides the card
  // (and the Checks drawer header), and no requirement rows render inside the
  // verification groups - only the per-side "Add check" affordances.
  const validation = await waitForState(() => {
    const element = document.querySelector("#rom-weaver-list-patch-stack .file.ok");
    return element instanceof HTMLElement ? element : null;
  }, 30000);
  expect(validation.querySelector(".cks .ck")).toBeNull();
  expect(validation.textContent).not.toContain("VALIDATION");
});

test("typed input checksum is format-validated and re-verifies the ROM", async () => {
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        output: { compression: "none" },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
  // An IPS patch declares no built-in checks, so the input verification fields are
  // empty and editable.
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_PATCH));
  await waitForApplyButtonEnabled();

  // The Checks drawer starts collapsed for a requirement-less patch: open it
  // and add an input CRC32 check.
  document.querySelector("#rom-weaver-list-patch-stack .cks-head")?.click();
  const addCheck = await waitForState(() => document.getElementById("rom-weaver-patch-input-add-check-0"), 30000);
  addCheck.value = "crc32";
  addCheck.dispatchEvent(new Event("change", { bubbles: true }));
  const crcInput = await waitForState(() => document.getElementById("rom-weaver-patch-input-crc32-0"), 30000);
  expect(crcInput).toBeInstanceOf(HTMLInputElement);
  expect(crcInput.value).toBe("");
  expect(crcInput.readOnly).toBe(false);
  /* Committing a valid value returns the row to text, so reopen it before typing the
     next one - the field only exists while the row is being edited (EditableCheckRow
     keeps it out of the way so iOS never focuses a sub-16px field). A row left invalid
     keeps its field, and the click is then a no-op. */
  const commit = async (value) => {
    document.getElementById("rom-weaver-patch-input-crc32-0-open")?.click();
    const input = await waitForState(() => document.getElementById("rom-weaver-patch-input-crc32-0"), 30000);
    input.value = value;
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  };

  // Malformed hex flags the field and never reaches verification.
  await commit("nothex!!");
  await expect
    .poll(() => document.getElementById("rom-weaver-patch-input-crc32-0")?.getAttribute("aria-invalid"))
    .toBe("true");
  expect(document.querySelector("#rom-weaver-list-input-stack .file.bad")).toBeNull();

  // A well-formed but wrong crc32 verifies against the ROM and flags it.
  await commit("00000000");
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-input-stack .file.bad"), { timeout: 30000 })
    .not.toBeNull();
  // A well-formed value clears the malformed state, which a settled row reports by
  // no longer marking itself bad (the field itself has gone back to text).
  await expect.poll(() => document.querySelector("#rom-weaver-list-patch-stack .verification-row.bad")).toBeNull();

  // The ROM's actual crc32 re-verifies to a match.
  await commit("c6fb1252");
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-input-stack .file.ok"), { timeout: 30000 })
    .not.toBeNull();
  expect(document.querySelector("#rom-weaver-list-input-stack .file.bad")).toBeNull();
});

test("an unreadable patch fails its own card in plain language and blocks apply", async () => {
  mount(createElement(ApplyPatchForm));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
  const garbage = new Uint8Array(3000);
  for (let index = 0; index < garbage.length; index += 1) garbage[index] = (index * 131 + 17) % 251;
  selectFileInput(
    document.getElementById("rom-weaver-input-file-unified"),
    new File([garbage], "garbage.bps", { type: "application/octet-stream" }),
  );

  await expect
    .poll(() => document.querySelector("#rom-weaver-list-patch-stack .file.bad .pfault"), { timeout: 60000 })
    .not.toBeNull();
  const fault = document.querySelector("#rom-weaver-list-patch-stack .file.bad .pfault");
  expect(fault.textContent).toContain("Invalid patch file: garbage.bps");
  const chip = document.querySelector('#rom-weaver-list-patch-stack .file.bad [id^="rom-weaver-patch-chain-chip-"]');
  expect(chip?.textContent?.trim()).toBe("⚠ Patch file is not valid");
  const pageText = document.body.textContent || "";
  expect(pageText).not.toContain("INVALID_INPUT");
  expect(pageText).not.toContain("Not checked yet");
  // Like other invalid-patch states, Apply stays clickable but is a no-op while the card is failed.
  const applyButton = document.getElementById("rom-weaver-button-apply");
  applyButton?.click();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 2000));
  // A completed apply would turn the button into a download.
  expect(applyButton?.textContent || "").not.toContain("Download");
  expect(document.body.textContent || "").not.toContain("INVALID_INPUT");
  expect(document.querySelector("#rom-weaver-list-patch-stack .file.bad .pfault")).not.toBeNull();
});

const DCP_MESSAGE = "Dreamcast DCP patches are not supported in browser Apply yet";

// The DCP card must name DCP and the CLI (as plain text), never ingest the ZIP into a selection dialog,
// never fall back to a generic ROM/target complaint, and keep Apply from producing an output.
const expectDcpCardAndBlockedApply = async (dcpName = "real.dcp") => {
  const dcpRow = () =>
    getPatchStackRows().find((row) => row.textContent?.includes(dcpName) && row.querySelector(".pfault"));
  await expect.poll(dcpRow, { timeout: 60000 }).toBeDefined();
  const fault = dcpRow().querySelector(".pfault");
  expect(fault.textContent).toContain(DCP_MESSAGE);
  expect(fault.textContent).toContain("cli-apply#apply-a-dreamcast-dcp-patch");
  expect(dcpRow().classList.contains("bad")).toBe(true);
  const pageText = document.body.textContent || "";
  expect(pageText).not.toContain("no registered patch handler");
  expect(pageText).not.toContain("expected a different ROM");
  expect(pageText).not.toContain("target selection is required");
  expect(document.querySelector(".rw-modal.select-modal")).toBeNull();
  const applyButton = document.getElementById("rom-weaver-button-apply");
  applyButton?.click();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 2000));
  expect(applyButton?.textContent || "").not.toContain("Download");
  expect(document.querySelector(".rw-modal.select-modal")).toBeNull();
  expect(dcpRow()).toBeDefined();
};

const addFiles = (files) => {
  for (const file of files) selectFileInput(document.getElementById("rom-weaver-input-file-unified"), file);
};

test("a real ZIP DCP with no ROM loaded names DCP and the CLI and blocks apply", async () => {
  mount(createElement(ApplyPatchForm));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  addFiles([await buildDcpFile()]);
  await expectDcpCardAndBlockedApply();
});

test("a real ZIP DCP beside a single ROM names DCP and blocks apply without a selection dialog", async () => {
  mount(createElement(ApplyPatchForm));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  addFiles([await loadFixtureFile(RAW_ROM), await buildDcpFile()]);
  await expectDcpCardAndBlockedApply();
  expect(getPatchStackRows()).toHaveLength(1);
});

test("a real ZIP DCP beside a multi-track CUE disc names DCP instead of asking for a target", async () => {
  mount(createElement(ApplyPatchForm));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  const track = (fill) => new Uint8Array(2352 * 16).fill(fill);
  const cue = new File(
    [
      'FILE "track1.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n' +
        'FILE "track2.bin" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n',
    ],
    "multi.cue",
    { type: "application/x-cue" },
  );
  addFiles([cue, new File([track(1)], "track1.bin"), new File([track(2)], "track2.bin"), await buildDcpFile()]);
  await expectDcpCardAndBlockedApply();
});

test("a real ZIP DCP beside a GDI disc names DCP instead of asking for a target", async () => {
  mount(createElement(ApplyPatchForm));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  const gdi = new File(["2\n1 0 4 2352 track01.bin 0\n2 45000 4 2352 track02.bin 0\n"], "disc.gdi", {
    type: "text/plain",
  });
  addFiles([
    gdi,
    new File([new Uint8Array(2352 * 16).fill(1)], "track01.bin"),
    new File([new Uint8Array(2352 * 16).fill(2)], "track02.bin"),
    await buildDcpFile(),
  ]);
  await expectDcpCardAndBlockedApply();
});

test("a real ZIP DCP beside a headered ROM and another patch still names DCP and blocks apply", async () => {
  mount(createElement(ApplyPatchForm));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 0x02, 0x01, 0x01, 0x00]);
  const rom = new Uint8Array(16 + 2 * 16384 + 8192).fill(0x11);
  rom.set(header);
  addFiles([
    new File([rom], "game.nes", { type: "application/octet-stream" }),
    await loadFixtureFile(RAW_PATCH),
    await buildDcpFile(),
  ]);
  await expectDcpCardAndBlockedApply();
  expect(getPatchStackRows()).toHaveLength(2);
});
