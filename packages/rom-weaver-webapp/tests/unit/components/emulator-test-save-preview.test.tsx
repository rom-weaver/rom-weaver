// @vitest-environment happy-dom
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmulatorTestView } from "../../../src/public/react/emulator-test-view.tsx";
import { addEntry, disposeEntry, getEmulatorSessionState } from "../../../src/public/react/emulator-session-store.ts";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import {
  configureEmulatorSaveStorage,
  registerEmulatorSaveBridge,
} from "../../../src/storage/browser/emulator-saves.ts";

vi.mock("../../../src/public/react/emulator-audio-context.ts", () => ({
  disposeEmulatorAudioContext: vi.fn(),
  prepareEmulatorAudioContext: vi.fn(() => true),
  registerEmulatorStartRequestHandler: vi.fn(() => () => undefined),
  requestEmulatorStartFromUserAction: vi.fn(() => true),
}));

const loadRomMock = vi.hoisted(() => vi.fn());
const pending = vi.hoisted(() => ({ clear: vi.fn(), read: vi.fn() }));

vi.mock("../../../src/public/react/components/emulator-load-rom.ts", () => ({ loadEmulatorRom: loadRomMock }));

vi.mock("../../../src/storage/browser/emulator-saves.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/storage/browser/emulator-saves.ts")>()),
  clearPendingTestSave: pending.clear,
  readPendingTestSave: pending.read,
}));

vi.mock("../../../src/public/react/components/emulator-document.ts", () => ({
  createEmulatorDocument: () => "<!doctype html><html><body></body></html>",
  createEmulatorGameIdentity: ({ checksum }: { checksum: string }) => ({
    gameId: 1,
    gameName: checksum,
    saveId: checksum,
  }),
}));

const SHA1 = "b".repeat(40);
const NativeURL = URL;

const withStorageOff = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{ emulatorSaveStorageEnabled: false }}>{children}</RomWeaverSettingsProvider>
);

const addCurrentGame = () =>
  addEntry({
    blob: new Blob(["rom"]),
    checksum: SHA1,
    core: "nes",
    fileName: "game.nes",
    id: "current",
    sizeBytes: 3,
    source: "local",
  });

/** Asks the save bridge for SRAM the way the player frame does after a restart. */
const requestSram = () => {
  const listeners = new Set<(event: MessageEvent<unknown>) => void>();
  const origin = "https://app.test";
  const host = {
    addEventListener: (_type: string, listener: (event: MessageEvent<unknown>) => void) => listeners.add(listener),
    origin,
    removeEventListener: (_type: string, listener: (event: MessageEvent<unknown>) => void) =>
      listeners.delete(listener),
  };
  const source = { postMessage: vi.fn() };
  const frame = {
    contentWindow: source,
    hasAttribute: () => false,
    isConnected: true,
    ownerDocument: { defaultView: host },
  } as unknown as HTMLIFrameElement;
  const unregister = registerEmulatorSaveBridge(frame, SHA1);
  for (const listener of listeners) {
    listener({
      data: { gameId: SHA1, kind: "request-load-sram", source: "rom-weaver-emulator" },
      origin,
      source,
    } as unknown as MessageEvent<unknown>);
  }
  unregister();
  return (source.postMessage.mock.calls[0]?.[0] as { data: Uint8Array | null } | undefined)?.data;
};

beforeEach(() => {
  class TestURL extends NativeURL {}
  Object.assign(TestURL, { createObjectURL: vi.fn().mockReturnValue("blob:created"), revokeObjectURL: vi.fn() });
  vi.stubGlobal("URL", TestURL);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
  pending.read.mockResolvedValue(undefined);
  pending.clear.mockResolvedValue(undefined);
  loadRomMock.mockImplementation(async (blob: Blob, fileName: string) => ({ blob, checksum: SHA1, fileName }));
  configureEmulatorSaveStorage(false);
});

afterEach(() => {
  cleanup();
  while (getEmulatorSessionState().entries.length) disposeEntry(getEmulatorSessionState().entries[0].id);
  configureEmulatorSaveStorage(true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EmulatorTestView save previews for the current ROM", () => {
  it("keeps a save dropped with the ROM that is already playing", async () => {
    addCurrentGame();
    const files = [new File(["rom"], "game.nes"), new File([new Uint8Array([4, 5])], "game.sav")];
    render(withStorageOff(<EmulatorTestView pageDrop={{ files, id: 1 }} />));

    await waitFor(() => expect(getEmulatorSessionState().entries[0]?.savePreviewRevision).toBe(1));
    expect(getEmulatorSessionState().entries[0]?.id).not.toBe("current");
    expect(requestSram()).toEqual(new Uint8Array([4, 5]));
  });

  it("keeps a Save editor hand-off for the ROM that is already playing", async () => {
    pending.read.mockResolvedValue({
      bytes: new Uint8Array([7]),
      fileName: "game.sav",
      gameId: "game",
      platform: "snes",
      updatedAt: 1,
    });
    loadRomMock.mockImplementation(async (blob: Blob, fileName: string) => ({
      blob,
      checksum: SHA1,
      fileName,
      platform: "snes",
    }));
    addCurrentGame();
    render(withStorageOff(<EmulatorTestView pageDrop={{ files: [new File(["rom"], "game.nes")], id: 1 }} />));

    await waitFor(() => expect(getEmulatorSessionState().entries[0]?.savePreviewRevision).toBe(1));
    expect(requestSram()).toEqual(new Uint8Array([7]));
  });
});
