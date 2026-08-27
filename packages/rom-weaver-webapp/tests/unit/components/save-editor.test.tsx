// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveEditor } from "../../../src/webapp/components/save-editor.tsx";

const { identifySave, inspectSave, previewSaveFields, setSaveFields, listEmulatorSaves, replaceEmulatorSaveSram } =
  vi.hoisted(() => ({
    identifySave: vi.fn(),
    inspectSave: vi.fn(),
    previewSaveFields: vi.fn(),
    setSaveFields: vi.fn(),
    listEmulatorSaves: vi.fn(),
    replaceEmulatorSaveSram: vi.fn(),
  }));

vi.mock("../../../src/platform/browser/browser-save-api.ts", () => ({
  identifySave,
  inspectSave,
  previewSaveFields,
  setSaveFields,
}));
vi.mock("../../../src/storage/browser/emulator-saves.ts", () => ({
  listEmulatorSaves,
  replaceEmulatorSaveSram,
}));

afterEach(cleanup);

const documentResult = (fields) => ({
  document: {
    active_slot: 0,
    counter: 8,
    handler_id: "pokemon-gen3",
    identity: { family: "gen3", id: "pokemon-ruby", name: "Ruby" },
    integrity: { issues: [], state: "valid" },
    platform: "gba",
    save_format: "gba_flash_128k",
    save_format_name: "Flash 128 KiB",
    save_size: 131072,
    sections: [],
    fields,
    warnings: [],
  },
});
const textField = (overrides = {}) => ({
  constraints: { choices: [], max: null, max_length: 8, min: null },
  description: "Trainer name",
  editable: true,
  encoding: "pokemon_gen3_english",
  id: "name",
  kind: "text",
  label: "Name",
  section_id: 0,
  step: null,
  value: { text: "ASH" },
  warnings: [],
  ...overrides,
});
const moneyField = (overrides = {}) => ({
  constraints: { choices: [], min: 0, max: 999999, max_length: null },
  description: "Money",
  editable: true,
  encoding: null,
  id: "money",
  kind: "unsigned_integer",
  label: "Money",
  section_id: 1,
  step: 1,
  value: { u32: 5000 },
  warnings: [],
  ...overrides,
});
const genericFields = [
  textField({ id: "trainer.name" }),
  moneyField({ id: "trainer.money", kind: "unsigned_integer" }),
  {
    constraints: { choices: ["male", "female"], max: null, max_length: null, min: null },
    description: "Gender",
    editable: true,
    encoding: null,
    id: "trainer.gender",
    kind: "enum",
    label: "Gender",
    section_id: 0,
    step: null,
    value: { enum: "male" },
    warnings: [],
  },
  {
    constraints: { choices: [], max: null, max_length: null, min: null },
    description: "Badge",
    editable: false,
    encoding: null,
    id: "progress.badge_1",
    kind: "read_only_integer",
    label: "Badge 1",
    section_id: 2,
    step: null,
    value: { u32: 1 },
    warnings: [],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  listEmulatorSaves.mockResolvedValue([]);
  identifySave.mockResolvedValue({
    recognition: {
      candidates: [{ identity: { family: "gen3", id: "pokemon-ruby", name: "Ruby" } }],
      outcome: { recognized: {} },
    },
  });
  inspectSave.mockResolvedValue(documentResult([textField(), moneyField()]));
  previewSaveFields.mockResolvedValue({ preview: { changed: true, changes: [{ field: "money" }] } });
  setSaveFields.mockResolvedValue({
    output: { dispose: vi.fn(), fileName: "edited.sav", path: "/work/edited.sav", saveAs: vi.fn(), size: 10, vfs: {} },
  });
  replaceEmulatorSaveSram.mockImplementation(async (gameId: string, data: Uint8Array) => ({
    gameId,
    gameName: gameId,
    label: "Ruby",
    sram: new Uint8Array(data),
    state: new Uint8Array([3]),
    updatedAt: 2,
  }));
});

const chooseFile = async (name = "game.sav") => {
  const input = document.querySelector("input[type=file]");
  if (!(input instanceof HTMLInputElement)) throw new Error("save input missing");
  fireEvent.change(input, { target: { files: [new File(["save"], name)] } });
  await waitFor(() => expect(screen.getByLabelText("Name")).toBeTruthy());
};

describe("SaveEditor", () => {
  it("renders generated text and integer controls", async () => {
    render(<SaveEditor onSessionChange={vi.fn()} />);
    await chooseFile();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("ASH");
    expect((screen.getByLabelText("Money") as HTMLInputElement).value).toBe("5000");
  });

  it("supports generic field kinds and groups fields by their id prefix", async () => {
    inspectSave.mockResolvedValueOnce(documentResult(genericFields));
    render(<SaveEditor onSessionChange={vi.fn()} />);
    await chooseFile();
    expect(screen.getByRole("group", { name: "trainer" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "progress" })).toBeTruthy();
    expect((screen.getByLabelText("Gender") as HTMLSelectElement).value).toBe("male");
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("shows a field error and keeps the previous value for invalid integers", async () => {
    render(<SaveEditor onSessionChange={vi.fn()} />);
    await chooseFile();
    fireEvent.change(screen.getByLabelText("Money"), { target: { value: "1000000" } });
    expect(screen.getByRole("alert").textContent).toContain("allowed range");
    expect((screen.getByLabelText("Money") as HTMLInputElement).value).toBe("5000");
  });

  it("shows pending changes, supports one-field reset, all reset, and dry-run preview", async () => {
    render(<SaveEditor onSessionChange={vi.fn()} />);
    await chooseFile();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "MAY" } });
    expect(screen.getByText("ASH → MAY")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Preview changes" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await waitFor(() => expect(screen.getByText(/field changes/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Reset Name" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("ASH");
    fireEvent.change(screen.getByLabelText("Money"), { target: { value: "7000" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect((screen.getByLabelText("Money") as HTMLInputElement).value).toBe("5000");
  });

  it("locks field changes while Rust creates an edited save", async () => {
    let finish: (value: object) => void = () => undefined;
    setSaveFields.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<SaveEditor onSessionChange={vi.fn()} />);
    await chooseFile();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "MAY" } });
    fireEvent.click(screen.getByRole("button", { name: "Download edited copy" }));
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true));
    finish({
      output: {
        dispose: vi.fn(),
        fileName: "edited.sav",
        path: "/work/edited.sav",
        saveAs: vi.fn(),
        size: 10,
        vfs: {},
      },
    });
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false));
  });

  it("shows ambiguous and unsupported recognition states", async () => {
    identifySave.mockResolvedValueOnce({
      recognition: {
        candidates: [
          { identity: { family: "a", id: "a", name: "A" } },
          { identity: { family: "b", id: "b", name: "B" } },
        ],
        outcome: { ambiguous: {} },
      },
    });
    render(<SaveEditor onSessionChange={vi.fn()} />);
    const input = document.querySelector("input[type=file]");
    if (!(input instanceof HTMLInputElement)) throw new Error("save input missing");
    fireEvent.change(input, { target: { files: [new File(["save"], "ambiguous.sav")] } });
    await waitFor(() => expect(screen.getByText("Choose the game format")).toBeTruthy());

    identifySave.mockResolvedValueOnce({ recognition: { candidates: [], outcome: { unsupported: {} } } });
    fireEvent.change(document.querySelector("input[type=file]"), {
      target: { files: [new File(["save"], "bad.sav")] },
    });
    await waitFor(() => expect(screen.getByText(/does not have an editor/)).toBeTruthy());
  });

  it("does not label emulator save states as SRAM", async () => {
    listEmulatorSaves.mockResolvedValueOnce([
      {
        gameId: "state-only",
        gameName: "State only",
        label: "State only",
        state: new Uint8Array([1]),
        updatedAt: 1,
      },
    ]);
    render(<SaveEditor onSessionChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("No stored SRAM records.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /State only/ })).toBeNull();
  });

  it("confirms SRAM replacement and supports one-session undo", async () => {
    listEmulatorSaves.mockResolvedValueOnce([
      {
        gameId: "pokemon-ruby",
        gameName: "pokemon-ruby",
        label: "Ruby",
        sram: new Uint8Array([1, 2]),
        state: new Uint8Array([3]),
        updatedAt: 1,
      },
    ]);
    const getFile = vi.fn(async () => new File([new Uint8Array([9, 8])], "edited.sav"));
    setSaveFields.mockResolvedValueOnce({
      output: {
        dispose: vi.fn(),
        fileName: "edited.sav",
        path: "/work/edited.sav",
        saveAs: vi.fn(),
        size: 2,
        vfs: { getFile },
      },
    });
    render(<SaveEditor onSessionChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Ruby/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Ruby/ }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "MAY" } });
    fireEvent.click(screen.getByRole("button", { name: "Download edited copy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Replace selected SRAM" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Replace selected SRAM" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(replaceEmulatorSaveSram).toHaveBeenCalledWith(
        "pokemon-ruby",
        expect.any(Uint8Array),
        new Uint8Array([1, 2]),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo replacement" }));
    await waitFor(() =>
      expect(replaceEmulatorSaveSram).toHaveBeenLastCalledWith(
        "pokemon-ruby",
        new Uint8Array([1, 2]),
        new Uint8Array([9, 8]),
      ),
    );
  });
});
