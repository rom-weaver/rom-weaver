// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEmulatorRom } from "../../../src/public/react/components/emulator-load-rom.ts";
import { EmulatorJsAction } from "../../../src/public/react/apply-emulatorjs-action.tsx";
import { addEntry, disposeEntry, getEmulatorSessionState } from "../../../src/public/react/emulator-session-store.ts";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";

vi.mock("../../../src/public/react/emulator-audio-context.ts", () => ({
  prepareEmulatorAudioContext: vi.fn(() => true),
  requestEmulatorStartFromUserAction: vi.fn(() => true),
}));

vi.mock("../../../src/public/react/components/emulator-load-rom.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/public/react/components/emulator-load-rom.ts")>()),
  loadEmulatorRom: vi.fn(async (blob: Blob, fileName: string) => ({ blob, checksum: "b".repeat(40), fileName })),
}));

afterEach(() => {
  cleanup();
  while (getEmulatorSessionState().entries.length) disposeEntry(getEmulatorSessionState().entries[0].id);
});

describe("EmulatorJsAction", () => {
  it("unloads a disc-sized Test game before it reads the patched output", async () => {
    addEntry({
      blob: new Blob(["original"]),
      checksum: "a".repeat(40),
      core: "psx",
      fileName: "game.chd",
      id: "original",
      sizeBytes: 464 * 1024 * 1024,
      source: "local",
    });
    const prepared = new Blob(["zip"]);
    const expandedSizeBytes = 128 * 1024 * 1024 + 1;
    vi.mocked(loadEmulatorRom).mockResolvedValueOnce({
      blob: prepared,
      checksum: "b".repeat(40),
      fileName: "game.zip",
      expandedSizeBytes,
    });
    let gamesDuringRead: number | undefined;
    const output = {
      fileName: "game (patched).pbp",
      getBlob: async () => {
        gamesDuringRead = getEmulatorSessionState().entries.length;
        return new Blob(["patched"]);
      },
      id: "patched",
      size: 7,
    };
    const onSelectView = vi.fn();
    render(
      <RomWeaverSettingsProvider settings={{}}>
        <EmulatorJsAction core="psx" onSelectView={onSelectView} output={output as never} platform="psx" shown />
      </RomWeaverSettingsProvider>,
    );

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(onSelectView).toHaveBeenCalledWith("test"));
    // The paused disc and the patched one read in its place can exceed an iOS tab's memory limit together.
    expect(gamesDuringRead).toBe(0);
    expect(getEmulatorSessionState().currentGameId).toBe("patched");
    expect(getEmulatorSessionState().entries[0]).toMatchObject({ sizeBytes: prepared.size, expandedSizeBytes });
  });
});
