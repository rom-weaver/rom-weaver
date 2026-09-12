// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateCheatCodesPanel } from "../../../src/public/react/components/create-cheat-codes-panel.tsx";
import type {
  CheatDatabaseIndex,
  CheatRecord,
  CheatSystemShard,
  ClassifiedCheatRecord,
  DatabaseCheatClassifier,
  ManualCheatClassifier,
} from "../../../src/lib/cheats/index.ts";

const cheatRecord = (id: string, description: string, rawCode: string): CheatRecord => ({
  description,
  gameId: "smb-us",
  id,
  rawCode,
  rawFields: { code: rawCode },
  sourceFile: "Super Mario Bros (USA).cht",
  sourceIndex: 0,
  sourceRevision: "abc123",
  system: "nes",
});

const romRecord: ClassifiedCheatRecord = {
  detectedKind: "game-genie",
  record: cheatRecord("cheat-1", "Infinite lives", "SXIOPO"),
  resolution: { type: "romBakeable", writes: [{ compare: 0xff, offset: 0x4000, value: 0x12, width: 1 }] },
};

/** A database row whose rawCode holds two codes at once. */
const multiRecord: ClassifiedCheatRecord = {
  detectedKind: "pro-action-replay",
  record: cheatRecord("cheat-3", "Walk through walls", "01050EC6+01060FC6"),
  resolution: { type: "romBakeable", writes: [{ offset: 0x0e, value: 0x05, width: 1 }] },
};

const ramRecord: ClassifiedCheatRecord = {
  detectedKind: "pro-action-replay",
  record: cheatRecord("cheat-2", "Infinite health", "7E0DBE3F"),
  resolution: { reason: "the code targets runtime memory", type: "unsupported" },
};

const shard: CheatSystemShard = {
  games: [
    {
      checksums: [{ sha1: "aa11" }],
      cheats: [romRecord.record, ramRecord.record, multiRecord.record],
      id: "smb-us",
      normalizedTitle: "super mario bros",
      regions: ["USA"],
      revisions: [],
      sourceFiles: ["Super Mario Bros (USA).cht"],
      title: "Super Mario Bros",
    },
  ],
  schemaVersion: 1,
  system: "nes",
};

const classifyDatabaseCheats: DatabaseCheatClassifier = async (records) =>
  records.map((entry) => {
    if (entry.id === "cheat-1") return romRecord;
    return entry.id === "cheat-3" ? multiRecord : ramRecord;
  });

/** Stands in for the WASM decoder: only the Game Genie code bakes into ROM. */
const classifyManualCode: ManualCheatClassifier = async ({ code, description, system }) => ({
  detectedSystem: system,
  detectedType: "Game Genie",
  record:
    code === "SXIOPO"
      ? { ...romRecord, record: { ...romRecord.record, description } }
      : { ...ramRecord, record: { ...ramRecord.record, description, rawCode: code } },
});

const NES = "Nintendo - Nintendo Entertainment System";

const index: CheatDatabaseIndex = {
  entries: [
    {
      cheatSystem: "nes",
      cheats: 3,
      file: "cheats-nintendo-nintendo-entertainment-system.json",
      games: 1,
      platform: NES,
      rawBytes: 100,
      sha256: "a".repeat(64),
      slug: "nintendo-nintendo-entertainment-system",
    },
  ],
  license: "CC-BY-SA-4.0",
  sourceRevision: "abc123",
  sourceUrl: "https://github.com/libretro/libretro-database",
};

const props = {
  classifyDatabaseCheats,
  classifyManualCode,
  index,
  rom: { checksums: { sha1: "aa11" }, fileName: "smb.nes", key: "rom-a", platform: NES, title: "Super Mario Bros" },
  shard,
} as const;

const renderPanel = (value: string, overrides: Record<string, unknown> = {}) => {
  const onValueChange = vi.fn();
  const onEntriesChange = vi.fn();
  const onClassifyingChange = vi.fn();
  const onSystemChange = vi.fn();
  const view = render(
    <CreateCheatCodesPanel
      {...props}
      onClassifyingChange={onClassifyingChange}
      onEntriesChange={onEntriesChange}
      onSystemChange={onSystemChange}
      onValueChange={onValueChange}
      value={value}
      {...overrides}
    />,
  );
  return { onClassifyingChange, onEntriesChange, onSystemChange, onValueChange, view };
};

describe("CreateCheatCodesPanel", () => {
  it("shows the detected line and one write row per code", async () => {
    const { view } = renderPanel("SXIOPO");
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("NES · Game Genie · 1 write"));
    expect(view.getByText("$004000 ← $12")).toBeTruthy();
  });

  it("renders the compare badge only when the classifier reported a compare byte", async () => {
    const { view } = renderPanel("SXIOPO");
    await waitFor(() => expect(view.getByText("compare $FF found")).toBeTruthy());
  });

  it("reports an unresolved code as blocked instead of showing writes", async () => {
    const { view } = renderPanel("7E0DBE3F");
    await waitFor(() => expect(view.getByText("the code targets runtime memory")).toBeTruthy());
  });

  it("publishes the split, classified entries to the create form", async () => {
    const { onEntriesChange } = renderPanel("SXIOPO+7E0DBE3F");
    await waitFor(() => {
      const entries = onEntriesChange.mock.calls.at(-1)?.[0] as Array<{ code: string }>;
      expect(entries.map((entry) => entry.code)).toEqual(["SXIOPO", "7E0DBE3F"]);
    });
  });

  it("disables the unbakeable row in the picker", async () => {
    const { view } = renderPanel("");
    fireEvent.click(view.getByRole("button", { name: /Pick from the cheat database/u }));
    await view.findByText("Infinite lives");
    expect((view.getByRole("button", { name: "Add Infinite health" }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole("button", { name: "Add Infinite lives" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("appends a picked code to the textarea", async () => {
    const { onValueChange, view } = renderPanel("");
    fireEvent.click(view.getByRole("button", { name: /Pick from the cheat database/u }));
    await view.findByText("Infinite lives");
    fireEvent.click(view.getByRole("button", { name: "Add Infinite lives" }));
    expect(onValueChange).toHaveBeenCalledWith("SXIOPO");
  });

  // Check membership per decoded code so a multi-code row cannot be added repeatedly.
  it("adds every code a multi-code row carries, then offers Remove", async () => {
    const { onValueChange, view } = renderPanel("");
    fireEvent.click(view.getByRole("button", { name: /Pick from the cheat database/u }));
    await view.findByText("Walk through walls");
    fireEvent.click(view.getByRole("button", { name: "Add Walk through walls" }));
    expect(onValueChange).toHaveBeenCalledWith("01050EC6\n01060FC6");
  });

  it("shows Remove once every code of a multi-code row is staged", async () => {
    const { view } = renderPanel("01050EC6\n01060FC6");
    fireEvent.click(view.getByRole("button", { name: /Pick from the cheat database/u }));
    await view.findByText("Walk through walls");
    expect(view.getByRole("button", { name: "Remove Walk through walls" })).toBeTruthy();
  });

  it("keeps a partially staged multi-code row addable", async () => {
    const { view } = renderPanel("01050EC6");
    fireEvent.click(view.getByRole("button", { name: /Pick from the cheat database/u }));
    await view.findByText("Walk through walls");
    expect(view.getByRole("button", { name: "Add Walk through walls" })).toBeTruthy();
  });

  it("removes every code of a multi-code row at once", async () => {
    const { onValueChange, view } = renderPanel("01050EC6\n01060FC6\nSXIOPO");
    fireEvent.click(view.getByRole("button", { name: /Pick from the cheat database/u }));
    await view.findByText("Walk through walls");
    fireEvent.click(view.getByRole("button", { name: "Remove Walk through walls" }));
    expect(onValueChange).toHaveBeenCalledWith("SXIOPO");
  });

  // Look up each decoded code so all members of a multi-code row inherit its description.
  it("names a code that came from a multi-code database row", async () => {
    const { onEntriesChange } = renderPanel("01060FC6");
    await waitFor(() => {
      const entries = onEntriesChange.mock.calls.at(-1)?.[0] as Array<{ description: string }>;
      expect(entries[0]?.description).toBe("Walk through walls");
    });
  });
});
