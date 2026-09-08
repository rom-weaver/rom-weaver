// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CheatDatabaseSection } from "../../../src/public/react/components/cheat-database-section.tsx";
import type {
  CheatDatabaseIndex,
  CheatRecord,
  CheatSystemShard,
  ClassifiedCheatRecord,
  DatabaseCheatClassifier,
  ManualCheatClassifier,
} from "../../../src/lib/cheats/index.ts";

const cheatRecord = (id: string, description: string, rawCode: string): CheatRecord => ({
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
    record: cheatRecord("cheat-1", "Infinite lives", "C2B4-6D07"),
    resolution: { type: "romBakeable", writes: [] },
    detectedKind: "game-genie",
  },
  {
    record: cheatRecord("cheat-2", "Infinite health", "7E0DBE3F"),
    resolution: { type: "unsupported", reason: "the code targets runtime memory" },
    detectedKind: "pro-action-replay",
  },
];

// The dialog pages 8 rows at a time; the extra filler makes a second page.
const pagedRecords: ClassifiedCheatRecord[] = [
  ...records,
  ...Array.from({ length: 7 }, (_unused, index) => ({
    record: cheatRecord(`filler-${index + 1}`, `Filler cheat ${index + 1}`, `F00D000${index + 1}`),
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
    record: cheatRecord("manual-1", request.description, request.code),
    resolution: { type: "romBakeable", writes: [] },
    detectedKind: "pro-action-replay",
  },
  detectedSystem: request.system,
  detectedType: "Action Replay",
});

const SNES = "Nintendo - Super Nintendo Entertainment System";

const index: CheatDatabaseIndex = {
  sourceRevision: "abc123",
  sourceUrl: "https://github.com/libretro/libretro-database",
  license: "CC-BY-SA-4.0",
  entries: [
    {
      platform: SNES,
      slug: "nintendo-super-nintendo-entertainment-system",
      cheatSystem: "snes",
      file: "cheats-nintendo-super-nintendo-entertainment-system.json",
      rawBytes: 100,
      sha256: "a".repeat(64),
      games: 1,
      cheats: 2,
    },
  ],
};

const props = {
  rom: { key: "rom-a", platform: SNES, title: "Super Mario World", checksums: { sha1: "aa11" } },
  index,
  shard,
  classifyDatabaseCheats,
  classifyManualCode,
  title: "Cheats",
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
    expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain("2 database cheats");
    expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain(
      "libretro/libretro-database CC-BY-SA-4.0",
    );
  });

  it("keeps the data-quality notices in the picker", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await openDialog(view);
    expect(view.getByText(/Community cheat data can contain errors/u)).toBeTruthy();
    expect(view.getByText(/does not upload ROM data or checksums/u)).toBeTruthy();
  });

  it("shows the conflict message and the baked ROM cheat summary", async () => {
    const view = render(
      <CheatDatabaseSection
        {...props}
        outputSummary={{ rom: 1 }}
        validationMessage="Cheat conflict at ROM offset 0x2871."
      />,
    );
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Cheat conflict at ROM offset 0x2871"));
    expect(view.getByText(/Contains patches and 1 baked ROM cheat/u)).toBeTruthy();
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
    expect(view.getByText("Infinite health")).toBeTruthy();
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
    expect(view.queryByText("Filler cheat 7")).toBeNull();
    expect((view.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(view.getByRole("button", { name: "Next" }));
    expect(view.getByText("2 / 2")).toBeTruthy();
    expect(view.getByText("Filler cheat 7")).toBeTruthy();
    expect(view.queryByText("Infinite lives")).toBeNull();
    expect((view.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(view.getByRole("button", { name: "Previous" }));
    expect(view.getByText("1 / 2")).toBeTruthy();
  });

  it("adds a cheat as a card, then removes it from the picker", async () => {
    const onSelectionChange = vi.fn();
    const view = render(<CheatDatabaseSection {...props} onSelectionChange={onSelectionChange} />);
    await openDialog(view);

    fireEvent.click(addButton(view, "Infinite lives"));
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ record: expect.objectContaining({ id: "cheat-1" }) }),
    ]);
    expect(view.container.querySelectorAll("#rom-weaver-list-cheat-stack > .card.file.patch")).toHaveLength(1);
    expect(view.getByText("1 cheat")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Remove Infinite lives" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
    expect(view.container.querySelector("#rom-weaver-list-cheat-stack")).toBeNull();
  });

  it("cannot add an unsupported entry", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await openDialog(view);
    expect((addButton(view, "Infinite health") as HTMLButtonElement).disabled).toBe(true);
    expect(view.getAllByText("N/A")).toHaveLength(1);
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
    fireEvent.click(addButton(view, "Infinite lives"));
    fireEvent.click(view.getByRole("button", { name: "Close" }));

    expect(view.getByText("game-genie")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Cheat game-genie" }));
    expect(view.getByText("baked into output")).toBeTruthy();
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
    await view.findByText(/Detected Nintendo - Super Nintendo Entertainment System · Action Replay/u);
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

  it("adds an unsupported manual code as an excluded card that names the reason", async () => {
    const onSelectionChange = vi.fn();
    const classifyUnsupported: ManualCheatClassifier = async (request) => ({
      record: {
        record: cheatRecord("manual-2", request.description, request.code),
        resolution: { type: "unsupported", reason: "the code targets runtime memory" },
        detectedKind: "pro-action-replay",
      },
      detectedSystem: request.system,
      detectedType: "Action Replay",
    });
    const view = render(
      <CheatDatabaseSection
        {...props}
        classifyManualCode={classifyUnsupported}
        onSelectionChange={onSelectionChange}
      />,
    );
    await openDialog(view);
    fireEvent.click(view.getByRole("button", { name: "Add code manually" }));
    fireEvent.change(view.getByLabelText("Cheat code"), { target: { value: "7E0010FF" } });
    fireEvent.click(view.getByRole("button", { name: "Check code" }));
    await view.findByText("Cannot be baked into the ROM");
    expect((view.getByRole("button", { name: "Add this cheat" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onSelectionChange).not.toHaveBeenCalledWith([
      expect.objectContaining({ record: expect.objectContaining({ id: "manual-2" }) }),
    ]);
  });

  it("shows the loading state in the picker instead of an empty search result", async () => {
    let finishClassification: ((records: ClassifiedCheatRecord[]) => void) | undefined;
    const classifier: DatabaseCheatClassifier = () =>
      new Promise((resolve) => {
        finishClassification = resolve;
      });
    const view = render(<CheatDatabaseSection {...props} classifyDatabaseCheats={classifier} />);
    await waitFor(() => expect(finishClassification).toBeDefined());
    fireEvent.click(view.getByRole("button", { name: /Search the cheat database/u }));
    expect(view.getByRole("status").textContent).toContain("Checking cheat delivery types");
    expect(view.queryByText(/No cheats match this search/u)).toBeNull();

    finishClassification?.(records);
    await view.findByText("Infinite lives");
    expect(view.queryByText(/Checking cheat delivery types/u)).toBeNull();
  });

  it("shows manual browsing as unverified and keeps controls within their container", async () => {
    const view = render(
      <CheatDatabaseSection
        {...props}
        rom={{ key: "unknown", platform: SNES, title: "Unknown game", checksums: { sha1: "no-match" } }}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: /Search the cheat database/u }));
    fireEvent.change(view.getByLabelText(`Browse games for ${SNES}`), { target: { value: "smw-us" } });
    await view.findByText("Infinite lives");
    expect(view.getByText(/ROM revision is unverified/u)).toBeTruthy();
    expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain("Game selected manually");
    expect(view.container.querySelectorAll(".cheat-pick")).toHaveLength(2);
  });
});

describe("CheatDatabaseSection platform resolution", () => {
  it("reports a platform the index does not cover as unsupported", async () => {
    const view = render(
      <CheatDatabaseSection {...props} rom={{ key: "n64", platform: "Nintendo - Nintendo 64", title: "Game" }} />,
    );
    await waitFor(() =>
      expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain("Unsupported system"),
    );
    fireEvent.click(view.getByRole("button", { name: /Search the cheat database/u }));
    expect(view.queryByRole("button", { name: "Add code manually" })).toBeNull();
  });

  it("resolves the loosely formatted tag ingest reports to the index platform", async () => {
    const view = render(
      <CheatDatabaseSection
        {...props}
        rom={{ key: "rom-c", platform: "Nintendo Super Nintendo Entertainment System", checksums: { sha1: "aa11" } }}
      />,
    );
    await waitFor(() =>
      expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain("Exact checksum match"),
    );
  });
});
