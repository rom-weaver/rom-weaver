import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

const loadEmulatorRom = vi.hoisted(() =>
  vi.fn(
    async (
      blob: Blob,
      fileName: string,
    ): Promise<{ blob: Blob; checksum: string; fileName: string; expandedSizeBytes?: number }> => ({
      blob,
      checksum: "a".repeat(40),
      fileName,
    }),
  ),
);

vi.mock("../../src/public/react/components/emulator-load-rom.ts", () => ({ loadEmulatorRom }));

import { setWorkbenchActivity } from "../../src/lib/activity-store.ts";
import {
  addEntry,
  clearApplyEntries,
  dismissClosedGameNotice,
  disposeEntry,
  getClosedGameName,
  getEmulatorSessionState,
  prepareEntry,
  releaseLargeEntries,
  releaseLargeEntriesOnRunStart,
  restartCurrentGameWithSave,
  setCurrentGame,
  type EmulatorSessionEntry,
} from "../../src/public/react/emulator-session-store.ts";

const entry = (overrides: Partial<EmulatorSessionEntry> = {}): EmulatorSessionEntry => ({
  blob: new Blob(["game"]),
  fileName: "game.nes",
  id: "game",
  sizeBytes: 3,
  source: "local",
  ...overrides,
});

afterEach(() => {
  while (getEmulatorSessionState().entries.length) disposeEntry(getEmulatorSessionState().entries[0].id);
});

describe("emulator session store", () => {
  it("keeps one current game and disposes its predecessor", () => {
    const firstDispose = vi.fn(async () => undefined);
    const secondDispose = vi.fn(async () => undefined);
    const first = entry({
      artifact: { dispose: firstDispose, getBlob: async () => new Blob(["one"]) },
      id: "first",
      source: "apply",
    });
    const second = entry({
      artifact: { dispose: secondDispose, getBlob: async () => new Blob(["two"]) },
      id: "second",
      source: "apply",
    });

    addEntry(first);
    addEntry(second);

    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).not.toHaveBeenCalled();
    expect(getEmulatorSessionState()).toMatchObject({ currentGameId: "second", entries: [second] });
    disposeEntry("second");
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it("adds and replaces an entry with the same id", () => {
    const replacement = new Blob(["two"]);
    addEntry(entry({ blob: new Blob(["one"]) }));
    addEntry(entry({ blob: replacement, fileName: "updated.nes" }));

    expect(getEmulatorSessionState()).toEqual({
      currentGameId: "game",
      entries: [entry({ blob: replacement, fileName: "updated.nes" })],
    });
  });

  it("clears the current game when its entry is disposed", () => {
    addEntry(entry());
    setCurrentGame("game");

    disposeEntry("game");

    expect(getEmulatorSessionState()).toEqual({ currentGameId: null, entries: [] });
  });

  it("releases a disc-sized game and keeps a cartridge-sized one", () => {
    const dispose = vi.fn(async () => undefined);
    addEntry(
      entry({
        artifact: { dispose, getBlob: async () => new Blob(["disc"]) },
        id: "disc",
        sizeBytes: 464 * 1024 * 1024,
      }),
    );

    releaseLargeEntries();

    expect(dispose).toHaveBeenCalledOnce();
    expect(getEmulatorSessionState()).toEqual({ currentGameId: null, entries: [] });
    addEntry(entry({ sizeBytes: 4 * 1024 * 1024 }));
    releaseLargeEntries();
    expect(getEmulatorSessionState()).toEqual({
      currentGameId: "game",
      entries: [entry({ sizeBytes: 4 * 1024 * 1024 })],
    });
  });

  it("names the disc-sized game it closed only when asked to", () => {
    addEntry(entry({ fileName: "disc.chd", id: "disc", sizeBytes: 464 * 1024 * 1024 }));
    // A replacement game is about to load, so nothing needs explaining.
    releaseLargeEntries();
    expect(getClosedGameName()).toBeNull();

    addEntry(entry({ fileName: "disc.chd", id: "disc", sizeBytes: 464 * 1024 * 1024 }));
    releaseLargeEntries({ announce: true });
    expect(getClosedGameName()).toBe("disc.chd");
    dismissClosedGameNotice();
    expect(getClosedGameName()).toBeNull();

    addEntry(entry({ fileName: "disc.chd", id: "disc", sizeBytes: 464 * 1024 * 1024 }));
    releaseLargeEntries({ announce: true });
    addEntry(entry());
    expect(getClosedGameName()).toBeNull();
  });

  it("closes a disc-sized game each time a workflow starts a run", () => {
    const unsubscribe = releaseLargeEntriesOnRunStart();
    onTestFinished(() => {
      unsubscribe();
      setWorkbenchActivity("session-store-test", { state: "idle" });
    });
    addEntry(entry({ fileName: "disc.chd", id: "disc", sizeBytes: 464 * 1024 * 1024 }));
    setWorkbenchActivity("session-store-test", { state: "running" });
    expect(getEmulatorSessionState()).toEqual({ currentGameId: null, entries: [] });
    expect(getClosedGameName()).toBe("disc.chd");

    // A game loaded during the run stays until the next run starts.
    addEntry(entry({ fileName: "disc.chd", id: "disc", sizeBytes: 464 * 1024 * 1024 }));
    setWorkbenchActivity("session-store-test", { stage: "Halfway", state: "running" });
    expect(getEmulatorSessionState().entries).toHaveLength(1);
    setWorkbenchActivity("session-store-test", { state: "done" });
    unsubscribe();
    setWorkbenchActivity("session-store-test", { state: "running" });
    expect(getEmulatorSessionState().entries).toHaveLength(1);
  });

  it("resolves and caches the retained artifact's blob", async () => {
    const retained = new Blob(["retained"]);
    const getBlob = vi.fn(async () => retained);
    addEntry(entry({ artifact: { dispose: async () => undefined, getBlob }, blob: undefined, source: "apply" }));

    expect(await prepareEntry("game")).toBe(retained);
    expect(getEmulatorSessionState().entries[0]?.blob).toBe(retained);
    expect(getEmulatorSessionState().entries[0]?.checksum).toBe("a".repeat(40));
    expect(loadEmulatorRom).toHaveBeenCalledWith(retained, "game.nes");
    expect(await prepareEntry("game")).toBe(retained);
    expect(getBlob).toHaveBeenCalledOnce();
  });

  it("restarts the loaded ROM when a new test save is staged", () => {
    const blob = new Blob(["rom"]);
    addEntry(entry({ blob, checksum: "a".repeat(40) }));

    restartCurrentGameWithSave("game");
    restartCurrentGameWithSave("game");

    expect(getEmulatorSessionState()).toMatchObject({
      currentGameId: "game",
      entries: [{ blob, savePreviewRevision: 2 }],
    });
  });

  it("clears the current Apply entry", () => {
    addEntry(entry({ id: "apply", source: "apply" }));

    clearApplyEntries();

    expect(getEmulatorSessionState()).toEqual({ currentGameId: null, entries: [] });
  });

  it("retains the current local entry when Apply entries are cleared", () => {
    addEntry(entry({ id: "local" }));

    clearApplyEntries();

    expect(getEmulatorSessionState().entries.map(({ id }) => id)).toEqual(["local"]);
    expect(getEmulatorSessionState().currentGameId).toBe("local");
  });
});

it("releases a small archive whose expanded game is disc-sized", () => {
  addEntry(entry({ fileName: "Game.zip", sizeBytes: 3, expandedSizeBytes: 128 * 1024 * 1024 + 1 }));
  releaseLargeEntries();
  expect(getEmulatorSessionState().entries).toEqual([]);
});

it("prepares a retained PBP using its returned bundle and expanded size", async () => {
  const bundle = new Blob(["zip"]);
  const expandedSizeBytes = 128 * 1024 * 1024 + 1;
  loadEmulatorRom.mockResolvedValueOnce({
    blob: bundle,
    checksum: "a".repeat(40),
    fileName: "Game.zip",
    expandedSizeBytes,
  });
  addEntry(
    entry({
      blob: undefined,
      artifact: { dispose: vi.fn(async () => undefined), getBlob: async () => new Blob(["PBP"]) },
      fileName: "Game.pbp",
    }),
  );
  expect(await prepareEntry("game")).toBe(bundle);
  expect(getEmulatorSessionState().entries[0]).toMatchObject({ blob: bundle, fileName: "Game.zip", expandedSizeBytes });
  releaseLargeEntries();
  expect(getEmulatorSessionState().entries).toEqual([]);
});
