// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import type {
  DialogController,
  PatcherOutputController,
  PatcherStackController,
  PatcherUiController,
} from "../../src/public/react/patcher-form.ts";
import type { PatcherOutputState, PatchStackItemState } from "../../src/public/react/patcher-presentation.ts";
import type { PatcherUiState, RomInputRowState } from "../../src/public/react/patcher-ui-state.ts";
import { createEmptyPatcherUiState, createInitialDialogState } from "../../src/public/react/patcher-ui-state.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";

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
    applyButton: { disabled: true, label: "WEAVE & DOWNLOAD", loading: false, progress: null, title: "" },
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
  const base = createEmptyPatcherUiState();
  return {
    ...base.romInput,
    groupId: "",
    id: `rom:${fileName}`,
    info: { ...base.romInfo, crc32: "C6FB1252", fileName },
    kind: "rom",
    order: 0,
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
  onUnifiedDrop,
  patches = [] as PatchStackItemState[],
  patchEnablement,
  pendingDrops,
  ui,
}: {
  onUnifiedDrop?: Parameters<typeof ApplyWorkflowFormView>[0]["onUnifiedDrop"];
  patches?: PatchStackItemState[];
  patchEnablement?: Parameters<typeof ApplyWorkflowFormView>[0]["patchEnablement"];
  pendingDrops?: Parameters<typeof ApplyWorkflowFormView>[0]["pendingDrops"];
  ui: PatcherUiState;
}) => {
  const controllers = {
    dialog: storeOf({ ...createInitialDialogState() }) as unknown as DialogController,
    output: storeOf(outputState()) as unknown as PatcherOutputController,
    patchStack: {
      ...storeOf({ items: patches }),
      removeItem: () => undefined,
      reorder: () => undefined,
    } as unknown as PatcherStackController,
    ui: storeOf(ui) as unknown as PatcherUiController,
  };
  return render(
    <RomWeaverSettingsProvider settings={{}}>
      <ApplyWorkflowFormView
        controllers={controllers}
        onUnifiedDrop={onUnifiedDrop}
        patchEnablement={patchEnablement}
        pendingDrops={pendingDrops}
      />
    </RomWeaverSettingsProvider>,
  );
};

describe("apply workflow view - empty bench", () => {
  it("renders only the 0x01 hero", () => {
    const { container } = renderView({ ui: createEmptyPatcherUiState() });
    // 0x01 hero with the stable unified-input id
    expect(container.querySelector("section.step.is-input.is-empty")).toBeTruthy();
    expect(container.querySelector("#rom-weaver-input-file-unified")).toBeTruthy();
    expect(container.querySelector(".drop.hero .formats .fmt")).toBeTruthy();
    const sample = container.querySelector(".first-weave-demo button") as HTMLButtonElement;
    expect(sample.textContent).toContain("Try a sample apply");
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

    fireEvent.click(container.querySelector(".first-weave-demo button") as HTMLButtonElement);

    await vi.waitFor(() => expect(onUnifiedDrop).toHaveBeenCalledOnce());
    const [files] = onUnifiedDrop.mock.calls[0] as [File[]];
    expect(fetchMock).toHaveBeenCalledWith("/first-weave.zip");
    expect(files[0]?.name).toBe("first-weave.zip");
    vi.unstubAllGlobals();
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
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
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
    // checksum rows use the .ck/.ck-k/.ck-v readout structure
    const checksumLabels = Array.from(romCard?.querySelectorAll(".ck .ck-k") || []).map((el) => el.textContent);
    expect(checksumLabels).toContain("CRC32");
    // patch card with verdict + format meta
    const patchCard = container.querySelector("#rom-weaver-list-patch-stack .card.patch");
    expect(patchCard).toBeTruthy();
    expect(patchCard?.classList.contains("ok")).toBe(true);
    expect(patchCard?.querySelector(".card-meta .meta-fmt")?.textContent).toBe("ips");
    expect(patchCard?.querySelector(".card-meta .fsize")?.textContent).toBeTruthy();
    const patchPosition = patchCard?.querySelector("button.phandle") as HTMLButtonElement;
    expect(patchPosition.textContent).toContain("1");
    expect(patchPosition.disabled).toBe(true);
    expect(patchPosition.getAttribute("aria-label")).toBe("Patch 1 of 1. Reordering unavailable.");
    // the patches step header counts staged files
    expect(container.querySelector("#rom-weaver-row-patch-stack .step-meta .rb")?.textContent).toContain("1 file");
    // no needs-input directives once content is staged
    expect(container.querySelectorAll("button.needs-input").length).toBe(0);
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
  const bundleExport = (bundleRom = false) => ({
    bundleRom,
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
  });

  const bundleTools = (setBundlePackage: (value: string) => void, exportVisible = true) => ({
    exportVisible,
    hasOptionalEntries: false,
    outputVerification: null,
    setBundlePackage,
  });

  it("persists the bundle package when the Output options dropdown changes", () => {
    const setBundlePackage = vi.fn();
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyWorkflowFormView
          bundleExport={bundleExport()}
          bundleTools={bundleTools(setBundlePackage)}
          controllers={{
            output: storeOf(outputState()) as unknown as PatcherOutputController,
            patchStack: storeOf({ items: [patchItem("change.ips")] }) as unknown as PatcherStackController,
            ui: storeOf(ui) as unknown as PatcherUiController,
          }}
        />
      </RomWeaverSettingsProvider>,
    );

    fireEvent.change(container.querySelector("#rom-weaver-bundle-export-format") as HTMLSelectElement, {
      target: { value: "" },
    });
    expect(setBundlePackage).toHaveBeenCalledWith("");
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

    expect(container.querySelector("#rom-weaver-button-export-bundle")?.textContent).toContain("Create ZIP ROM Bundle");
  });

  it("keeps the bundle dropdown in Output options and drops the create action when hidden", () => {
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyWorkflowFormView
          bundleExport={bundleExport()}
          bundleTools={bundleTools(() => undefined, false)}
          controllers={{
            output: storeOf(outputState()) as unknown as PatcherOutputController,
            patchStack: storeOf({ items: [patchItem("change.ips")] }) as unknown as PatcherStackController,
            ui: storeOf(ui) as unknown as PatcherUiController,
          }}
        />
      </RomWeaverSettingsProvider>,
    );

    const select = container.querySelector("#rom-weaver-bundle-export-format") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe("");
    expect(container.querySelector("#rom-weaver-button-export-bundle")).toBeNull();
    expect(container.querySelector("#rom-weaver-button-create-bundle")).toBeNull();
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
