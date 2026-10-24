import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  clickApplyButton,
  installPatcherTestHooks,
  mount,
  selectFileInputs,
  waitForApplyButtonEnabled,
  waitForState,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

// APSGBA and DPS pin only endpoint sizes. Patches made against a headered NES
// ROM fit its raw size; the headerless sibling's smaller size must not block
// Apply.

const HEADER_SIZE = 16;
const ROM_SIZE = HEADER_SIZE + 16384 + 8192;
const CHANGED_OFFSET = HEADER_SIZE + 300;

const buildRoms = () => {
  const original = new Uint8Array(ROM_SIZE);
  original.set([0x4e, 0x45, 0x53, 0x1a, 0x01, 0x01, 0x00, 0x00]);
  for (let index = HEADER_SIZE; index < ROM_SIZE; index += 1) original[index] = (index * 7 + 1) & 0xff;
  const expected = original.slice();
  expected[CHANGED_OFFSET] ^= 0x5a;
  return { expected, original };
};

const crc16Ccitt = (bytes) => {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
};

// One APS1 record: the 64 KiB XOR block at offset 0 with source/target crc16s.
const buildApsgba = (source, target) => {
  const bytes = new Uint8Array(12 + 8 + 0x10000);
  const view = new DataView(bytes.buffer);
  bytes.set([0x41, 0x50, 0x53, 0x31]);
  view.setUint32(4, source.length, true);
  view.setUint32(8, target.length, true);
  view.setUint16(16, crc16Ccitt(source), true);
  view.setUint16(18, crc16Ccitt(target), true);
  for (let index = 0; index < target.length; index += 1) bytes[20 + index] = source[index] ^ target[index];
  return new File([bytes], "change.apsgba", { type: "application/octet-stream" });
};

// Copy everything but the changed byte from the source; embed that byte.
const buildDps = (source, target) => {
  const header = new Uint8Array(64 * 3 + 6);
  const headerView = new DataView(header.buffer);
  header[64 * 3 + 1] = 1;
  headerView.setUint32(64 * 3 + 2, source.length, true);
  const copy = (outputOffset, length) => {
    const record = new Uint8Array(13);
    const view = new DataView(record.buffer);
    view.setUint32(1, outputOffset, true);
    view.setUint32(5, outputOffset, true);
    view.setUint32(9, length, true);
    return record;
  };
  const embedded = new Uint8Array(10);
  embedded[0] = 1;
  new DataView(embedded.buffer).setUint32(1, CHANGED_OFFSET, true);
  new DataView(embedded.buffer).setUint32(5, 1, true);
  embedded[9] = target[CHANGED_OFFSET];
  const tail = CHANGED_OFFSET + 1;
  const parts = [header, copy(0, CHANGED_OFFSET), embedded, copy(tail, target.length - tail)];
  return new File(parts, "change.dps", { type: "application/octet-stream" });
};

const applyButtonState = () => {
  const button = document.getElementById("rom-weaver-button-apply");
  if (!(button instanceof HTMLButtonElement)) return null;
  return { ariaDisabled: button.getAttribute("aria-disabled"), disabled: button.disabled };
};

const settledPatchCard = () =>
  waitForState(() => {
    const card = document.querySelector(
      "#rom-weaver-list-patch-stack .file.ok, #rom-weaver-list-patch-stack .file.bad",
    );
    if (!(card instanceof HTMLElement)) return null;
    const busy = document.querySelector(
      "#rom-weaver-list-patch-stack progress, #rom-weaver-list-patch-stack .fileprog, #rom-weaver-list-patch-stack [role=progressbar]",
    );
    return busy ? null : card;
  }, 60000);

for (const { buildPatch, format } of [
  { buildPatch: buildApsgba, format: "APSGBA" },
  { buildPatch: buildDps, format: "DPS" },
]) {
  test(`${format} patch for a headered NES ROM passes checks and applies exactly`, async () => {
    const { expected, original } = buildRoms();
    let applied;
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: true } },
        onApplyComplete: (result) => {
          applied = result.output.getBlob?.();
        },
      }),
    );
    await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
    selectFileInputs(document.getElementById("rom-weaver-input-file-unified"), [
      new File([original], "original.nes", { type: "application/octet-stream" }),
      buildPatch(original, expected),
    ]);

    const card = await settledPatchCard();
    expect(card.classList.contains("ok"), card.textContent).toBe(true);
    expect(document.body.textContent).not.toMatch(/do not match the ROM/i);
    expect(document.getElementById("rom-weaver-checkbox-checksum-override")).toBeNull();
    await waitForApplyButtonEnabled();
    expect(applyButtonState()).toEqual({ ariaDisabled: null, disabled: false });

    await clickApplyButton();
    const blob = await waitForState(() => applied, 60000);
    expect(new Uint8Array(await (await blob).arrayBuffer())).toEqual(expected);
  });
}

test("APSGBA patch still blocks Apply for a ROM of the wrong size", async () => {
  const { expected, original } = buildRoms();
  mount(createElement(ApplyPatchForm, { defaultSettings: { validation: { requireInputChecksumMatch: true } } }));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  selectFileInputs(document.getElementById("rom-weaver-input-file-unified"), [
    new File([original.subarray(0, ROM_SIZE - 1024)], "original.nes", { type: "application/octet-stream" }),
    buildApsgba(original, expected),
  ]);

  const card = await settledPatchCard();
  expect(card.classList.contains("bad"), card.textContent).toBe(true);
  await expect.poll(() => applyButtonState()?.ariaDisabled, { timeout: 30000 }).toBe("true");
});
