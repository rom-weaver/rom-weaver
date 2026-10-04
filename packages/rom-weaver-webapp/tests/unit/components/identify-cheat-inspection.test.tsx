// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { CheatDatabaseIndex, CheatSystemShard } from "../../../src/lib/cheats/index.ts";
import { IdentifyCheatInspection } from "../../../src/webapp/components/identify-cheat-inspection.tsx";

const platform = "Nintendo - Super Nintendo Entertainment System";
const index: CheatDatabaseIndex = {
  entries: [
    {
      cheatSystem: "snes",
      cheats: 1,
      file: "snes.json",
      games: 1,
      platform,
      rawBytes: 100,
      sha256: "a".repeat(64),
      slug: "snes",
    },
  ],
  license: "CC-BY-SA-4.0",
  sourceRevision: "fixture",
  sourceUrl: "https://example.test",
};
const shard: CheatSystemShard = {
  games: [
    {
      cheats: [
        {
          codeKind: "game-genie",
          description: "Infinite lives",
          gameId: "game",
          id: "cheat",
          importWarnings: ["Duplicate source label"],
          rawCode: "C2B4-6D07",
          rawFields: { note: "Original database note" },
          sourceFile: "game.cht",
          sourceIndex: 0,
          sourceRevision: "fixture",
          system: "snes",
        },
      ],
      checksums: [{ sha1: "aa11" }],
      id: "game",
      normalizedTitle: "game",
      regions: [],
      revisions: [],
      title: "Game",
    },
  ],
  schemaVersion: 2,
  system: "snes",
};

it("inspects raw cheat records without selection or mutation controls", async () => {
  const view = render(
    <div className="rw-app">
      <IdentifyCheatInspection
        identity={{ checksums: { sha1: "aa11" }, key: "checksum-only", platform, title: "Game" }}
        index={index}
        shard={shard}
      />
    </div>,
  );

  fireEvent.click(view.getByRole("button", { name: "View cheats" }));
  expect(await view.findByText("Infinite lives")).toBeTruthy();
  expect(view.queryByRole("button", { name: /Add Infinite lives/u })).toBeNull();
  expect(view.queryByRole("button", { name: /Remove Infinite lives/u })).toBeNull();
  expect(view.getByText(/Compatibility with these exact ROM bytes is not verified/u)).toBeTruthy();
  expect(view.queryByText(/The cheat database has no cheats/u)).toBeNull();

  fireEvent.click(view.getByText("Code details"));
  expect(view.getByText("C2B4-6D07")).toBeTruthy();
  expect(view.getByText("Original database note")).toBeTruthy();
  expect(view.getByText("Duplicate source label")).toBeTruthy();
});

it("does not load the cheat shard until the inspection opens", async () => {
  const loadShard = vi.fn(async () => shard);
  const view = render(
    <IdentifyCheatInspection
      client={{ close: vi.fn(), loadShard }}
      identity={{ checksums: { sha1: "aa11" }, key: "deferred", platform, title: "Game" }}
      index={index}
    />,
  );

  expect(loadShard).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "View cheats" }));
  expect(await view.findByText("Infinite lives")).toBeTruthy();
  expect(loadShard).toHaveBeenCalledTimes(1);
});
