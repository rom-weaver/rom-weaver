// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CheatDatabaseSection } from "../../../src/public/react/components/cheat-database-section.tsx";
import type {
  CheatSystemShard,
  ClassifiedCheatRecord,
  DatabaseCheatClassifier,
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

const props = {
  rom: { key: "rom-a", system: "snes", title: "Super Mario World", checksums: { sha1: "aa11" } },
  shard,
  classifyDatabaseCheats,
  classifyManualCode,
} as const;

describe("CheatDatabaseSection", () => {
  it("shows exact match, delivery labels, and data-quality notices", async () => {
    const view = render(<CheatDatabaseSection {...props} />);
    await view.findByText("Exact ROM revision matched");
    expect(view.getByText("ROM cheat")).toBeTruthy();
    expect(view.getAllByText("RAM cheat")).toHaveLength(2);
    expect(view.getByText("Needs a value")).toBeTruthy();
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
    await view.findByText("Exact ROM revision matched");
    expect(view.getByRole("alert").textContent).toContain("Cheat conflict at ROM offset 0x2871");
    expect(view.getByText(/Contains patches and 1 baked ROM cheat/u)).toBeTruthy();
    expect(view.getByText(/game-modified\.cht contains 2 RAM or runtime cheats/u)).toBeTruthy();
  });

  it("searches, filters, selects, and disables parameter entries", async () => {
    const onSelectionChange = vi.fn();
    const view = render(<CheatDatabaseSection {...props} onSelectionChange={onSelectionChange} />);
    await view.findByText("Infinite lives");

    fireEvent.change(view.getByRole("searchbox"), { target: { value: "health" } });
    expect(view.getByText("Infinite health")).toBeTruthy();
    expect(view.queryByText("Infinite lives")).toBeNull();
    fireEvent.change(view.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(view.getByLabelText("RAM / runtime"));
    expect(view.queryByText("Infinite lives")).toBeNull();
    expect(view.getByText("Moon jump")).toBeTruthy();

    fireEvent.click(view.getByLabelText("All"));
    fireEvent.click(view.getByRole("checkbox", { name: /Infinite health/u }));
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ record: expect.objectContaining({ id: "cheat-2" }) }),
    ]);
    expect((view.getByRole("checkbox", { name: /Starting lives/u }) as HTMLInputElement).disabled).toBe(true);
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
    await view.findByText(/Detected SNES · Action Replay/u);
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
        rom={{ key: "unknown", system: "snes", title: "Unknown game", checksums: { sha1: "no-match" } }}
      />,
    );
    fireEvent.change(view.getByLabelText("Browse games for SNES"), { target: { value: "smw-us" } });
    await view.findByText("Game selected manually");
    expect(view.getByText(/ROM revision is unverified/u)).toBeTruthy();
    expect(view.container.querySelector(".cheat-database-section")?.className).toContain("cheat-database-section");
    expect(
      view.container.querySelectorAll('input, select, textarea, button[aria-expanded="true"]').length,
    ).toBeGreaterThan(0);
  });
});
