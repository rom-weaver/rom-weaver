// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  addEntry,
  dismissClosedGameNotice,
  disposeEntry,
  getClosedGameName,
  getEmulatorSessionState,
} from "../../src/public/react/emulator-session-store.ts";
import { releaseLargeEntriesOnLargeInput } from "../../src/webapp/large-input-release.ts";

const GIB = 1024 ** 3;

const addDisc = () =>
  addEntry({
    blob: new Blob(["disc"]),
    fileName: "disc.chd",
    id: "disc",
    sizeBytes: 464 * 1024 * 1024,
    source: "local",
  });

// Sized stand-ins: a real gibibyte-sized File would need its bytes in memory.
const files = (...sizes: number[]) => sizes.map((size, index) => ({ name: `part-${index}.bin`, size }));

const pick = (...sizes: number[]) => {
  const input = document.createElement("input");
  input.type = "file";
  document.body.append(input);
  Object.defineProperty(input, "files", { value: files(...sizes) });
  let gamesWhenToolRead: number | undefined;
  input.addEventListener("change", () => {
    gamesWhenToolRead = getEmulatorSessionState().entries.length;
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.remove();
  return gamesWhenToolRead;
};

const drop = (...sizes: number[]) => {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: files(...sizes) } });
  document.body.dispatchEvent(event);
};

afterEach(() => {
  while (getEmulatorSessionState().entries.length) disposeEntry(getEmulatorSessionState().entries[0].id);
  dismissClosedGameNotice();
});

describe("releaseLargeEntriesOnLargeInput", () => {
  it("closes a paused disc before the tool reads a pick of more than 1 GiB", () => {
    const stop = releaseLargeEntriesOnLargeInput(() => false);
    addDisc();

    // A disc's tracks can arrive as several files, so the pick counts as a whole.
    expect(pick(GIB / 2, GIB / 2 + 1)).toBe(0);
    expect(getClosedGameName()).toBe("disc.chd");
    stop();
  });

  it("closes a paused disc when more than 1 GiB is dropped", () => {
    const stop = releaseLargeEntriesOnLargeInput(() => false);
    addDisc();

    drop(GIB + 1);

    expect(getEmulatorSessionState().entries).toHaveLength(0);
    stop();
  });

  it("keeps the paused disc for 1 GiB or less, inside Test, and once stopped", () => {
    let testShown = false;
    const stop = releaseLargeEntriesOnLargeInput(() => testShown);
    addDisc();

    expect(pick(GIB)).toBe(1);
    drop(GIB);
    testShown = true;
    // Test loads its own replacement game and closes the paused one itself.
    expect(pick(2 * GIB)).toBe(1);
    drop(2 * GIB);
    testShown = false;
    stop();
    expect(pick(2 * GIB)).toBe(1);
    drop(2 * GIB);

    expect(getEmulatorSessionState().entries).toHaveLength(1);
    expect(getClosedGameName()).toBeNull();
  });
});
