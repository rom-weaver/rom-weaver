// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { KeptRomsPanel } from "../../../src/public/react/kept-roms-panel.tsx";

const storage = vi.hoisted(() => ({
  listKeptRoms: vi.fn(),
  readKeptRom: vi.fn(),
  deleteKeptRom: vi.fn(),
  requestPersistentStorage: vi.fn(),
}));
vi.mock("../../../src/storage/browser/kept-roms.ts", () => storage);
vi.mock("../../../src/storage/browser/persistent-storage.ts", () => storage);
const gameId = "a".repeat(40);
beforeEach(() => {
  vi.clearAllMocks();
  storage.listKeptRoms.mockResolvedValue([{ gameId, fileName: "Pokémon #2.zip", size: 1000, status: "ready" }]);
  storage.readKeptRom.mockResolvedValue({
    file: new File(["ROM"], "Pokémon #2.zip"),
    dispose: vi.fn(async () => undefined),
  });
  storage.deleteKeptRom.mockResolvedValue(undefined);
});

it("plays the original kept file and removes it without deleting its save", async () => {
  const play = vi.fn();
  render(<KeptRomsPanel onPlay={play} />);
  await screen.findByText("Pokémon #2.zip");
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  await waitFor(() =>
    expect(play).toHaveBeenCalledWith(
      expect.objectContaining({ file: expect.objectContaining({ name: "Pokémon #2.zip" }) }),
    ),
  );
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(storage.deleteKeptRom).toHaveBeenCalledWith(gameId));
});

it.each(["removed", "unreadable"])("keeps %s entries visible with Play disabled", async (status) => {
  storage.listKeptRoms.mockResolvedValue([{ gameId, fileName: "old.zip", size: 1000, status }]);
  render(<KeptRomsPanel onPlay={vi.fn()} />);
  await screen.findByText("old.zip");
  expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(status === "removed" ? /Removed by the browser/ : /Can't read this version/)).toBeTruthy();
});

it("requests persistence only from the Storage action and reports refusal", async () => {
  storage.requestPersistentStorage.mockResolvedValue(false);
  render(<KeptRomsPanel />);
  await screen.findByText("Pokémon #2.zip");
  expect(storage.requestPersistentStorage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Protect saves and ROMs from automatic removal" }));
  expect(await screen.findByText(/Persistent storage was not granted/)).toBeTruthy();
});

it("releases playback scratch when starting the player is rejected", async () => {
  const dispose = vi.fn(async () => undefined);
  storage.readKeptRom.mockResolvedValue({ file: new File(["ROM"], "game.nes"), dispose });
  render(<KeptRomsPanel onPlay={async () => false} />);
  fireEvent.click(await screen.findByRole("button", { name: "Play" }));
  await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
});
