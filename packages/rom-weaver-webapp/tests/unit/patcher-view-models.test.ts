import { describe, expect, it } from "vitest";
import type { BinarySource } from "../../src/public/react/patcher-form.ts";
import { createOutputSizeSummary } from "../../src/public/react/patcher-presentation.ts";
import type { RomInputRowState } from "../../src/public/react/patcher-ui-state.ts";
import {
  buildNoticeViewState,
  buildOutputViewState,
  buildStackViewState,
  buildUiViewState,
} from "../../src/public/react/patcher-view-models.ts";

const source = (name: string, size = 16): BinarySource => ({ name, size }) as unknown as BinarySource;

const makeRow = (overrides: Partial<RomInputRowState> = {}): RomInputRowState => ({
  disabled: false,
  groupId: "",
  id: "input-1",
  info: {
    archiveName: "",
    checksumsExpanded: true,
    checksumTiming: "",
    crc32: "",
    fileName: "game.bin",
    md5: "",
    romInfo: "",
    sha1: "",
    validationPhase: "idle",
  },
  invalid: false,
  kind: "",
  loading: false,
  order: 0,
  progress: null,
  valid: true,
  ...overrides,
});

const uiInput = (overrides: Partial<Parameters<typeof buildUiViewState>[0]> = {}) =>
  buildUiViewState({
    activePatches: [],
    activeSettings: {},
    busy: false,
    checksumOverrideChecked: false,
    disabled: false,
    effectiveInputs: [],
    effectiveOutputNoticeMessage: "",
    hasStrictInputChecksumMismatch: false,
    inputNoticeMessage: "",
    inputStaging: false,
    outputRuntimeNoticeMessage: "",
    patchNoticeMessage: "",
    patchProgress: null,
    patchProgressByKey: {},
    patchStaging: false,
    primaryRomInput: null,
    romInputs: [],
    sectionTimings: { checksum: "", input: "", output: "", patch: "" },
    ...overrides,
  });

describe("buildNoticeViewState", () => {
  it("is visible only with a message and no section placement", () => {
    expect(buildNoticeViewState({ failureMessage: "boom", failurePlacement: null }).visible).toBe(true);
    expect(buildNoticeViewState({ failureMessage: "boom", failurePlacement: "input" }).visible).toBe(false);
    expect(buildNoticeViewState({ failureMessage: "", failurePlacement: null }).visible).toBe(false);
  });
});

describe("buildUiViewState", () => {
  it("marks rom/patch inputs valid based on presence", () => {
    const state = uiInput({ activePatches: [source("p.ips")], effectiveInputs: [source("a.bin")] });
    expect(state.romInput.valid).toBe(true);
    expect(state.patchInput.valid).toBe(true);
  });

  it("falls back to joined input names when no primary row is staged", () => {
    const state = uiInput({ effectiveInputs: [source("a.bin"), source("b.bin")] });
    expect(state.romInfo.fileName).toBe("a.bin, b.bin");
  });

  it("prefers the staged primary row file name and checksums", () => {
    const primary = makeRow({ info: { ...makeRow().info, crc32: "DEADBEEF", fileName: "rom.sfc" } });
    const state = uiInput({ effectiveInputs: [source("a.bin")], primaryRomInput: primary, romInputs: [primary] });
    expect(state.romInfo.fileName).toBe("rom.sfc");
    expect(state.romInfo.crc32).toBe("DEADBEEF");
  });

  it("shows the checksum override only on a strict mismatch", () => {
    expect(uiInput().checksumOverride.visible).toBe(false);
    expect(uiInput({ hasStrictInputChecksumMismatch: true }).checksumOverride.visible).toBe(true);
  });

  it("reports input loading while staging or while a row reports progress", () => {
    expect(uiInput({ inputStaging: true }).romInput.loading).toBe(true);
    const busyRow = makeRow({ progress: { percent: 5 } });
    expect(uiInput({ romInputs: [busyRow] }).romInput.loading).toBe(true);
    expect(uiInput().romInput.loading).toBe(false);
  });

  it("surfaces section notices when their messages are set", () => {
    const state = uiInput({
      effectiveOutputNoticeMessage: "bad output",
      inputNoticeMessage: "bad input",
      patchNoticeMessage: "bad patch",
    });
    expect(state.inputNotice).toMatchObject({ message: "bad input", visible: true });
    expect(state.outputNotice).toMatchObject({ message: "bad output", visible: true });
    expect(state.patchNotice).toMatchObject({ message: "bad patch", visible: true });
  });
});

describe("buildStackViewState", () => {
  const getPatchKey = (patch: BinarySource) => (patch as unknown as { name: string }).name;

  it("maps patches to ordered stack items with move affordances", () => {
    const patches = [source("a.ips"), source("b.ips")];
    const { items } = buildStackViewState({
      activePatches: patches,
      busy: false,
      disabled: false,
      getPatchKey,
      patchInfoByKey: {},
      patchProgressByKey: {},
      patchStaging: false,
      romInputs: [makeRow()],
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ canMoveDown: true, canMoveUp: false, index: 1 });
    expect(items[1]).toMatchObject({ canMoveDown: false, canMoveUp: true, index: 2 });
  });

  it("derives a single target option and auto-selects it", () => {
    const { items } = buildStackViewState({
      activePatches: [source("a.ips")],
      busy: false,
      disabled: false,
      getPatchKey,
      patchInfoByKey: {},
      patchProgressByKey: {},
      patchStaging: false,
      romInputs: [makeRow({ id: "rom-a", info: { ...makeRow().info, fileName: "rom-a.bin" } })],
    });
    expect(items[0]?.targetOptions).toEqual([{ label: "rom-a.bin", value: "rom-a" }]);
    expect(items[0]?.targetValue).toBe("rom-a");
    expect(items[0]?.targetDisabled).toBe(true);
  });

  it("excludes cue rows and non-patchable rows from target options", () => {
    const { items } = buildStackViewState({
      activePatches: [source("a.ips")],
      busy: false,
      disabled: false,
      getPatchKey,
      patchInfoByKey: {},
      patchProgressByKey: {},
      patchStaging: false,
      romInputs: [makeRow({ id: "cue", kind: "cue" }), makeRow({ id: "skip", patchable: false })],
    });
    expect(items[0]?.targetOptions).toEqual([]);
  });

  it("targets disc tracks by file name so the primary track's source id still resolves", () => {
    // A disc's primary track row carries the top-level source id (e.g.
    // `input-1`) rather than its per-asset id, so an id-keyed option cannot be
    // resolved against the patchable assets. Disc-track ("track" kind) options
    // therefore use the file name, and targetValue follows the stored target
    // file name even though the asset id differs from the row id.
    const trackInfo = (fileName: string) => ({ ...makeRow().info, fileName });
    const { items } = buildStackViewState({
      activePatches: [source("a.ips")],
      busy: false,
      disabled: false,
      getPatchKey,
      patchInfoByKey: {
        "a.ips": { targetInputFileName: "game (Track 1).bin", targetInputId: "input-0-game.bin" },
      },
      patchProgressByKey: {},
      patchStaging: false,
      romInputs: [
        makeRow({ id: "input-1", info: trackInfo("game (Track 1).bin"), kind: "track" }),
        makeRow({ id: "input-0-game-track-2-bin", info: trackInfo("game (Track 2).bin"), kind: "track", order: 1 }),
      ],
    });
    expect(items[0]?.targetOptions).toEqual([
      { label: "game (Track 1).bin", value: "game (Track 1).bin" },
      { label: "game (Track 2).bin", value: "game (Track 2).bin" },
    ]);
    expect(items[0]?.targetValue).toBe("game (Track 1).bin");
  });

  it("keeps the row id as the target value for non-disc inputs", () => {
    const { items } = buildStackViewState({
      activePatches: [source("a.ips")],
      busy: false,
      disabled: false,
      getPatchKey,
      patchInfoByKey: { "a.ips": { targetInputId: "rom-b" } },
      patchProgressByKey: {},
      patchStaging: false,
      romInputs: [
        makeRow({ id: "rom-a", info: { ...makeRow().info, fileName: "a.bin" }, kind: "rom" }),
        makeRow({ id: "rom-b", info: { ...makeRow().info, fileName: "b.bin" }, kind: "rom", order: 1 }),
      ],
    });
    expect(items[0]?.targetOptions).toEqual([
      { label: "a.bin", value: "rom-a" },
      { label: "b.bin", value: "rom-b" },
    ]);
    expect(items[0]?.targetValue).toBe("rom-b");
  });

  it("disables move/remove while busy", () => {
    const { items } = buildStackViewState({
      activePatches: [source("a.ips"), source("b.ips")],
      busy: true,
      disabled: false,
      getPatchKey,
      patchInfoByKey: {},
      patchProgressByKey: {},
      patchStaging: false,
      romInputs: [makeRow()],
    });
    expect(items[0]).toMatchObject({ canMoveDown: false, canRemove: false });
  });
});

describe("buildOutputViewState", () => {
  const baseOutput = (overrides: Partial<Parameters<typeof buildOutputViewState>[0]> = {}) =>
    buildOutputViewState({
      activeSettings: {},
      applyQueued: false,
      applyTimingText: "",
      busy: false,
      canQueueApply: true,
      completedSizeSummary: createOutputSizeSummary(),
      compressTimingText: "",
      disabled: false,
      displayedCompression: "zip" as never,
      effectiveResolvedOutputName: "out.zip",
      hasPendingDownload: false,
      outputName: "",
      outputNameEdited: false,
      outputOptions: [],
      pendingDownloadFileName: null,
      progress: null,
      selectedOutputOptionLabel: undefined,
      z3dsLabelSource: undefined,
      ...overrides,
    });

  it("labels the apply button for the run phase when nothing is pending", () => {
    const state = baseOutput();
    expect(state.applyButton).toMatchObject({ disabled: false, label: "Weave & download", title: "" });
    expect(state.downloadSummary).toBeNull();
  });

  it("switches the button to download once an output is pending", () => {
    const state = baseOutput({ hasPendingDownload: true, pendingDownloadFileName: "rom.patched.zip" });
    expect(state.applyButton).toMatchObject({ label: "Download rom.patched.zip", title: "Download rom.patched.zip" });
    expect(state.downloadSummary).not.toBeNull();
  });

  it("shows the edited output name over the resolved one", () => {
    expect(baseOutput().displayFileName).toBe("out.zip");
    expect(baseOutput({ outputName: "custom.zip", outputNameEdited: true }).displayFileName).toBe("custom.zip");
  });

  it("disables the apply button when nothing is actionable", () => {
    expect(baseOutput({ canQueueApply: false }).applyButton.disabled).toBe(true);
  });
});
