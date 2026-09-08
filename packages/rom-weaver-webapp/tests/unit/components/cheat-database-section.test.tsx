// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CheatDatabaseSection } from "../../../src/public/react/components/cheat-database-section.tsx";
import type {
  CheatDatabaseIndex,
  CheatSystemShard,
  ClassifiedCheatRecord,
  CheatRecord,
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

const shard: CheatSystemShard = {
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
      cheats: records.map(({ record }) => record),
    },
  ],
};

const classifyDatabaseCheats: DatabaseCheatClassifier = async (input) =>
  input.map((record) => records.find((entry) => entry.record.id === record.id) as ClassifiedCheatRecord);

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
} as const;

describe("CheatDatabaseSection", () => {
  it("shows exact match, delivery labels, and data-quality notices", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await view.findByText("Exact ROM revision matched");
    expect(view.getByText("ROM cheat")).toBeTruthy();
    expect(view.getByText("Unsupported")).toBeTruthy();
    expect(view.getByText("Cannot be baked into the ROM")).toBeTruthy();
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
    await view.findByText("Exact ROM revision matched");
    expect(view.getByRole("alert").textContent).toContain("Cheat conflict at ROM offset 0x2871");
    expect(view.getByText(/Contains patches and 1 baked ROM cheat/u)).toBeTruthy();
  });

  it("searches, selects, and disables unsupported entries", async () => {
    const onSelectionChange = vi.fn();
    const view = render(<CheatDatabaseSection {...props} onSelectionChange={onSelectionChange} />);
    await view.findByText("Infinite lives");

    fireEvent.change(view.getByRole("searchbox"), { target: { value: "health" } });
    expect(view.getByText("Infinite health")).toBeTruthy();
    expect(view.queryByText("Infinite lives")).toBeNull();
    fireEvent.change(view.getByRole("searchbox"), { target: { value: "" } });

    fireEvent.click(view.getByRole("checkbox", { name: /Infinite lives/u }));
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ record: expect.objectContaining({ id: "cheat-1" }) }),
    ]);
    expect((view.getByRole("checkbox", { name: /Infinite health/u }) as HTMLInputElement).disabled).toBe(true);
  });

  it("shows the unsupported reason in the details", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    const details = await view.findAllByRole("button", { name: "Details" });
    fireEvent.click(details[1] as HTMLElement);
    expect(view.getByText("the code targets runtime memory")).toBeTruthy();
  });

  it("clears selections when the original ROM identity changes", async () => {
    const onSelectionChange = vi.fn();
    const view = render(<CheatDatabaseSection {...props} onSelectionChange={onSelectionChange} />);
    fireEvent.click(await view.findByRole("checkbox", { name: /Infinite lives/u }));
    expect((view.getByRole("checkbox", { name: /Infinite lives/u }) as HTMLInputElement).checked).toBe(true);

    view.rerender(
      <CheatDatabaseSection {...props} onSelectionChange={onSelectionChange} rom={{ ...props.rom, key: "rom-b" }} />,
    );
    await waitFor(() =>
      expect((view.getByRole("checkbox", { name: /Infinite lives/u }) as HTMLInputElement).checked).toBe(false),
    );
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it("keeps selections through a harmless host rerender", async () => {
    const view = render(<CheatDatabaseSection {...props} onSelectionChange={vi.fn()} />);
    fireEvent.click(await view.findByRole("checkbox", { name: /Infinite lives/u }));

    view.rerender(<CheatDatabaseSection {...props} onSelectionChange={vi.fn()} />);
    expect((view.getByRole("checkbox", { name: /Infinite lives/u }) as HTMLInputElement).checked).toBe(true);
  });

  it("supports keyboard detail controls and manual Rust classification", async () => {
    const onSelectionChange = vi.fn();
    const view = render(<CheatDatabaseSection {...props} onSelectionChange={onSelectionChange} />);
    const details = await view.findAllByRole("button", { name: "Details" });
    fireEvent.keyDown(details[0] as HTMLElement, { key: "Enter" });
    fireEvent.click(details[0] as HTMLElement);
    expect(view.getByText("Original code")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Add code manually" }));
    fireEvent.change(view.getByLabelText("Cheat code"), { target: { value: "7E0010FF" } });
    fireEvent.change(view.getByLabelText("Code type"), { target: { value: "pro-action-replay" } });
    fireEvent.click(view.getByRole("button", { name: "Check code" }));
    await view.findByText(/Detected Nintendo - Super Nintendo Entertainment System · Action Replay/u);
    fireEvent.click(view.getByRole("button", { name: "Add this cheat" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ record: expect.objectContaining({ id: "manual-1" }) }),
    ]);
  });

  it("clears a manual classification after the user changes its inputs", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    fireEvent.click(view.getByRole("button", { name: "Add code manually" }));
    fireEvent.change(view.getByLabelText("Cheat code"), { target: { value: "7E0010FF" } });
    fireEvent.click(view.getByRole("button", { name: "Check code" }));
    await view.findByRole("button", { name: "Add this cheat" });

    fireEvent.change(view.getByLabelText("Cheat code"), { target: { value: "7E0011FF" } });
    expect(view.queryByRole("button", { name: "Add this cheat" })).toBeNull();
  });

  it("shows manual browsing as unverified and keeps controls within their container", async () => {
    const view = render(
      <CheatDatabaseSection
        {...props}
        rom={{ key: "unknown", platform: SNES, title: "Unknown game", checksums: { sha1: "no-match" } }}
      />,
    );
    fireEvent.change(view.getByLabelText(`Browse games for ${SNES}`), { target: { value: "smw-us" } });
    await view.findByText("Game selected manually");
    expect(view.getByText(/ROM revision is unverified/u)).toBeTruthy();
    expect(view.container.querySelector(".cheat-database-section")?.className).toContain("cheat-database-section");
    expect(
      view.container.querySelectorAll('input, select, textarea, button[aria-expanded="true"]').length,
    ).toBeGreaterThan(0);
  });
});

describe("CheatDatabaseSection platform resolution", () => {
  it("reports a platform the index does not cover as unsupported", async () => {
    const view = render(
      <CheatDatabaseSection {...props} rom={{ key: "n64", platform: "Nintendo - Nintendo 64", title: "Game" }} />,
    );
    await view.findByText("Unsupported system");
    expect(view.queryByRole("button", { name: "Add code manually" })).toBeNull();
  });

  it("resolves the loosely formatted tag ingest reports to the index platform", async () => {
    const view = render(
      <CheatDatabaseSection
        {...props}
        rom={{ key: "rom-c", platform: "Nintendo Super Nintendo Entertainment System", checksums: { sha1: "aa11" } }}
      />,
    );
    await view.findByText("Exact ROM revision matched");
  });
});
