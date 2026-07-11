import { describe, expect, it } from "vitest";
import {
  normalizeDialogState,
  normalizeNoticeState,
  normalizePatcherUiState,
} from "../../src/public/react/patcher-ui-state.ts";

describe("normalizeNoticeState", () => {
  it("requires a non-empty message to be visible", () => {
    expect(normalizeNoticeState({ message: "", visible: true })).toMatchObject({ visible: false });
    expect(normalizeNoticeState({ message: "boom", visible: true })).toMatchObject({ level: "error", visible: true });
  });

  it("only accepts the warning level, defaulting to error", () => {
    expect(normalizeNoticeState({ level: "warning", message: "x", visible: true }).level).toBe("warning");
    expect(normalizeNoticeState({ level: "bogus", message: "x", visible: true }).level).toBe("error");
  });

  it("coerces nullish input to a hidden notice", () => {
    expect(normalizeNoticeState(null)).toMatchObject({ message: "", visible: false });
  });
});

describe("normalizeDialogState", () => {
  it("defaults the selection type to rom and clamps fields", () => {
    expect(normalizeDialogState(null)).toEqual({ entries: [], open: false, selectionType: "rom", title: "" });
    expect(normalizeDialogState({ open: 1, selectionType: "patch", title: 7 })).toMatchObject({
      open: true,
      selectionType: "patch",
      title: "",
    });
  });
});

describe("normalizePatcherUiState", () => {
  it("returns a hidden, empty shape for nullish input", () => {
    const normalized = normalizePatcherUiState(null);
    expect(normalized.romInputs).toEqual([]);
    expect(normalized.inputNotice).toMatchObject({ message: "", visible: false });
    // Unlike createEmptyPatcherUiState (disabled: true), the normalizer coerces
    // missing booleans to false - pin that so the projection cannot drift silently.
    expect(normalized.romInput.disabled).toBe(false);
    expect(normalized.patchInput.disabled).toBe(false);
  });

  it("synthesizes a single rom row from legacy flat romInput/romInfo fields", () => {
    const normalized = normalizePatcherUiState({
      romInfo: { crc32: "AABBCCDD", fileName: "rom.sfc" },
      romInput: { loading: false, valid: true },
    });
    expect(normalized.romInputs).toHaveLength(1);
    expect(normalized.romInputs[0]).toMatchObject({ id: "input", valid: true });
    expect(normalized.romInputs[0]?.info).toMatchObject({ crc32: "AABBCCDD", fileName: "rom.sfc" });
  });

  it("defaults checksumsExpanded to true unless explicitly false", () => {
    const [withDefault] = normalizePatcherUiState({ romInputs: [{ id: "a", info: { fileName: "x" } }] }).romInputs;
    expect(withDefault?.info.checksumsExpanded).toBe(true);
    const [collapsed] = normalizePatcherUiState({
      romInputs: [{ id: "a", info: { checksumsExpanded: false, fileName: "x" } }],
    }).romInputs;
    expect(collapsed?.info.checksumsExpanded).toBe(false);
  });
});
