// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CheatDatabaseSection } from "../../../src/public/react/components/cheat-database-section.tsx";
import type {
  CheatSystemShard,
  ClassifiedCheatRecord,
  DatabaseCheatClassifier,
  LocalCheatFileImporter,
  ManualCheatClassifier,
  RuntimeCheatRecord,
} from "../../../src/lib/cheats/index.ts";

const runtimeRecord = (id: string, description: string, rawCode: string): RuntimeCheatRecord => ({
  id,
  system: "snes",
  gameId: "smw-us",
  description,
  rawCode,
  rawFields: { code: rawCode },
  sourceFile: "Super Mario World (USA).cht",
  sourceIndex: Number(id.replace(/\D/gu, "") || 0),
  sourceRevision: "abc123",
});

const records: ClassifiedCheatRecord[] = [
  {
    record: runtimeRecord("cheat-1", "Infinite lives", "C2B4-6D07"),
    resolution: { type: "romBakeable", writes: [] },
    detectedKind: "game-genie",
  },
  {
    record: runtimeRecord("cheat-2", "Infinite health", "7E0DBE3F"),
    resolution: {
      type: "runtime",
      payload: { record: runtimeRecord("cheat-2", "Infinite health", "7E0DBE3F") },
    },
    detectedKind: "pro-action-replay",
  },
  {
    record: runtimeRecord("cheat-3", "Moon jump", "7E0010FF+C00000EA"),
    resolution: {
      type: "mixed",
      writes: [],
      payload: { record: runtimeRecord("cheat-3", "Moon jump", "7E0010FF+C00000EA") },
    },
    detectedKind: null,
  },
  {
    record: runtimeRecord("cheat-4", "Starting lives XX", "7E0DBEXX"),
    resolution: {
      type: "requiresParameter",
      payload: { record: runtimeRecord("cheat-4", "Starting lives XX", "7E0DBEXX") },
    },
    detectedKind: null,
  },
];

// The dialog pages 8 rows at a time; the extra filler makes a second page.
const pagedRecords: ClassifiedCheatRecord[] = [
  ...records,
  ...Array.from({ length: 6 }, (_unused, index) => ({
    record: runtimeRecord(`filler-${index + 1}`, `Filler cheat ${index + 1}`, `F00D000${index + 1}`),
    resolution: { type: "romBakeable" as const, writes: [] },
    detectedKind: "game-genie",
  })),
];

const makeShard = (entries: ClassifiedCheatRecord[]): CheatSystemShard => ({
  schemaVersion: 1,
  system: "snes",
  games: [
    {
      id: "smw-us",
      title: "Super Mario World",
      normalizedTitle: "super mario world",
      regions: ["USA"],
      revisions: ["Rev 1"],
      sourceFiles: ["Super Mario World (USA).cht"],
      checksums: [{ sha1: "AA11" }],
      cheats: entries.map(({ record }) => record),
    },
  ],
});

const shard = makeShard(records);

const makeClassifier =
  (entries: ClassifiedCheatRecord[]): DatabaseCheatClassifier =>
  async (input) =>
    input.map((record) => entries.find((entry) => entry.record.id === record.id) as ClassifiedCheatRecord);

const classifyDatabaseCheats = makeClassifier(records);

const classifyManualCode: ManualCheatClassifier = async (request) => ({
  record: {
    record: runtimeRecord("manual-1", request.description, request.code),
    resolution: {
      type: "runtime",
      payload: { record: runtimeRecord("manual-1", request.description, request.code) },
    },
    detectedKind: "pro-action-replay",
  },
  detectedSystem: request.system,
  detectedType: "Action Replay",
});

const importLocalCheatFile: LocalCheatFileImporter = async ({ fileName }) => [
  {
    detectedKind: "pro-action-replay",
    record: {
      ...runtimeRecord("local-1", "Imported health", "7E0010FF"),
      sourceFile: fileName,
      sourceRevision: "local-import",
    },
    resolution: {
      payload: {
        record: {
          ...runtimeRecord("local-1", "Imported health", "7E0010FF"),
          sourceFile: fileName,
          sourceRevision: "local-import",
        },
      },
      type: "runtime",
    },
  },
];

const props = {
  rom: { key: "rom-a", system: "snes", title: "Super Mario World", checksums: { sha1: "aa11" } },
  shard,
  classifyDatabaseCheats,
  importLocalCheatFile,
  classifyManualCode,
} as const;

/** Open the picker and wait for its rows. */
const openDialog = async (view: ReturnType<typeof render>) => {
  fireEvent.click(view.getByRole("button", { name: /Search the cheat database/u }));
  await view.findByText("Infinite lives");
};

const addButton = (view: ReturnType<typeof render>, description: string) =>
  view.getByRole("button", { name: `Add ${description}` });

describe("CheatDatabaseSection", () => {
  it("renders the numbered step, the match line, and the database credit", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await waitFor(() => expect(view.container.querySelector(".step-num")?.textContent).toBe("0x04"));
    expect(view.container.querySelector(".step-title")?.textContent).toBe("Cheats");
    expect(view.getByText("0 cheats")).toBeTruthy();
    expect(view.getByText("optional")).toBeTruthy();
    expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain("Exact checksum match");
    expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain("4 database cheats");
    expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain("libretro-database CC-BY-SA-4.0");
  });

  it("keeps the data-quality notices in the picker", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await openDialog(view);
    expect(view.getByText(/Community cheat data can contain errors/u)).toBeTruthy();
    expect(view.getByText(/does not upload ROM data or checksums/u)).toBeTruthy();
  });

  it("shows conflict and separate ROM and cheat-file output summaries", async () => {
    const view = render(
      <CheatDatabaseSection
        {...props}
        outputSummary={{ cheatFileName: "game-modified.cht", rom: 1, runtime: 2 }}
        validationMessage="Cheat conflict at ROM offset 0x2871."
      />,
    );
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Cheat conflict at ROM offset 0x2871"));
    expect(view.getByText(/Contains patches and 1 baked ROM cheat/u)).toBeTruthy();
    expect(view.getByText(/game-modified\.cht contains 2 RAM or runtime cheats/u)).toBeTruthy();
  });

  it("searches the picker by description and by raw code", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await openDialog(view);

    fireEvent.change(view.getByRole("searchbox"), { target: { value: "health" } });
    expect(view.getByText("Infinite health")).toBeTruthy();
    expect(view.queryByText("Infinite lives")).toBeNull();

    fireEvent.change(view.getByRole("searchbox"), { target: { value: "c2b4" } });
    expect(view.getByText("Infinite lives")).toBeTruthy();
    expect(view.queryByText("Infinite health")).toBeNull();

    fireEvent.change(view.getByRole("searchbox"), { target: { value: "" } });
    expect(view.getByText("Moon jump")).toBeTruthy();
  });

  it("pages the picker eight rows at a time", async () => {
    const view = render(
      <CheatDatabaseSection
        {...props}
        classifyDatabaseCheats={makeClassifier(pagedRecords)}
        shard={makeShard(pagedRecords)}
      />,
    );
    await openDialog(view);

    expect(view.getByText("1 / 2")).toBeTruthy();
    expect(view.queryByText("Filler cheat 5")).toBeNull();
    expect((view.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(view.getByRole("button", { name: "Next" }));
    expect(view.getByText("2 / 2")).toBeTruthy();
    expect(view.getByText("Filler cheat 5")).toBeTruthy();
    expect(view.queryByText("Infinite lives")).toBeNull();
    expect((view.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(view.getByRole("button", { name: "Previous" }));
    expect(view.getByText("1 / 2")).toBeTruthy();
  });

  it("adds a cheat as a card, then removes it from the picker", async () => {
    const onSelectionChange = vi.fn();
    const view = render(<CheatDatabaseSection {...props} onSelectionChange={onSelectionChange} />);
    await openDialog(view);

    fireEvent.click(addButton(view, "Infinite health"));
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ record: expect.objectContaining({ id: "cheat-2" }) }),
    ]);
    expect(view.container.querySelectorAll("#rom-weaver-list-cheat-stack > .card.file.patch")).toHaveLength(1);
    expect(view.getByText("1 cheat")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Remove Infinite health" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
    expect(view.container.querySelector("#rom-weaver-list-cheat-stack")).toBeNull();
  });

  it("cannot add an entry that still needs a value", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await openDialog(view);
    expect((addButton(view, "Starting lives XX") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a card when its switch goes off and drops it when removed", async () => {
    const onSelectionChange = vi.fn();
    const view = render(<CheatDatabaseSection {...props} onSelectionChange={onSelectionChange} />);
    await openDialog(view);
    fireEvent.click(addButton(view, "Infinite lives"));
    fireEvent.click(view.getByRole("button", { name: "Close" }));

    const toggle = view.getByRole("checkbox", { name: "Include Infinite lives" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
    expect(view.getByText("Infinite lives")).toBeTruthy();

    fireEvent.click(view.getByRole("checkbox", { name: "Include Infinite lives" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ record: expect.objectContaining({ id: "cheat-1" }) }),
    ]);

    fireEvent.click(view.getByRole("button", { name: "Remove Infinite lives from the cheat stack" }));
    expect(view.queryByText("Infinite lives")).toBeNull();
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it("shows the cheat kind and source in the card drawer", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await openDialog(view);
    fireEvent.click(addButton(view, "Moon jump"));
    fireEvent.click(view.getByRole("button", { name: "Close" }));

    expect(view.getByText("raw RAM write")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Cheat raw RAM write" }));
    expect(view.getByText("Super Mario World (USA).cht at abc123")).toBeTruthy();
  });

  it("clears cards and selections when the original ROM identity changes", async () => {
    const onSelectionChange = vi.fn();
    const view = render(<CheatDatabaseSection {...props} onSelectionChange={onSelectionChange} />);
    await openDialog(view);
    fireEvent.click(addButton(view, "Infinite lives"));

    view.rerender(
      <CheatDatabaseSection {...props} onSelectionChange={onSelectionChange} rom={{ ...props.rom, key: "rom-b" }} />,
    );
    await waitFor(() => expect(view.container.querySelector("#rom-weaver-list-cheat-stack")).toBeNull());
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it("keeps cards through a harmless host rerender", async () => {
    const view = render(<CheatDatabaseSection {...props} onSelectionChange={vi.fn()} />);
    await openDialog(view);
    fireEvent.click(addButton(view, "Infinite lives"));
    fireEvent.click(view.getByRole("button", { name: "Close" }));

    view.rerender(<CheatDatabaseSection {...props} onSelectionChange={vi.fn()} />);
    expect((view.getByRole("checkbox", { name: "Include Infinite lives" }) as HTMLInputElement).checked).toBe(true);
  });

  it("classifies a manual code in the picker and adds it as a card", async () => {
    const onSelectionChange = vi.fn();
    const view = render(<CheatDatabaseSection {...props} onSelectionChange={onSelectionChange} />);
    await openDialog(view);

    fireEvent.click(view.getByRole("button", { name: "Add code manually" }));
    fireEvent.change(view.getByLabelText("Cheat code"), { target: { value: "7E0010FF" } });
    fireEvent.change(view.getByLabelText("Code type"), { target: { value: "pro-action-replay" } });
    fireEvent.click(view.getByRole("button", { name: "Check code" }));
    await view.findByText(/Detected SNES · Action Replay/u);
    fireEvent.click(view.getByRole("button", { name: "Add this cheat" }));

    expect(onSelectionChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ record: expect.objectContaining({ id: "manual-1" }) }),
    ]);
    expect(view.getByRole("checkbox", { name: "Include Manual cheat" })).toBeTruthy();
  });

  it("clears a manual classification after the user changes its inputs", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await openDialog(view);
    fireEvent.click(view.getByRole("button", { name: "Add code manually" }));
    fireEvent.change(view.getByLabelText("Cheat code"), { target: { value: "7E0010FF" } });
    fireEvent.click(view.getByRole("button", { name: "Check code" }));
    await view.findByRole("button", { name: "Add this cheat" });

    fireEvent.change(view.getByLabelText("Cheat code"), { target: { value: "7E0011FF" } });
    expect(view.queryByRole("button", { name: "Add this cheat" })).toBeNull();
  });

  it("imports a local RetroArch file as an unselected card", async () => {
    const onSelectionChange = vi.fn();
    const importer = vi.fn(importLocalCheatFile);
    const view = render(
      <CheatDatabaseSection {...props} importLocalCheatFile={importer} onSelectionChange={onSelectionChange} />,
    );
    await openDialog(view);
    const file = new File(['cheat0_desc = "Imported health"'], "private.cht", { type: "text/plain" });

    fireEvent.change(view.getByLabelText("Import RetroArch .cht"), { target: { files: [file] } });

    await view.findByText("Imported 1 cheat from private.cht.");
    expect(importer).toHaveBeenCalledWith({
      content: 'cheat0_desc = "Imported health"',
      fileName: "private.cht",
      system: "snes",
    });
    const toggle = view.getByRole("checkbox", { name: "Include Imported health" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ record: expect.objectContaining({ id: "local-1" }) }),
    ]);
  });

  it("ignores a pending local import after the ROM changes", async () => {
    const onSelectionChange = vi.fn();
    let finishImport: ((imported: ClassifiedCheatRecord[]) => void) | undefined;
    const importer = vi.fn(
      () =>
        new Promise<ClassifiedCheatRecord[]>((resolve) => {
          finishImport = resolve;
        }),
    );
    const view = render(
      <CheatDatabaseSection {...props} importLocalCheatFile={importer} onSelectionChange={onSelectionChange} />,
    );
    await openDialog(view);
    const file = new File(['cheat0_desc = "Imported health"'], "private.cht", { type: "text/plain" });
    fireEvent.change(view.getByLabelText("Import RetroArch .cht"), { target: { files: [file] } });
    await waitFor(() => expect(importer).toHaveBeenCalledOnce());

    view.rerender(
      <CheatDatabaseSection
        {...props}
        importLocalCheatFile={importer}
        onSelectionChange={onSelectionChange}
        rom={{ ...props.rom, key: "rom-b" }}
      />,
    );
    const importedRecords = await importLocalCheatFile({ content: "", fileName: "private.cht", system: "snes" });
    finishImport?.(importedRecords);

    await waitFor(() => expect(view.queryByText("Imported health")).toBeNull());
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it("shows manual browsing as unverified and keeps controls within their container", async () => {
    const view = render(
      <CheatDatabaseSection
        {...props}
        rom={{ key: "unknown", system: "snes", title: "Unknown game", checksums: { sha1: "no-match" } }}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: /Search the cheat database/u }));
    fireEvent.change(view.getByLabelText("Browse games for SNES"), { target: { value: "smw-us" } });
    await view.findByText("Infinite lives");
    expect(view.getByText(/ROM revision is unverified/u)).toBeTruthy();
    expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain("Game selected manually");
    expect(view.container.querySelectorAll("input, select, textarea, button").length).toBeGreaterThan(0);
  });
});
