// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { notifyGuidedSampleView, requestGuidedSampleStart } from "../../src/public/react/guided-sample-start.ts";
import type {
  PatcherOutputController,
  PatcherStackController,
  PatcherUiController,
} from "../../src/public/react/patcher-form.ts";
import type { PatcherOutputState, PatchStackItemState } from "../../src/public/react/patcher-presentation.ts";
import type { PatcherUiState, RomInputRowState } from "../../src/public/react/patcher-ui-state.ts";
import { createEmptyPatcherUiState } from "../../src/public/react/patcher-ui-state.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { createProgressViewModel } from "../../src/presentation/workflow-presentation.ts";
import {
  setPostApplyDownloadBehaviorOverride,
  setPostApplyTestBehaviorOverride,
} from "../../src/public/react/use-apply-download-orchestration.ts";
import type { PostApplyActionBehavior } from "../../src/types/settings.ts";

const read = (relativePath: string) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
const BUNDLE_FIELDS_CSS = read("../../src/webapp/design-system/fields.css");
const BUNDLE_RESPONSIVE_CSS = read("../../src/webapp/design-system/responsive.css");

/**
 * Apply-view markup contract. The browser suites drive the form through
 * `rom-weaver-*` ids and a small set of structural classes; this renders the
 * view against inert controllers (no wasm, no staging) and pins that contract
 * for the empty and staged states, so a markup change that would break the
 * heavyweight suites fails here in milliseconds.
 */

const storeOf = <State,>(state: State) => ({
  getState: () => state,
  subscribe: () => () => undefined,
});

const outputState = (overrides: Partial<PatcherOutputState> = {}): PatcherOutputState =>
  ({
    applyButton: { disabled: true, label: "APPLY & DOWNLOAD", loading: false, progress: null, title: "" },
    applyTiming: "",
    compress: null,
    compressTiming: "",
    compressionFormat: "zip",
    disabled: true,
    displayFileName: "",
    downloadSummary: null,
    options: [{ label: ".zip", value: "zip" }],
    pendingDownloadFileName: null,
    resolvedOutputName: "",
    sizeSummary: {},
    totalTiming: "",
    ...overrides,
  }) as unknown as PatcherOutputState;

const romRow = (fileName: string): RomInputRowState => {
  return {
    groupId: "",
    id: `rom:${fileName}`,
    info: {
      archiveName: "",
      checksumsExpanded: true,
      checksumTiming: "",
      crc32: "C6FB1252",
      fileName,
      md5: "",
      romInfo: "",
      sha1: "",
      validationPhase: "idle",
    },
    kind: "rom",
    loading: false,
    order: 0,
    progress: null,
    size: 13,
  } as unknown as RomInputRowState;
};

const patchItem = (fileName: string): PatchStackItemState =>
  ({
    archiveFileName: "",
    fileName,
    fileSize: 14,
    format: "IPS",
    index: 0,
    sourceChecksumState: "unknown",
    validationActualValue: "",
    validationLabel: "",
    validationMessage: "",
    validationState: "valid",
    validationValues: [],
  }) as unknown as PatchStackItemState;

const renderView = ({
  bundleMetaById,
  emulatorOutput,
  onBundleMetaBulkChange,
  onUnifiedDrop,
  outputOverrides,
  patches = [] as PatchStackItemState[],
  patchEnablement,
  pendingDrops,
  settings = {},
  ui,
}: {
  bundleMetaById?: Parameters<typeof ApplyWorkflowFormView>[0]["bundleMetaById"];
  emulatorOutput?: unknown;
  onBundleMetaBulkChange?: Parameters<typeof ApplyWorkflowFormView>[0]["onBundleMetaBulkChange"];
  onUnifiedDrop?: Parameters<typeof ApplyWorkflowFormView>[0]["onUnifiedDrop"];
  outputOverrides?: Partial<PatcherOutputState>;
  patches?: PatchStackItemState[];
  patchEnablement?: Parameters<typeof ApplyWorkflowFormView>[0]["patchEnablement"];
  pendingDrops?: Parameters<typeof ApplyWorkflowFormView>[0]["pendingDrops"];
  settings?: Parameters<typeof RomWeaverSettingsProvider>[0]["settings"];
  ui: PatcherUiState;
}) => {
  const controllers = {
    output: storeOf(outputState(outputOverrides)) as unknown as PatcherOutputController,
    patchStack: {
      ...storeOf({ items: patches }),
      removeItem: () => undefined,
      reorder: () => undefined,
    } as unknown as PatcherStackController,
    ui: storeOf(ui) as unknown as PatcherUiController,
  };
  return render(
    <RomWeaverSettingsProvider settings={settings}>
      <ApplyWorkflowFormView
        bundleMetaById={bundleMetaById}
        controllers={controllers}
        emulatorOutput={emulatorOutput as never}
        onBundleMetaBulkChange={onBundleMetaBulkChange}
        onUnifiedDrop={onUnifiedDrop}
        patchEnablement={patchEnablement}
        pendingDrops={pendingDrops}
      />
    </RomWeaverSettingsProvider>,
  );
};

describe("apply workflow view - empty bench", () => {
  beforeEach(() => window.history.replaceState(null, "", "/apply"));
  afterEach(() => vi.unstubAllGlobals());

  it("renders only the 0x01 hero", () => {
    const { container } = renderView({ ui: createEmptyPatcherUiState() });
    // 0x01 hero with the stable unified-input id
    expect(container.querySelector("section.step.is-input.is-empty")).toBeTruthy();
    expect(container.querySelector("#rom-weaver-input-file-unified")).toBeTruthy();
    expect(container.querySelector(".drop.hero .formats .fmt")).toBeTruthy();
    const chip = container.querySelector(".sample-tutorial-start-chip") as HTMLButtonElement;
    expect(chip.textContent).toContain("New here?");
    fireEvent.click(chip);
    expect(container.querySelector(".first-weave-demo")?.textContent).toContain("Start guided Apply");
    expect(container.querySelector(".first-weave-demo")?.textContent).toContain("Create a sharable bundle");
    expect(document.querySelector(".sample-tutorial-dialog")).toBeNull();
    // The remaining workflow is progressively disclosed after staging begins.
    const numbers = Array.from(container.querySelectorAll(".step-num")).map((el) => el.textContent);
    expect(numbers).toEqual(["0x01"]);
    expect(container.querySelector("#rom-weaver-input-output-file-name")).toBeNull();
  });

  it("loads the sample into the existing drop pipeline without navigating", async () => {
    const onUnifiedDrop = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      blob: () => Promise.resolve(new Blob(["sample"], { type: "application/zip" })),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderView({ onUnifiedDrop, ui: createEmptyPatcherUiState() });

    fireEvent.click(container.querySelector(".sample-tutorial-start-chip") as HTMLButtonElement);
    fireEvent.click(container.querySelector(".sample-tutorial-start-primary") as HTMLButtonElement);
    expect(document.querySelector(".sample-tutorial-dialog")?.textContent).toContain("Loading the practice files");

    await vi.waitFor(() => expect(onUnifiedDrop).toHaveBeenCalledOnce());
    const [files] = onUnifiedDrop.mock.calls[0] as [File[]];
    expect(fetchMock).toHaveBeenCalledWith("/first-weave.zip");
    expect(files[0]?.name).toBe("first-weave.zip");
  });

  it("starts the sample tutorial from a guided Apply URL", async () => {
    window.history.replaceState(null, "", "/apply?guide=apply");
    const onUnifiedDrop = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        blob: () => Promise.resolve(new Blob(["sample"], { type: "application/zip" })),
        ok: true,
      }),
    );

    renderView({ onUnifiedDrop, ui: createEmptyPatcherUiState() });

    expect(document.querySelector(".sample-tutorial-dialog")?.textContent).toContain("Loading the practice files");
    await vi.waitFor(() => expect(onUnifiedDrop).toHaveBeenCalledOnce());
  });

  it("starts a guide requested after the Apply workbench has mounted", async () => {
    const onUnifiedDrop = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        blob: () => Promise.resolve(new Blob(["sample"], { type: "application/zip" })),
        ok: true,
      }),
    );
    renderView({ onUnifiedDrop, ui: createEmptyPatcherUiState() });

    act(() => requestGuidedSampleStart("apply"));

    await vi.waitFor(() => expect(onUnifiedDrop).toHaveBeenCalledOnce());
    expect(document.querySelector(".sample-tutorial-dialog")?.textContent).toContain("Loading the practice files");

    act(() => notifyGuidedSampleView("docs"));
    expect(document.querySelector(".sample-tutorial-dialog")).toBeNull();
  });

  it("starts the bundle tutorial and selects a patch-only ZIP from a guided Bundle URL", async () => {
    window.history.replaceState(null, "", "/apply?guide=bundle");
    const onUnifiedDrop = vi.fn();
    const setBundlePackage = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        blob: () => Promise.resolve(new Blob(["sample"], { type: "application/zip" })),
        ok: true,
      }),
    );
    const ui = createEmptyPatcherUiState();
    const controllers = {
      output: storeOf(outputState()) as unknown as PatcherOutputController,
      patchStack: storeOf({ items: [] }) as unknown as PatcherStackController,
      ui: storeOf(ui) as unknown as PatcherUiController,
    };

    render(
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyWorkflowFormView
          bundleExport={{
            bundleRom: false,
            busy: false,
            cancelExport: () => undefined,
            downloadable: false,
            error: "",
            format: "zip",
            progress: null,
            ready: true,
            runExport: async () => undefined,
            setBundleRom: () => undefined,
            setFormat: () => undefined,
          }}
          bundleTools={{
            hasOptionalEntries: false,
            outputVerification: null,
            setBundlePackage,
          }}
          controllers={controllers}
          onUnifiedDrop={onUnifiedDrop}
        />
      </RomWeaverSettingsProvider>,
    );

    expect(setBundlePackage).toHaveBeenCalledWith("zip:patches");
    expect(document.querySelector(".sample-tutorial-dialog")?.textContent).toContain("Loading the practice files");
    await vi.waitFor(() => expect(onUnifiedDrop).toHaveBeenCalledOnce());
  });

  it("shapes an identifying archive like the patch card it will most likely become", () => {
    const { container } = renderView({
      pendingDrops: [{ extracting: true, id: "pending-1", kind: "patch", name: "bundle.zip" }],
      ui: createEmptyPatcherUiState(),
    });
    const card = container.querySelector(".rw-pending .card.pending-card");
    expect(card?.textContent).toContain("bundle");
    expect(card?.textContent).toContain("Identifying");
    expect(card?.textContent).toContain("Files");
    // A still-identifying archive has no parsed requirements, so the skeleton
    // reserves no Options/Checks drawer that would then vanish or move.
    expect(card?.textContent).not.toContain("Options");
    expect(card?.textContent).not.toContain("Checks");
  });

  it("previews the disc sheet drawer when archive listing finds one", () => {
    const { container } = renderView({
      pendingDrops: [{ extracting: true, id: "pending-1", kind: "rom", name: "disc.zip", sheet: "CUE" }],
      ui: createEmptyPatcherUiState(),
    });
    const labels = Array.from(container.querySelectorAll(".rw-pending .cks-head .lab")).map((el) => el.textContent);
    expect(labels).toEqual(["Files", "CUE", "Checks"]);
  });
});

describe("apply workflow view - staged bench", () => {
  it("edits shared patch details from the patches header", async () => {
    const onBundleMetaBulkChange = vi.fn();
    const { container, getByLabelText, getByRole } = renderView({
      bundleMetaById: new Map([
        ["patch-a", { author: "Author", version: "1.0" }],
        ["patch-b", { author: "Author", version: "1.0" }],
      ]),
      onBundleMetaBulkChange,
      patchEnablement: {
        disabledIds: new Set(),
        getPatchIds: () => ["patch-a", "patch-b"],
        onToggle: () => undefined,
      },
      patches: [patchItem("first.ips"), patchItem("second.ips")],
      ui: { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] },
    });

    const button = getByRole("button", { name: "Bulk edit" });
    expect(button.closest(".step-head")).toBe(container.querySelector("#rom-weaver-row-patch-stack .step-head"));
    fireEvent.click(button);
    expect((getByLabelText("Version") as HTMLInputElement).value).toBe("1.0");
    expect((getByLabelText("Author") as HTMLInputElement).value).toBe("Author");

    const versionInput = getByLabelText("Version");
    fireEvent.change(versionInput, { target: { value: "2.0" } });
    fireEvent.change(getByLabelText("Author"), { target: { value: "New author" } });
    fireEvent.submit(versionInput.closest("form") as HTMLFormElement);

    expect(onBundleMetaBulkChange).toHaveBeenCalledWith(["patch-a", "patch-b"], {
      author: "New author",
      version: "2.0",
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(button));

    fireEvent.click(button);
    fireEvent.keyDown(getByLabelText("Version"), { key: "Escape" });
    expect(container.querySelector("#rom-weaver-bulk-patch-meta")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("shows the emulator action only when the input resolves to a supported core", () => {
    const output = {
      fileName: "game.nes",
      getBlob: async () => new Blob(["rom"]),
      id: "output-1",
    };
    const supported = renderView({
      emulatorOutput: output,
      outputOverrides: { pendingDownloadFileName: "game.nes" },
      ui: { ...createEmptyPatcherUiState(), romInputs: [romRow("game.nes")] },
    });
    expect(supported.container.querySelector("#rom-weaver-button-test-emulator")).toBeTruthy();
    supported.unmount();

    const unsupported = renderView({
      emulatorOutput: output,
      outputOverrides: { pendingDownloadFileName: "game.bin" },
      ui: { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] },
    });
    expect(unsupported.container.querySelector("#rom-weaver-button-test-emulator")).toBeNull();
  });

  it("keeps likely drawers visible while ROMs and patches are still staging", () => {
    const rom = romRow("game.zip");
    rom.info.validationPhase = "extract";
    rom.progress = { label: "Extracting game.zip", percent: 20 } as RomInputRowState["progress"];
    const patch = patchItem("change.zip");
    patch.progress = { label: "Extracting change.zip", percent: 20 } as PatchStackItemState["progress"];
    const ui = { ...createEmptyPatcherUiState(), romInputs: [rom] };
    const { container } = renderView({ patches: [patch], ui });

    const romLabels = Array.from(container.querySelectorAll("#rom-weaver-list-input-stack .cks-head .lab")).map(
      (el) => el.textContent,
    );
    expect(romLabels).toEqual(["Files", "Checks"]);

    const patchLabels = Array.from(container.querySelectorAll("#rom-weaver-list-patch-stack .cks-head .lab")).map(
      (el) => el.textContent,
    );
    // The Checks drawer is reserved through staging (collapsed and empty until
    // requirements arrive) so the patch card holds its resolved height from
    // first paint, mirroring the ROM card. No Options drawer yet: a staging
    // patch offers no header choice.
    expect(patchLabels).toEqual(["Files", "Checks"]);
  });

  it("renders a staging disc as one card with byte-weighted overall progress", () => {
    const first = romRow("track-01.bin");
    first.groupId = "disc-1";
    first.kind = "track";
    first.order = 0;
    first.size = 100;
    const second = romRow("track-02.bin");
    second.groupId = "disc-1";
    second.kind = "track";
    second.order = 1;
    second.size = 300;
    second.info = { ...second.info, crc32: "", md5: "", sha1: "", validationPhase: "checksum" };
    second.progress = { label: "Calculating checksums...", percent: 50 } as RomInputRowState["progress"];
    const ui = { ...createEmptyPatcherUiState(), romInputs: [first, second] };
    const { container } = renderView({ ui });

    const cards = container.querySelectorAll("#rom-weaver-list-input-stack .card.file");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.querySelector(".stage-status")?.textContent).toContain("63%");
    const stageBar = cards[0]?.querySelector(".stage-bar") as HTMLElement | null;
    expect(stageBar?.style.width).toBe("62.5%");
  });

  it("keeps Checks on a staging patch once real requirements are known", () => {
    const patch = patchItem("change.bps");
    patch.format = "BPS";
    patch.progress = { label: "Reading change.bps", percent: 80 } as PatchStackItemState["progress"];
    patch.validationValues = ["in crc32=C6FB1252", "out crc32=12345678"];
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const { container } = renderView({ patches: [patch], ui });
    const patchLabels = Array.from(container.querySelectorAll("#rom-weaver-list-patch-stack .cks-head .lab")).map(
      (el) => el.textContent,
    );
    expect(patchLabels).toEqual(["Checks"]);
  });

  it("renders ROM and patch cards with the structural classes the browser tests query", () => {
    const rom = romRow("game.bin");
    rom.info.romType = { platform: "Nintendo Entertainment System" };
    const ui = { ...createEmptyPatcherUiState(), romInputs: [rom] };
    const { container } = renderView({ patches: [patchItem("change.ips")], ui });
    // ROM card in the input stack
    const romCard = container.querySelector("#rom-weaver-list-input-stack .card.file");
    expect(romCard).toBeTruthy();
    // display name drops the extension; the full filename rides the title attr
    const nm = romCard?.querySelector(".card-name .nmline .nm");
    expect(nm?.textContent).toBe("game");
    expect(nm?.getAttribute("title")).toBe("game.bin");
    expect(romCard?.querySelector(".extract-d .lab")?.textContent).toBe("Files");
    expect(romCard?.querySelector(".extract-d .tree-name")?.textContent).toBe("game.bin");
    expect(Array.from(romCard?.querySelectorAll(".extract-d .rb") || []).map((el) => el.textContent)).toEqual([
      "13 B",
      "NES",
    ]);
    // checksum rows use the .ck/.ck-k/.ck-v readout structure
    const checksumLabels = Array.from(romCard?.querySelectorAll(".ck .ck-k") || []).map((el) => el.textContent);
    expect(checksumLabels).toContain("CRC32");
    // patch card with verdict + format meta
    const patchCard = container.querySelector("#rom-weaver-list-patch-stack .card.patch");
    expect(patchCard).toBeTruthy();
    expect(patchCard?.classList.contains("ok")).toBe(true);
    expect(patchCard?.querySelector(".extract-d .lab")?.textContent).toBe("Files");
    expect(patchCard?.querySelector(".extract-d .tree-name")?.textContent).toBe("change.ips");
    expect(Array.from(patchCard?.querySelectorAll(".extract-d .rb") || []).map((el) => el.textContent)).toEqual([
      "14 B",
      "IPS",
    ]);
    expect(patchCard?.querySelector(".card-meta .meta-fmt")).toBeNull();
    const patchPosition = patchCard?.querySelector("button.phandle") as HTMLButtonElement;
    expect(patchPosition.textContent).toContain("1");
    expect(patchPosition.disabled).toBe(true);
    expect(patchPosition.getAttribute("aria-label")).toBe("Patch 1 of 1. Reordering unavailable.");
    // the patches step header counts staged files
    expect(container.querySelector("#rom-weaver-row-patch-stack .step-meta .rb")?.textContent).toContain("1 file");
    // no needs-input directives once content is staged
    expect(container.querySelectorAll("button.needs-input").length).toBe(0);
  });

  it("uses a matched title on the ROM card and keeps it out of Checks", () => {
    const rom = romRow("game.bin");
    rom.info = {
      ...rom.info,
      identificationStatus: "matched",
      romInfo: "Advance Wars (USA)",
    };
    const ui = { ...createEmptyPatcherUiState(), romInputs: [rom] };
    const { container } = renderView({ ui });
    const romCard = container.querySelector("#rom-weaver-list-input-stack .card.file");

    expect(romCard?.classList.contains("ok")).toBe(true);
    expect(romCard?.querySelector(".card-name .nm")?.textContent).toBe("Advance Wars (USA)");
    expect(romCard?.querySelector(".card-meta")).toBeNull();
    expect(romCard?.querySelector(".card-name .sr-only")?.textContent).toBe("Advance Wars (USA) — game.bin");
    expect(romCard?.querySelector(".identify-drawer .rb")?.textContent).toBe("Identified");
    expect(romCard?.querySelector('.identify-drawer [aria-label^="Copy standard name "]')?.textContent).toContain(
      "Advance Wars (USA)",
    );
    expect(romCard?.querySelector(".cks:not(.identify-drawer)")?.textContent).not.toContain("Advance Wars (USA)");
    expect(romCard?.querySelector(".extract-d .tree-name")?.textContent).toBe("game.bin");
  });

  it("uses a validated patch requirement to identify the ROM", () => {
    const rom = romRow("game.bin");
    const patch = patchItem("change.ips");
    patch.sourceTitles = ["Advance Wars (USA)"];
    patch.targetValue = rom.id;
    const ui = { ...createEmptyPatcherUiState(), romInputs: [rom] };
    const { container } = renderView({ patches: [patch], ui });
    const romCard = container.querySelector("#rom-weaver-list-input-stack .card.file");

    expect(romCard?.classList.contains("ok")).toBe(true);
    expect(romCard?.querySelector(".card-name .nm")?.textContent).toBe("Advance Wars (USA)");
    expect(romCard?.querySelector(".card-meta")).toBeNull();
    expect(romCard?.querySelector(".identify-drawer .rb")?.textContent).toBe("Identified");
  });

  it("reports an unloadable title database as a quiet note, not a ROM verdict", () => {
    const rom = romRow("game.bin");
    rom.info = {
      ...rom.info,
      identification: { matches: [], status: "unavailable", unavailableReason: "HTTP 503" },
      identificationStatus: "unavailable",
    };
    const ui = { ...createEmptyPatcherUiState(), romInputs: [rom] };
    const { container } = renderView({ ui });
    const romCard = container.querySelector("#rom-weaver-list-input-stack .card.file");

    expect(romCard?.querySelector(".card-meta")?.textContent).toBe("Title lookup unavailable");
    // Never a verdict border: the ROM itself was neither confirmed nor rejected.
    expect(romCard?.classList.contains("ok")).toBe(false);
    expect(romCard?.classList.contains("warn")).toBe(false);
    expect(romCard?.classList.contains("bad")).toBe(false);
    expect(romCard?.querySelector(".card-name .sr-only")?.textContent).toBe("game.bin");
    expect(romCard?.querySelector(".identify-drawer")).toBeNull();
  });

  it("names an ambiguous identification in text, not only in the card border", () => {
    const rom = romRow("game.bin");
    rom.info = {
      ...rom.info,
      identification: {
        matches: [
          { algorithm: "crc32", database: "pack", name: "Twin (USA)", platform: "GBA", variant: "raw" },
          { algorithm: "crc32", database: "pack", name: "Twin (Europe)", platform: "GBA", variant: "raw" },
        ],
        status: "ambiguous",
      },
      identificationStatus: "ambiguous",
    };
    const ui = { ...createEmptyPatcherUiState(), romInputs: [rom] };
    const { container } = renderView({ ui });
    const romCard = container.querySelector("#rom-weaver-list-input-stack .card.file");

    expect(romCard?.classList.contains("warn")).toBe(true);
    expect(romCard?.querySelector(".card-meta")?.textContent).toBe("Possible matches found");
    expect(romCard?.querySelector(".identify-drawer .rb")?.textContent).toBe("2 possible matches");
  });

  it("does not show embedded sheet text as a separate file for a lone ROM", () => {
    const rom = romRow("game.bin");
    rom.cueText = 'FILE "game.bin" BINARY\n  TRACK 01 MODE1/2352';
    const ui = { ...createEmptyPatcherUiState(), romInputs: [rom] };
    const { container } = renderView({ ui });
    const romCard = container.querySelector("#rom-weaver-list-input-stack .card.file");

    expect(romCard?.querySelector(".extract-d .tree-name")?.textContent).toBe("game.bin");
    expect(romCard?.querySelector(".rw-cue-section")).toBeNull();
  });

  it("shows size and extraction time for synthesized CUE files", () => {
    const rom = romRow("game.bin");
    rom.kind = "track";
    rom.cueText = 'FILE "game.bin" BINARY\n  TRACK 01 MODE1/2352';
    rom.gdiText = "1\n";
    rom.decompressionTimeMs = 5190;
    const ui = { ...createEmptyPatcherUiState(), romInputs: [rom] };
    const { container } = renderView({ ui });
    const cueRow = container.querySelector(".extract-d .tree-row");

    expect(cueRow?.querySelector(".tree-name")?.textContent).toBe("game.cue");
    expect(cueRow?.querySelector(".tree-size")?.textContent).toBe("44 B");
    expect(cueRow?.querySelector(".tree-time")?.textContent).toBe("5.19s");
    expect(container.querySelector(".extract-d .tree-row:nth-child(2) .tree-name")?.textContent).toBe("game.gdi");
    expect(container.querySelector(".extract-d .tree-row:nth-child(2) .tree-size")?.textContent).toBe("2 B");
  });
});

describe("apply workflow view - post-apply behavior selects", () => {
  afterEach(() => {
    setPostApplyDownloadBehaviorOverride(null);
    setPostApplyTestBehaviorOverride(null);
  });

  it("defaults both selects from their settings", () => {
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const { container } = renderView({
      settings: { postApplyDownloadBehavior: "show", postApplyTestBehavior: "auto-show" },
      ui,
    });
    const download = container.querySelector("#rom-weaver-select-post-apply-download") as HTMLSelectElement;
    const test = container.querySelector("#rom-weaver-select-post-apply-test") as HTMLSelectElement;
    expect(download.value).toBe("show");
    expect(test.value).toBe("auto-show");
  });

  it("shows the defaults and all action options", () => {
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const { container } = renderView({ ui });
    const download = container.querySelector("#rom-weaver-select-post-apply-download") as HTMLSelectElement;
    const test = container.querySelector("#rom-weaver-select-post-apply-test") as HTMLSelectElement;
    expect(download.value).toBe("auto-show");
    expect(Array.from(download.options, (option) => option.textContent)).toEqual([
      "Auto Start & DL Again Button (Default)",
      "DL Again Button",
    ]);
    expect(test.value).toBe("show");
    expect(Array.from(test.options, (option) => option.textContent)).toEqual([
      "Show After Apply (Default)",
      "Auto Test & Show After Apply",
      "Hide Button",
    ]);
  });

  it("overrides both session values without changing the persisted settings", () => {
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const settings = { postApplyDownloadBehavior: "auto-show" as const, postApplyTestBehavior: "show" as const };
    const { container } = renderView({ settings, ui });
    const download = container.querySelector("#rom-weaver-select-post-apply-download") as HTMLSelectElement;
    const test = container.querySelector("#rom-weaver-select-post-apply-test") as HTMLSelectElement;
    fireEvent.change(download, { target: { value: "show" } });
    fireEvent.change(test, { target: { value: "hide" } });

    const { container: second } = renderView({ settings, ui });
    const secondDownload = second.querySelector("#rom-weaver-select-post-apply-download") as HTMLSelectElement;
    const secondTest = second.querySelector("#rom-weaver-select-post-apply-test") as HTMLSelectElement;
    expect(secondDownload.value).toBe("show");
    expect(secondTest.value).toBe("hide");
  });
});

describe("apply workflow view - output options notice", () => {
  it("tells the user the options are not saved and Settings holds the defaults", () => {
    const { container } = renderView({ ui: { ...createEmptyPatcherUiState(), romInputs: [romRow("game.nes")] } });
    const note = container.querySelector(".outopts .optsnote");
    expect(note?.textContent).toBe("These choices are not saved. Change your defaults in Settings.");
    // It leads the body, so it covers every option below it rather than one field.
    expect(note?.nextElementSibling?.className).toContain("optsgrid");
  });
});

describe("apply workflow view - completed output actions", () => {
  afterEach(() => {
    setPostApplyDownloadBehaviorOverride(null);
    setPostApplyTestBehaviorOverride(null);
  });

  const completedOutputView = (
    postApplyDownloadBehavior: PostApplyActionBehavior,
    postApplyTestBehavior: PostApplyActionBehavior,
    fileName = "game.nes",
  ) =>
    renderView({
      emulatorOutput: { fileName, getBlob: async () => new Blob(["rom"]), id: "output-1" },
      outputOverrides: { disabled: false, pendingDownloadFileName: fileName },
      settings: { postApplyDownloadBehavior, postApplyTestBehavior },
      ui: { ...createEmptyPatcherUiState(), romInputs: [romRow(fileName)] },
    });

  const downloadBehaviorValues = ["auto-show", "show"] as const;
  const testBehaviorValues = ["show", "auto-show", "hide"] as const;
  const visibilityCases = downloadBehaviorValues.flatMap((downloadBehavior) =>
    testBehaviorValues.map((testBehavior) => [downloadBehavior, testBehavior, testBehavior !== "hide"] as const),
  );

  it.each(visibilityCases)("shows Download %s and Test %s", (downloadBehavior, testBehavior, showTest) => {
    const { container } = completedOutputView(downloadBehavior, testBehavior);
    expect(container.querySelector("#rom-weaver-button-apply")).toBeTruthy();
    expect(!!container.querySelector("#rom-weaver-button-test-emulator")).toBe(showTest);
    expect(container.querySelector("#rom-weaver-checkbox-play-button")).toBeNull();
  });

  it("keeps Download available when automatic Test is unsupported", () => {
    const { container } = completedOutputView("show", "auto-show", "game.bin");
    expect(container.querySelector("#rom-weaver-button-apply")).toBeTruthy();
    expect(container.querySelector("#rom-weaver-button-test-emulator")).toBeNull();
  });

  it("keeps Download available when visible Test is unsupported", () => {
    const { container } = completedOutputView("show", "show", "game.bin");
    expect(container.querySelector("#rom-weaver-button-apply")).toBeTruthy();
    expect(container.querySelector("#rom-weaver-button-test-emulator")).toBeNull();
  });

  it("retires the Test action when Apply retires the completed output", () => {
    const { container } = renderView({
      emulatorOutput: { fileName: "game.nes", getBlob: async () => new Blob(["rom"]), id: "output-1" },
      outputOverrides: { disabled: false, pendingDownloadFileName: null },
      settings: { postApplyDownloadBehavior: "show", postApplyTestBehavior: "show" },
      ui: { ...createEmptyPatcherUiState(), romInputs: [romRow("game.nes")] },
    });
    expect(container.querySelector("#rom-weaver-button-apply")).toBeTruthy();
    expect(container.querySelector("#rom-weaver-button-test-emulator")).toBeNull();
  });

  it("labels the button by where it goes, not by playing", () => {
    const { container } = completedOutputView("show", "show");
    const label = container.querySelector("#rom-weaver-button-test-emulator .play-label");
    expect(label?.textContent).toBe("Open in the Test tab");
  });
});

describe("apply workflow view - patch enable toggles", () => {
  it("collapses disabled patches, surfaces the off-note, and gates the run", () => {
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const { container } = renderView({
      patchEnablement: {
        disabledIds: new Set(["patch-1"]),
        getPatchIds: () => ["patch-1"],
        onToggle: () => undefined,
      },
      patches: [patchItem("change.ips")],
      ui,
    });
    const patchCard = container.querySelector("#rom-weaver-list-patch-stack .card");
    expect(patchCard?.classList.contains("is-disabled")).toBe(true);
    expect(patchCard?.querySelector(".patch-enable input")).toBeTruthy();
    expect(patchCard?.querySelector(".patch-body .patch-body-inner")).toBeTruthy();
    expect(container.querySelector(".patch-off-note")?.textContent).toContain("1 patch is off");
    const run = container.querySelector("#rom-weaver-button-apply") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    // the step header reports the enabled/disabled split
    expect(container.querySelector("#rom-weaver-row-patch-stack .step-meta")?.textContent).toContain("1 disabled");
  });
});

describe("apply workflow view - bundle controls", () => {
  const bundleExport = (bundleRom = false, busy = false) => {
    const state = {
      bundleRom,
      format: "zip",
    };
    return {
      busy,
      cancelExport: () => undefined,
      downloadable: false,
      error: "",
      progress: busy ? createProgressViewModel({ label: "Creating bundle", percent: 42 }) : null,
      ready: true,
      runExport: async () => undefined,
      setBundleRom: (value: boolean) => {
        state.bundleRom = value;
      },
      setFormat: (value: string) => {
        state.format = value;
      },
      get bundleRom() {
        return state.bundleRom;
      },
      get format() {
        return state.format;
      },
    };
  };

  const bundleTools = (setBundlePackage: (value: string) => void) => ({
    hasOptionalEntries: false,
    outputVerification: null,
    setBundlePackage,
  });

  it("keeps the sharing action full width at every panel size", () => {
    const shareRule = BUNDLE_FIELDS_CSS.match(/\.rw-app \.bundle-share\s*\{([^}]*)\}/)?.[1];
    const fullRowRule = BUNDLE_FIELDS_CSS.match(
      /\.rw-app \.bundle-share,\s*\.rw-app \.bundle-job-content > \.runprog\s*\{([^}]*)\}/,
    )?.[1];
    const romOptionRule = BUNDLE_FIELDS_CSS.match(/\.rw-app \.bundle-rom-option\s*\{([^}]*)\}/)?.[1];

    expect(romOptionRule).toContain("align-self: end");
    expect(fullRowRule).toContain("width: 100%");
    expect(shareRule).toContain("min-height: 40px");
    expect(BUNDLE_RESPONSIVE_CSS).not.toContain(".bundle-job .bundle-share");
  });

  it("persists archive and ROM choices from the sharing controls", () => {
    const exported = bundleExport();
    const setBundlePackage = vi.fn((value: string) => {
      const [format = "", contents = ""] = value.split(":");
      exported.setFormat(format);
      exported.setBundleRom(contents === "rom");
    });
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const view = () => (
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyWorkflowFormView
          bundleExport={exported}
          bundleTools={bundleTools(setBundlePackage)}
          controllers={{
            output: storeOf(outputState()) as unknown as PatcherOutputController,
            patchStack: storeOf({ items: [patchItem("change.ips")] }) as unknown as PatcherStackController,
            ui: storeOf(ui) as unknown as PatcherUiController,
          }}
        />
      </RomWeaverSettingsProvider>
    );
    const { container, rerender } = render(view());

    fireEvent.change(container.querySelector("#rom-weaver-bundle-export-format") as HTMLSelectElement, {
      target: { value: "7z" },
    });
    expect(setBundlePackage).toHaveBeenCalledWith("7z:patches");
    rerender(view());
    fireEvent.click(container.querySelector("#rom-weaver-bundle-export-bundle-rom") as HTMLInputElement);
    expect(setBundlePackage).toHaveBeenCalledWith("7z:rom");
  });

  it("names the export action when the ROM is included", () => {
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyWorkflowFormView
          bundleExport={bundleExport(true)}
          bundleTools={bundleTools(() => undefined)}
          controllers={{
            output: storeOf(outputState()) as unknown as PatcherOutputController,
            patchStack: storeOf({ items: [patchItem("change.ips")] }) as unknown as PatcherStackController,
            ui: storeOf(ui) as unknown as PatcherUiController,
          }}
        />
      </RomWeaverSettingsProvider>,
    );

    const shareButton = container.querySelector("#rom-weaver-button-export-bundle");
    expect(shareButton?.textContent).toContain("Share bundle");
    expect(shareButton?.classList).toContain("bundle-share");
    expect(shareButton?.parentElement?.classList).toContain("bundle-job-content");
    expect(container.querySelector("#rom-weaver-bundle-export-bundle-rom")).toBeTruthy();
    expect(container.querySelector(".bundle-rom-warning .notice")?.textContent).toContain("right to distribute it");
  });

  it("keeps the busy sharing action in the same full-row wrapper", () => {
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyWorkflowFormView
          bundleExport={bundleExport(false, true)}
          bundleTools={bundleTools(() => undefined)}
          controllers={{
            output: storeOf(outputState()) as unknown as PatcherOutputController,
            patchStack: storeOf({ items: [patchItem("change.ips")] }) as unknown as PatcherStackController,
            ui: storeOf(ui) as unknown as PatcherUiController,
          }}
        />
      </RomWeaverSettingsProvider>,
    );

    const progress = container.querySelector("#rom-weaver-bundle-export-progress");
    expect(progress?.classList).toContain("runprog");
    expect(progress?.parentElement?.classList).toContain("bundle-job-content");
  });

  it("keeps bundle settings out of ordinary Apply options", () => {
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyWorkflowFormView
          bundleExport={bundleExport()}
          bundleTools={bundleTools(() => undefined)}
          controllers={{
            output: storeOf(outputState()) as unknown as PatcherOutputController,
            patchStack: storeOf({ items: [patchItem("change.ips")] }) as unknown as PatcherStackController,
            ui: storeOf(ui) as unknown as PatcherUiController,
          }}
        />
      </RomWeaverSettingsProvider>,
    );

    expect(container.querySelector(".outopts #rom-weaver-bundle-export-format")).toBeNull();
    expect(container.querySelector("#rom-weaver-bundle-job")).toBeTruthy();
    expect((container.querySelector("#rom-weaver-bundle-export-format") as HTMLSelectElement).value).toBe("zip");
    expect(
      Array.from(
        (container.querySelector("#rom-weaver-bundle-export-format") as HTMLSelectElement).options,
        (option) => option.value,
      ),
    ).toEqual(["zip", "7z"]);
    expect(container.querySelector("#rom-weaver-button-export-bundle")).toBeTruthy();
  });

  it("offers sharing after a successful Apply, after the primary result controls", () => {
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyWorkflowFormView
          bundleExport={bundleExport()}
          bundleTools={bundleTools(() => undefined)}
          controllers={{
            output: storeOf(outputState({ pendingDownloadFileName: "game.bin" })) as unknown as PatcherOutputController,
            patchStack: storeOf({ items: [patchItem("change.ips")] }) as unknown as PatcherStackController,
            ui: storeOf(ui) as unknown as PatcherUiController,
          }}
        />
      </RomWeaverSettingsProvider>,
    );

    const job = container.querySelector("#rom-weaver-bundle-job");
    const toggle = job?.querySelector(".cks-head");
    expect(toggle?.textContent).toContain("Share this patch recipe (for patch creators)");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.querySelector(".readouts")?.textContent).toBe("optional");
    expect(job?.querySelector(".bundle-job")?.classList).not.toContain("is-open");
    fireEvent.click(toggle as HTMLButtonElement);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(job?.querySelector(".bundle-job")?.classList).toContain("is-open");
    expect(container.querySelector("#rom-weaver-button-apply")?.compareDocumentPosition(job || container)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(job?.querySelector("#rom-weaver-bundle-export-format")).toBeTruthy();
    expect(job?.querySelector("#rom-weaver-button-export-bundle")).toBeTruthy();
  });
});

/**
 * The staging Checks skeleton exists to reserve the height the resolved drawer will occupy, so the
 * two layouts have to agree on their GROUPS - a head the reservation forgets (or invents) is a
 * layout shift at the exact moment the card is supposed to settle. These pin that agreement.
 */
describe("apply workflow view - staging checks reservation", () => {
  const checksHeads = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("#rom-weaver-list-input-stack .ckrows .ck-group-head")).map(
      (el) => el.textContent,
    );

  const n64Variants = [
    { id: "raw", label: "Raw" },
    { id: "n64-byte-order:big-endian", label: "N64 byte order: big-endian" },
  ];

  const stagingN64Row = () => {
    const rom = romRow("game.n64");
    rom.info = { ...rom.info, checksumVariantPlan: n64Variants, crc32: "", validationPhase: "checksum" };
    rom.progress = { label: "Calculating checksums...", percent: 50 } as RomInputRowState["progress"];
    return rom;
  };

  it("reserves the same group heads the resolved drawer renders", () => {
    const staging = renderView({ ui: { ...createEmptyPatcherUiState(), romInputs: [stagingN64Row()] } });

    const resolved = romRow("game.n64");
    resolved.info = {
      ...resolved.info,
      checksumVariants: n64Variants.map((variant) => ({
        ...variant,
        checksums: { crc32: "C6FB1252", md5: "0".repeat(32), sha1: "0".repeat(40) },
      })),
      md5: "0".repeat(32),
      sha1: "0".repeat(40),
    } as RomInputRowState["info"];
    const settled = renderView({ ui: { ...createEmptyPatcherUiState(), romInputs: [resolved] } });

    // The base rows are bare only when they stand alone; a variant promotes them to "Unchanged".
    expect(checksHeads(staging.container)).toEqual(["Unchanged", "N64 byte order: big-endian"]);
    expect(checksHeads(settled.container)).toEqual(checksHeads(staging.container));
  });

  it("leaves the base rows bare on both sides when the ROM has no variants", () => {
    const rom = romRow("game.bin");
    rom.info = { ...rom.info, crc32: "", validationPhase: "checksum" };
    rom.progress = { label: "Calculating checksums...", percent: 50 } as RomInputRowState["progress"];
    const staging = renderView({ ui: { ...createEmptyPatcherUiState(), romInputs: [rom] } });
    const settled = renderView({ ui: { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] } });

    expect(checksHeads(staging.container)).toEqual([]);
    expect(checksHeads(settled.container)).toEqual([]);
  });

  it("renders the bundle's Expected group while the ROM is still hashing", () => {
    const patch = patchItem("change.bps");
    patch.validationValues = ["in crc32=C6FB1252"];
    const { container } = renderView({
      patches: [patch],
      ui: { ...createEmptyPatcherUiState(), romInputs: [stagingN64Row()] },
    });

    // Expected slots between the base group and the variants, exactly where it resolves.
    expect(checksHeads(container)).toEqual(["Unchanged", "Expected", "N64 byte order: big-endian"]);
    // The bundle supplies the value; only the match mark waits for the hash.
    const expectedGroup = container.querySelector("#rom-weaver-rom-expected-checks");
    expect(expectedGroup?.querySelector(".ck-v")?.textContent).toBe("C6FB1252");
    expect(expectedGroup?.querySelector(".ck-mark")).toBeNull();
  });
});
