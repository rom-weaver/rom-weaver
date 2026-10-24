import { createElement, useState } from "react";
import { expect, onTestFinished, test, vi } from "vitest";
// Real design system, so the disabled look is asserted from computed style.
import "../../src/webapp/design-system/index.css";
import { PatchChecksDrawer } from "../../src/public/react/apply-patch-checks-drawer.tsx";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { useLocalApplyPatchFormSession } from "../../src/public/react/patcher-form-session.ts";
import {
  buildDcpFile,
  buildZippedDcpFile,
  clickCandidateSelectionOption,
  clickApplyButton,
  getInputStackRows,
  getPatchStackRows,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  selectFileInput,
  selectFileInputs,
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

test("a validation-blocked Apply reports aria-disabled with a reason until Apply anyway is ticked", async () => {
  const applyPatchesSpy = vi.fn(async () => undefined);
  // The design-system selectors hang off .rw-app; the harness mounts bare.
  document.body.classList.add("rw-app");
  onTestFinished(() => document.body.classList.remove("rw-app"));
  mount(createChecksumOverrideHarnessElement(applyPatchesSpy));

  const applyButton = await waitForState(() => {
    const button = document.getElementById("rom-weaver-button-apply");
    return button instanceof HTMLButtonElement && button.getAttribute("aria-disabled") === "true" ? button : null;
  }, 30000);
  // Blocked: programmatically disabled, still focusable, with the reason one reference away.
  expect(applyButton.getAttribute("aria-disabled")).toBe("true");
  expect(applyButton.disabled).toBe(false);
  const reasonId = applyButton.getAttribute("aria-describedby");
  expect(reasonId).toBeTruthy();
  const reason = document.getElementById(reasonId);
  expect(reason?.textContent).toMatch(/blocked/i);
  expect(getComputedStyle(applyButton).opacity).not.toBe("1");
  expect(getComputedStyle(applyButton).cursor).toBe("not-allowed");
  applyButton.click();
  expect(applyPatchesSpy).not.toHaveBeenCalled();

  const checkbox = await waitForState(() => {
    const element = document.getElementById("rom-weaver-checkbox-checksum-override");
    return element instanceof HTMLInputElement ? element : null;
  }, 30000);
  checkbox.click();

  // Ticking Apply anyway re-enables it: no aria-disabled, no reason.
  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply")?.hasAttribute("aria-disabled"), { timeout: 30000 })
    .toBe(false);
  const enabled = document.getElementById("rom-weaver-button-apply");
  expect(enabled.hasAttribute("aria-describedby")).toBe(false);
  expect(document.getElementById(reasonId)).toBeNull();
  expect(getComputedStyle(enabled).opacity).toBe("1");
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

test("draft validation blocks imperative dispatch and cancels queued replay", async () => {
  const applyPatches = vi.fn();
  const rom = new File([new Uint8Array([1, 2, 3])], "game.bin");
  const patch = new File([new Uint8Array([1])], "change.ips");
  let session;
  let update;
  const Harness = () => {
    const [state, setState] = useState({ ready: false, error: undefined });
    update = setState;
    session = useLocalApplyPatchFormSession({
      defaultInputs: [rom],
      defaultPatches: [patch],
      applyPatches,
      applyReady: state.ready,
      applyValidationError: state.error,
      downloadOutput: () => undefined,
    });
    return createElement("span", { id: "draft-session-ready" }, state.error || String(session.canStartApply));
  };
  mount(createElement(Harness));
  await expect.poll(() => session).toBeDefined();
  await session.localOutputController.runPrimaryAction();
  update({ ready: true, error: "Expected 8 hex characters" });
  await expect
    .poll(() => document.getElementById("draft-session-ready")?.textContent)
    .toBe("Expected 8 hex characters");
  await session.localOutputController.runPrimaryAction();
  expect(applyPatches).not.toHaveBeenCalled();
  update({ ready: true, error: undefined });
  await expect.poll(() => document.getElementById("draft-session-ready")?.textContent).toBe("true");
  expect(applyPatches).not.toHaveBeenCalled();
});

test.each(["input", "output"].flatMap((side) => ["crc32", "md5", "sha1", "bytes"].map((field) => [side, field])))(
  "malformed %s %s drafts block Apply until removed",
  async (side, field) => {
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { validation: { requireInputChecksumMatch: true }, output: { compression: "none" } },
      }),
    );
    await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
    selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
    const patch = await loadFixtureFile(RAW_PATCH);
    selectFileInputs(document.getElementById("rom-weaver-input-file-unified"), [patch, new File([patch], "spare.ips")]);
    await waitForApplyButtonEnabled();
    await expect.poll(() => document.querySelector("#rom-weaver-combined-patch-job .run")?.disabled).toBe(false);
    document.querySelector("#rom-weaver-list-patch-stack .patch-checks .cks-head")?.click();
    const add = await waitForState(() => document.getElementById(`rom-weaver-patch-${side}-add-check-0`), 30000);
    add.value = field;
    add.dispatchEvent(new Event("change", { bubbles: true }));
    const input = await waitForState(() => document.getElementById(`rom-weaver-patch-${side}-${field}-0`), 30000);
    setFormControlValue(input, field === "bytes" ? "-1" : "not-a-hash");
    await expect.poll(() => document.getElementById("rom-weaver-button-apply")?.disabled).toBe(true);
    await expect.poll(() => document.querySelector("#rom-weaver-combined-patch-job .run")?.disabled).toBe(true);
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await expect.poll(() => input.getAttribute("aria-invalid")).toBe("true");
    const toggle = document.querySelector("#rom-weaver-list-patch-stack .patch-enable input");
    toggle.click();
    await waitForApplyButtonEnabled();
    toggle.click();
    await expect.poll(() => document.getElementById("rom-weaver-button-apply")?.disabled).toBe(true);
    setFormControlValue(input, "");
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await waitForApplyButtonEnabled();
    setFormControlValue(input, field === "bytes" ? "-1" : "not-a-hash");
    await expect.poll(() => document.getElementById("rom-weaver-button-apply")?.disabled).toBe(true);
    input.closest(".verification-row").querySelector(".ck-remove").click();
    await waitForApplyButtonEnabled();
  },
);

test.each(["9007199254740992", "9".repeat(310)])("unsafe byte count %s cannot replace exact metadata", async (raw) => {
  const onMetaChange = vi.fn();
  const onDraftValidityChange = vi.fn();
  mount(
    createElement(PatchChecksDrawer, {
      basisChoice: "base",
      index: 0,
      item: { fileName: "change.ips", format: "ips", validationValues: [] },
      meta: { outputChecks: { size: 4096 } },
      onMetaChange,
      onDraftValidityChange,
      patchStack: {},
    }),
  );
  const open = await waitForState(() => document.getElementById("rom-weaver-patch-output-bytes-0-open"));
  open.click();
  const input = await waitForState(() => document.getElementById("rom-weaver-patch-output-bytes-0"));
  setFormControlValue(input, raw);
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await expect.poll(() => input.getAttribute("aria-invalid")).toBe("true");
  expect(onMetaChange).not.toHaveBeenCalled();
  expect(onDraftValidityChange).toHaveBeenLastCalledWith(expect.any(String));
});

test.each(["crc32", "bytes"])("malformed %s edits preserve committed metadata", async (field) => {
  const onMetaChange = vi.fn();
  const onDraftValidityChange = vi.fn();
  const committed = field === "bytes" ? "4096" : "c6fb1252";
  const meta = { inputChecks: field === "bytes" ? { size: 4096 } : { checksums: { crc32: committed } } };
  mount(
    createElement(PatchChecksDrawer, {
      basisChoice: "base",
      index: 0,
      item: { fileName: "change.ips", format: "ips", validationValues: [] },
      meta,
      onMetaChange,
      onDraftValidityChange,
      patchStack: {},
    }),
  );
  const open = await waitForState(() => document.getElementById(`rom-weaver-patch-input-${field}-0-open`));
  open.click();
  const input = await waitForState(() => document.getElementById(`rom-weaver-patch-input-${field}-0`));
  setFormControlValue(input, field === "bytes" ? "-1" : "not-a-hash");
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await expect.poll(() => input.getAttribute("aria-invalid")).toBe("true");
  expect(onMetaChange).not.toHaveBeenCalled();
  expect(onDraftValidityChange).toHaveBeenLastCalledWith(expect.any(String));
  setFormControlValue(input, committed);
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await expect.poll(() => onDraftValidityChange.mock.lastCall?.[0]).toBe(null);
  expect(onMetaChange).not.toHaveBeenCalled();
});

test.each(["input", "output"])("malformed %s draft remains editable when embedded checks arrive", async (side) => {
  const onDraftValidityChange = vi.fn();
  const Harness = () => {
    const [staged, setStaged] = useState(false);
    return createElement(
      "div",
      null,
      createElement(
        "button",
        { id: "finish-staging", type: "button", onClick: () => setStaged(true) },
        "Finish staging",
      ),
      createElement(PatchChecksDrawer, {
        basisChoice: "base",
        index: 0,
        item: {
          key: "patch-1",
          fileName: "change.bps",
          format: "bps",
          validationValues: staged ? [`${side === "input" ? "in" : "out"} crc32=deadbeef`] : [],
        },
        onMetaChange: () => undefined,
        onDraftValidityChange,
        patchStack: {},
      }),
    );
  };
  mount(createElement(Harness));
  (await waitForState(() => document.querySelector(".patch-checks .cks-head"))).click();
  const add = await waitForState(() => document.getElementById(`rom-weaver-patch-${side}-add-check-0`));
  add.value = "crc32";
  add.dispatchEvent(new Event("change", { bubbles: true }));
  const inputId = `rom-weaver-patch-${side}-crc32-0`;
  const input = await waitForState(() => document.getElementById(inputId));
  setFormControlValue(input, "not-a-hash");
  await expect.poll(() => onDraftValidityChange.mock.lastCall?.[0]).toEqual(expect.any(String));
  document.getElementById("finish-staging").click();
  await expect.poll(() => document.querySelector(".patch-checks")?.textContent).toContain("deadbeef");
  await expect.poll(() => document.getElementById(inputId)?.value).toBe("not-a-hash");
  expect(onDraftValidityChange.mock.lastCall?.[0]).toEqual(expect.any(String));
  document.getElementById(inputId).closest(".verification-row").querySelector(".ck-remove").click();
  await expect.poll(() => onDraftValidityChange.mock.lastCall?.[0]).toBe(null);
});

test.each(["input", "output"])(
  "an edited committed %s check stays editable when embedded checks arrive",
  async (side) => {
    const onMetaChange = vi.fn();
    const metaField = side === "input" ? "inputChecks" : "outputChecks";
    const Harness = () => {
      const [staged, setStaged] = useState(false);
      return createElement(
        "div",
        null,
        createElement(
          "button",
          { id: "finish-staging", type: "button", onClick: () => setStaged(true) },
          "Finish staging",
        ),
        createElement(PatchChecksDrawer, {
          basisChoice: "base",
          index: 0,
          item: {
            key: "patch-1",
            fileName: "change.bps",
            format: "bps",
            validationValues: staged ? [`${side === "input" ? "in" : "out"} crc32=deadbeef`] : [],
          },
          meta: { [metaField]: { checksums: { crc32: "c6fb1252" } } },
          onMetaChange,
          patchStack: {},
        }),
      );
    };
    mount(createElement(Harness));
    (await waitForState(() => document.querySelector(".patch-checks .cks-head"))).click();
    const inputId = `rom-weaver-patch-${side}-crc32-0`;
    const open = await waitForState(() => document.getElementById(`${inputId}-open`));
    open.click();
    const input = await waitForState(() => document.getElementById(inputId));
    setFormControlValue(input, "0bad");
    document.getElementById("finish-staging").click();
    await expect.poll(() => document.querySelector(".patch-checks")?.textContent).toContain("deadbeef");
    expect(document.getElementById(inputId)).toBe(input);
    setFormControlValue(input, "0badf00d");
    expect(document.getElementById(inputId)).toBe(input);
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await expect.poll(() => onMetaChange).toHaveBeenCalledWith({ [metaField]: { checksums: { crc32: "0badf00d" } } });
  },
);

test("malformed draft follows its patch when reordered and clears when removed", async () => {
  mount(createElement(ApplyPatchForm, { defaultSettings: { output: { compression: "none" } } }));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  const patch = await loadFixtureFile(RAW_PATCH);
  selectFileInputs(document.getElementById("rom-weaver-input-file-unified"), [
    await loadFixtureFile(RAW_ROM),
    patch,
    new File([patch], "second.ips"),
  ]);
  await waitForApplyButtonEnabled();
  document.querySelector("#rom-weaver-list-patch-stack .patch-checks .cks-head").click();
  const add = document.getElementById("rom-weaver-patch-output-add-check-0");
  add.value = "bytes";
  add.dispatchEvent(new Event("change", { bubbles: true }));
  const input = await waitForState(() => document.getElementById("rom-weaver-patch-output-bytes-0"));
  setFormControlValue(input, "-1");
  await expect.poll(() => document.getElementById("rom-weaver-button-apply")?.disabled).toBe(true);
  document.getElementById("rom-weaver-patch-menu-0").click();
  await expect.poll(() => document.getElementById("rom-weaver-patch-move-down-0")).not.toBeNull();
  document.getElementById("rom-weaver-patch-move-down-0").click();
  await expect.poll(() => document.getElementById("rom-weaver-patch-output-bytes-1")?.value).toBe("-1");
  expect(document.getElementById("rom-weaver-button-apply").disabled).toBe(true);
  document.getElementById("rom-weaver-patch-menu-1").click();
  await expect.poll(() => document.getElementById("rom-weaver-patch-menu-remove-1")).not.toBeNull();
  document.getElementById("rom-weaver-patch-menu-remove-1").click();
  await waitForApplyButtonEnabled();
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
  document.querySelector("#rom-weaver-list-patch-stack .patch-checks .cks-head")?.click();
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

const addFiles = (files) => selectFileInputs(document.getElementById("rom-weaver-input-file-unified"), files);

test("a real ZIP DCP with no ROM loaded names DCP and the CLI and blocks apply", async () => {
  mount(createElement(ApplyPatchForm));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  addFiles([await buildDcpFile()]);
  await expectDcpCardAndBlockedApply();
});

test("a DCP inside a ZIP archive names DCP and the CLI and blocks apply", async () => {
  mount(createElement(ApplyPatchForm));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  addFiles([await loadFixtureFile(RAW_ROM), await buildZippedDcpFile()]);
  await expectDcpCardAndBlockedApply("translation.zip");
  expect(document.body.textContent || "").not.toContain("COMPRESSION_FAILED");
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
  // The dropped disc files are all ROMs, so the app asks which one to use before the DCP can be judged.
  await clickCandidateSelectionOption("disc.gdi");
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
  await expect.poll(() => getPatchStackRows().length, { timeout: 60000 }).toBe(2);
  await expectDcpCardAndBlockedApply();
  await expectDcpCardAndBlockedApply();
});
