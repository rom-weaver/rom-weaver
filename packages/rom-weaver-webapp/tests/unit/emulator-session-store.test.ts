import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addEntry,
  clearApplyEntries,
  disposeEntry,
  getEmulatorSessionState,
  prepareEntry,
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
  it("disposes the predecessor when a retained apply entry is replaced", () => {
    const firstDispose = vi.fn(async () => undefined);
    const secondDispose = vi.fn(async () => undefined);
    const first = entry({
      artifact: { dispose: firstDispose, getBlob: async () => new Blob(["one"]) },
      source: "apply",
    });
    const second = entry({
      artifact: { dispose: secondDispose, getBlob: async () => new Blob(["two"]) },
      source: "apply",
    });

    addEntry(first);
    addEntry(second);

    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).not.toHaveBeenCalled();
    disposeEntry("game");
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it("adds and replaces an entry with the same id", () => {
    const replacement = new Blob(["two"]);
    addEntry(entry({ blob: new Blob(["one"]) }));
    addEntry(entry({ blob: replacement, fileName: "updated.nes" }));

    expect(getEmulatorSessionState().entries).toEqual([entry({ blob: replacement, fileName: "updated.nes" })]);
  });

  it("clears the current game when its entry is disposed", () => {
    addEntry(entry());
    setCurrentGame("game");

    disposeEntry("game");

    expect(getEmulatorSessionState()).toEqual({ currentGameId: null, entries: [] });
  });

  it("resolves and caches the retained artifact's blob", async () => {
    const retained = new Blob(["retained"]);
    const getBlob = vi.fn(async () => retained);
    addEntry(entry({ artifact: { dispose: async () => undefined, getBlob }, blob: undefined, source: "apply" }));

    expect(await prepareEntry("game")).toBe(retained);
    expect(getEmulatorSessionState().entries[0]?.blob).toBe(retained);
    expect(await prepareEntry("game")).toBe(retained);
    expect(getBlob).toHaveBeenCalledOnce();
  });

  it("clears apply entries while retaining local entries", () => {
    addEntry(entry({ id: "local" }));
    addEntry(entry({ id: "apply", source: "apply" }));
    setCurrentGame("apply");

    clearApplyEntries();

    expect(getEmulatorSessionState().entries.map(({ id }) => id)).toEqual(["local"]);
    expect(getEmulatorSessionState().currentGameId).toBeNull();
  });
});
