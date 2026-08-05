import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addEntry,
  clearApplyEntries,
  disposeEntry,
  getEmulatorSessionState,
  setCurrentGame,
  type EmulatorSessionEntry,
} from "../../src/public/react/emulator-session-store.ts";

const entry = (overrides: Partial<EmulatorSessionEntry> = {}): EmulatorSessionEntry => ({
  fileName: "game.nes",
  id: "game",
  objectUrl: "blob:game",
  sizeBytes: 3,
  source: "local",
  ...overrides,
});

const createObjectUrl = vi.fn();
const revokeObjectUrl = vi.fn();

beforeEach(() => {
  vi.stubGlobal("URL", { createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl });
  createObjectUrl.mockClear();
  createObjectUrl.mockReturnValueOnce("blob:one").mockReturnValueOnce("blob:two");
  revokeObjectUrl.mockClear();
});

afterEach(() => {
  while (getEmulatorSessionState().entries.length) disposeEntry(getEmulatorSessionState().entries[0].id);
  vi.unstubAllGlobals();
});

describe("emulator session store", () => {
  it("adds and replaces an entry with the same id", () => {
    addEntry(entry({ objectUrl: createObjectUrl(new Blob(["one"])) }));
    addEntry(entry({ fileName: "updated.nes", objectUrl: createObjectUrl(new Blob(["two"])) }));

    expect(getEmulatorSessionState().entries).toEqual([entry({ fileName: "updated.nes", objectUrl: "blob:two" })]);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:one");
  });

  it("revokes an entry URL when the entry is disposed", () => {
    addEntry(entry({ objectUrl: "blob:dispose" }));
    setCurrentGame("game");

    disposeEntry("game");

    expect(getEmulatorSessionState()).toEqual({ currentGameId: null, entries: [] });
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:dispose");
  });

  it("clears apply entries while retaining local entries", () => {
    addEntry(entry({ id: "local", objectUrl: "blob:local" }));
    addEntry(entry({ id: "apply", objectUrl: "blob:apply", source: "apply" }));
    setCurrentGame("apply");

    clearApplyEntries();

    expect(getEmulatorSessionState().entries.map(({ id }) => id)).toEqual(["local"]);
    expect(getEmulatorSessionState().currentGameId).toBeNull();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:apply");
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:local");
  });
});
