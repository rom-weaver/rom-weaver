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
  it("renders a patch card, the match line, and the database credit", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await waitFor(() => expect(view.container.querySelector(".card.patch")).toBeTruthy());
    expect(view.container.querySelector(".step")).toBeNull();
    expect(view.getByRole("button", { name: "Cheats" })).toBeTruthy();
    expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain("Exact checksum match");
    expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain("2 database cheats");
    expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain(
      "libretro/libretro-database CC-BY-SA-4.0",
    );
  });

  it("keeps the picker footer focused on the cheat list", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await openDialog(view);
    const dialog = view.getByRole("dialog");
    expect(dialog.querySelector(".cheat-notices")).toBeNull();
    expect(dialog.textContent).not.toContain("Community cheat data can contain errors");
  });

  it("shows the conflict message and the baked ROM cheat summary", async () => {
    const view = render(
      <CheatDatabaseSection
        {...props}
        outputSummary={{ rom: 1 }}
        validationMessage="Cheat conflict at ROM offset 0x2871."
      />,
    );
    await waitFor(() => expect(view.getByText(/Cheat conflict at ROM offset 0x2871/u).closest(".notice")).toBeTruthy());
    expect(view.getByText(/Contains patches and 1 baked ROM cheat/u)).toBeTruthy();
  });

  it("waits for a ROM before it offers anything", () => {
    const view = render(<CheatDatabaseSection {...props} rom={null} />);
    expect(view.container.firstElementChild).toBeNull();
    expect(view.queryByRole("button", { name: /Search the cheat database/u })).toBeNull();
    expect(view.queryByRole("checkbox", { name: "Use cheats" })).toBeNull();
  });

  it("puts the switch at the top right and collapses the card when off", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await openDialog(view);
    fireEvent.click(addButton(view, "Infinite lives"));
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(view.getByText("1 cheat")).toBeTruthy();
    expect(view.container.querySelector(".cheat-database-card > .card-top > .card-actions .patch-enable")).toBeTruthy();

    fireEvent.click(view.getByRole("checkbox", { name: "Use cheats" }));
    expect(view.container.querySelector(".card.cheat-database-card.is-off")).toBeTruthy();
    expect(view.container.querySelector(".cheat-card-body")?.hasAttribute("hidden")).toBe(true);
    expect(view.getByText("0 cheats")).toBeTruthy();
  });

  it("a new ROM starts the step On and open again", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await openDialog(view);
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    fireEvent.click(view.getByRole("checkbox", { name: "Use cheats" }));
    view.rerender(<CheatDatabaseSection {...props} rom={null} />);
    expect(view.container.firstElementChild).toBeNull();

    view.rerender(<CheatDatabaseSection {...props} rom={{ ...props.rom, key: "rom-b" }} />);
    expect(view.container.querySelector(".card.cheat-database-card.is-off")).toBeNull();
    expect((view.getByRole("checkbox", { name: "Use cheats" }) as HTMLInputElement).checked).toBe(true);
  });

  it("switching the step off publishes an empty selection and restores the cards when on", async () => {
    const onSelectionChange = vi.fn();
    const view = render(<CheatDatabaseSection {...props} onSelectionChange={onSelectionChange} />);
    await openDialog(view);
    fireEvent.click(addButton(view, "Infinite lives"));
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(onSelectionChange.mock.lastCall?.[0].map(({ record }: ClassifiedCheatRecord) => record.id)).toEqual([
      "cheat-1",
    ]);

    fireEvent.click(view.getByRole("checkbox", { name: "Use cheats" }));
    expect(onSelectionChange.mock.lastCall?.[0]).toEqual([]);
    expect(view.container.querySelector(".card.cheat-database-card.is-off")).toBeTruthy();
    expect(view.container.querySelector(".cheat-card-body")?.hasAttribute("hidden")).toBe(true);
    expect(view.getByText("0 cheats")).toBeTruthy();
    expect(view.getByText("1 off")).toBeTruthy();

    fireEvent.click(view.getByRole("checkbox", { name: "Use cheats" }));
    expect(onSelectionChange.mock.lastCall?.[0].map(({ record }: ClassifiedCheatRecord) => record.id)).toEqual([
      "cheat-1",
    ]);
    expect(view.container.querySelector(".card.cheat-database-card.is-off")).toBeNull();
    expect(view.container.querySelector("#rom-weaver-list-cheat-stack .card")).toBeTruthy();
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

  it("searches database systems when the ROM platform is unknown", async () => {
    const view = render(
      <CheatDatabaseSection
        {...props}
        rom={{ key: "unknown-platform", title: "Unknown ROM", checksums: { sha1: "no-match" } }}
      />,
    );
    const search = await view.findByPlaceholderText("Search cheat databases by system…");
    fireEvent.change(search, { target: { value: "Super Nintendo" } });
    const option = view.getByRole("button", { name: /Nintendo - Super Nintendo Entertainment System/u });
    expect(option.textContent).toContain("1 game · 2 cheats");
    fireEvent.click(option);
    await waitFor(() => expect(view.queryByPlaceholderText("Search cheat databases by system…")).toBeNull());

    fireEvent.click(view.getByRole("button", { name: /Search the cheat database/u }));
    expect(view.getByLabelText(`Browse games for ${SNES}`)).toBeTruthy();
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
    expect(view.queryByPlaceholderText("Search cheat databases by system…")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: /Search the cheat database/u }));
    expect(view.queryByRole("button", { name: "Add code manually" })).toBeNull();
  });

  it("keeps manual entry for a system the decoder covers without a database", async () => {
    const view = render(
      <CheatDatabaseSection {...props} rom={{ key: "psx", platform: "Sony - PlayStation", title: "Game" }} />,
    );
    await waitFor(() =>
      expect(view.container.querySelector(".cheat-add-note")?.textContent).toContain(
        "No cheat database for PlayStation",
      ),
    );
    expect(view.queryByPlaceholderText("Search cheat databases by system…")).toBeNull();
    expect(view.container.querySelector(".cheat-add-note")?.textContent).not.toContain("Unsupported system");

    fireEvent.click(view.getByRole("button", { name: /Add cheat codes/u }));
    fireEvent.click(view.getByRole("button", { name: "Add code manually" }));
    expect((view.getByLabelText("System") as HTMLSelectElement).value).toBe("playstation");
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

describe("CheatDatabaseSection save as patch", () => {
  it("stays disabled until a ROM cheat is On", async () => {
    const onSaveAsPatch = vi.fn(async () => "smw - Infinite lives.ips");
    const view = render(<CheatDatabaseSection {...props} onSaveAsPatch={onSaveAsPatch} />);
    const save = () => view.getByRole("button", { name: /Save as patch/u }) as HTMLButtonElement;
    // The action only appears once there is a card; an Off card still leaves it disabled.
    await openDialog(view);
    expect(view.queryByRole("button", { name: /Save as patch/u })).toBeNull();
    fireEvent.click(addButton(view, "Infinite lives"));
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    fireEvent.click(view.getByRole("checkbox", { name: "Include Infinite lives" }));
    await waitFor(() => expect(save().disabled).toBe(true));

    fireEvent.click(view.getByRole("checkbox", { name: "Include Infinite lives" }));
    await waitFor(() => expect(save().disabled).toBe(false));
  });

  it("bakes the ROM cheats that are On and reports the created file", async () => {
    const onSaveAsPatch = vi.fn(async () => "smw - Infinite lives.ips");
    const view = render(<CheatDatabaseSection {...props} onSaveAsPatch={onSaveAsPatch} />);
    await openDialog(view);
    fireEvent.click(addButton(view, "Infinite lives"));
    fireEvent.click(view.getByRole("button", { name: "Close" }));

    fireEvent.click(view.getByRole("button", { name: /Save as patch/u }));
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe(
        "Created smw - Infinite lives.ips from the 1 ROM cheat that is On.",
      ),
    );
    const baked = onSaveAsPatch.mock.calls[0]?.[0] as ClassifiedCheatRecord[];
    expect(baked.map(({ record }) => record.id)).toEqual(["cheat-1"]);
  });

  it("shows the failure instead of a status line", async () => {
    const onSaveAsPatch = vi.fn(async () => {
      throw new Error("patch create failed");
    });
    const view = render(<CheatDatabaseSection {...props} onSaveAsPatch={onSaveAsPatch} />);
    await openDialog(view);
    fireEvent.click(addButton(view, "Infinite lives"));
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    fireEvent.click(view.getByRole("button", { name: /Save as patch/u }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("patch create failed"));
  });
});
