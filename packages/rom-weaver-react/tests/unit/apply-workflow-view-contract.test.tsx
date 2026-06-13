// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

const renderView = ({ patches = [] as PatchStackItemState[], ui }: { patches?: PatchStackItemState[]; ui: PatcherUiState }) => {
  const controllers = {
    dialog: storeOf({ ...createInitialDialogState() }) as unknown as DialogController,
    output: storeOf(outputState()) as unknown as PatcherOutputController,
    patchStack: { ...storeOf({ items: patches }), removeItem: () => undefined, reorder: () => undefined } as unknown as PatcherStackController,
    ui: storeOf(ui) as unknown as PatcherUiController,
  };
  return render(
    <RomWeaverSettingsProvider settings={{}}>
      <ApplyWorkflowFormView controllers={controllers} />
    </RomWeaverSettingsProvider>,
  );
};

describe("apply workflow view — empty bench", () => {
  it("renders the 0x01–0x04 loom steps with the unified input and directives", () => {
    const { container } = renderView({ ui: createEmptyPatcherUiState() });
    // 0x01 hero with the stable unified-input id
    expect(container.querySelector("section.step.is-input.is-empty")).toBeTruthy();
    expect(container.querySelector("#rom-weaver-input-file-unified")).toBeTruthy();
    expect(container.querySelector(".drop.hero .formats .fmt")).toBeTruthy();
    // step numbering
    const numbers = Array.from(container.querySelectorAll(".step-num")).map((el) => el.textContent);
    expect(numbers).toEqual(["0x01", "0x02", "0x03", "0x04"]);
    // empty sections point back to 0x01 instead of offering their own drop
    expect(container.querySelectorAll("button.needs-input").length).toBe(2);
    // the output card stays on the bench, disabled
    expect(container.querySelector("#rom-weaver-input-output-file-name")).toBeTruthy();
    expect(container.querySelector("#rom-weaver-select-output-format")).toBeTruthy();
    const run = container.querySelector("#rom-weaver-button-apply") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
  });
});

describe("apply workflow view — staged bench", () => {
  it("renders ROM and patch cards with the structural classes the browser tests query", () => {
    const ui = { ...createEmptyPatcherUiState(), romInputs: [romRow("game.bin")] };
    const { container } = renderView({ patches: [patchItem("change.ips")], ui });
    // ROM card in the input stack
    const romCard = container.querySelector("#rom-weaver-list-input-stack .card.file");
    expect(romCard).toBeTruthy();
    expect(romCard?.querySelector(".card-name .nmline .nm")?.textContent).toBe("game.bin");
    // checksum rows use the .ck/.ck-k/.ck-v readout structure
    const checksumLabels = Array.from(romCard?.querySelectorAll(".ck .ck-k") || []).map((el) => el.textContent);
    expect(checksumLabels).toContain("CRC32");
    // patch card with verdict + format meta
    const patchCard = container.querySelector("#rom-weaver-list-patch-stack .card.patch");
    expect(patchCard).toBeTruthy();
    expect(patchCard?.classList.contains("ok")).toBe(true);
    expect(patchCard?.querySelector(".card-meta .meta-fmt")?.textContent).toBe("ips");
    expect(patchCard?.querySelector(".card-meta .fsize")?.textContent).toBeTruthy();
    // the patches step header counts staged files
    expect(container.querySelector("#rom-weaver-row-patch-stack .step-meta .rb")?.textContent).toContain("1 file");
    // no needs-input directives once content is staged
    expect(container.querySelectorAll("button.needs-input").length).toBe(0);
  });
});
