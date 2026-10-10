import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { EmulatorTestView } from "../../src/public/react/emulator-test-view.tsx";
import {
  addEntry,
  disposeEntry,
  getEmulatorSessionState,
  restartCurrentGameWithSave,
} from "../../src/public/react/emulator-session-store.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { deleteEmulatorSave, listEmulatorSaves, writeEmulatorSave } from "../../src/storage/browser/emulator-saves.ts";

// Exercise the real view, ref lifecycle and save bridge without loading a ROM or
// third-party emulator. This srcdoc speaks the same save protocol immediately.
vi.mock("../../src/public/react/components/emulator-document.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  createEmulatorDocument: (_dataUrl, _gameUrl, _gameName, _core, { saveId }) => `<script>
    const gameId = ${JSON.stringify(saveId)};
    window.addEventListener("message", (event) => {
      if (event.source !== parent || event.data.kind !== "load-sram") return;
      parent.postMessage({ source: "save-bridge-test", data: event.data.data }, "*");
      parent.postMessage({ source: "rom-weaver-emulator", kind: "save-state", gameId, data: new Uint8Array([7, 8]) }, "*");
    });
    parent.postMessage({ source: "rom-weaver-emulator", kind: "request-load-sram", gameId }, "*");
  </script>`,
}));

const gameId = "c".repeat(40);

afterEach(async () => {
  cleanup();
  for (const entry of getEmulatorSessionState().entries) disposeEntry(entry.id);
  await deleteEmulatorSave(gameId);
  vi.restoreAllMocks();
});

it("registers before the srcdoc's first request and revokes the old frame on restart and stop", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({});
  await writeEmulatorSave({ gameId, gameName: gameId, label: "Synthetic", updatedAt: 1, sram: new Uint8Array([3, 4]) });
  addEntry({
    id: "save-session",
    blob: new Blob(["synthetic"]),
    checksum: gameId,
    core: "nes",
    fileName: "synthetic.nes",
    sizeBytes: 9,
    source: "local",
  });
  const replies = [];
  const receive = (event) => {
    if (event.data?.source === "save-bridge-test") replies.push({ source: event.source, data: event.data.data });
  };
  window.addEventListener("message", receive);
  try {
    render(createElement(RomWeaverSettingsProvider, { settings: {} }, createElement(EmulatorTestView)));
    await expect.poll(() => replies.length).toBe(1);
    const firstFrame = document.querySelector("iframe");
    const firstWindow = firstFrame.contentWindow;
    expect(replies[0].source).toBe(firstWindow);
    expect(replies[0].data).toEqual(new Uint8Array([3, 4]));
    await expect
      .poll(async () => (await listEmulatorSaves()).find((save) => save.gameId === gameId)?.state)
      .toEqual(new Uint8Array([7, 8]));

    act(() => restartCurrentGameWithSave("save-session"));
    await expect.poll(() => replies.length).toBe(2);
    const secondFrame = document.querySelector("iframe");
    expect(secondFrame).not.toBe(firstFrame);
    expect(replies[1].source).toBe(secondFrame.contentWindow);
    expect(replies[1].data).toEqual(new Uint8Array([3, 4]));
    // A queued message retains its old WindowProxy even after its frame is gone.
    const staleWrite = (source) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source,
          data: { source: "rom-weaver-emulator", gameId, kind: "save-state", data: new Uint8Array([99]) },
        }),
      );
    staleWrite(firstWindow);
    const secondWindow = secondFrame.contentWindow;
    fireEvent.click(screen.getByRole("button", { name: "Stop and unload game" }));
    expect(document.querySelector("iframe")).toBeNull();
    staleWrite(secondWindow);
    expect((await listEmulatorSaves()).find((save) => save.gameId === gameId)?.state).toEqual(new Uint8Array([7, 8]));
  } finally {
    window.removeEventListener("message", receive);
  }
});
