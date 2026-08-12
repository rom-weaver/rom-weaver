// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowProgress } from "../../../src/platform/browser/browser-api.ts";
import { EmulatorTestView } from "../../../src/public/react/emulator-test-view.tsx";
import { addEntry, disposeEntry, getEmulatorSessionState } from "../../../src/public/react/emulator-session-store.ts";
import type { EmulatorSessionEntry } from "../../../src/public/react/emulator-session-store.ts";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";

const emulatorAudioMocks = vi.hoisted(() => ({
  disposeEmulatorAudioContext: vi.fn(),
  prepareEmulatorAudioContext: vi.fn(() => true),
  registerEmulatorStartRequestHandler: vi.fn(() => () => undefined),
  requestEmulatorStartFromUserAction: vi.fn(() => true),
}));

vi.mock("../../../src/public/react/emulator-audio-context.ts", () => emulatorAudioMocks);

const loadRomMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/public/react/components/emulator-load-rom.ts", () => ({
  loadEmulatorRom: loadRomMock,
}));

vi.mock("../../../src/public/react/components/emulator-document.ts", () => ({
  createEmulatorDocument: () => "<!doctype html><html><body></body></html>",
  createEmulatorGameIdentity: ({ fileName }: { fileName: string }) => ({
    gameId: 1,
    gameName: `rom-weaver-${fileName}`,
  }),
}));

const NativeURL = URL;

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const entry = (overrides: Partial<EmulatorSessionEntry> = {}): EmulatorSessionEntry => ({
  blob: new Blob(["game"]),
  core: "nes",
  fileName: "game.nes",
  id: "game",
  sizeBytes: 3,
  source: "local",
  ...overrides,
});

const stubObjectUrls = () => {
  const createObjectUrl = vi.fn().mockReturnValue("blob:created");
  const revokeObjectUrl = vi.fn();
  class TestURL extends NativeURL {}
  Object.assign(TestURL, { createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl });
  vi.stubGlobal("URL", TestURL);
  return { createObjectUrl, revokeObjectUrl };
};

beforeEach(() => {
  loadRomMock.mockReset();
  loadRomMock.mockImplementation(async (blob: Blob, fileName: string) => ({ blob, fileName }));
});

afterEach(() => {
  cleanup();
  while (getEmulatorSessionState().entries.length) disposeEntry(getEmulatorSessionState().entries[0].id);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EmulatorTestView", () => {
  it("shows the hero drop state with ghost steps for an empty session", () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);

    render(withSettings(<EmulatorTestView />));

    expect(screen.getByText("Play a patched ROM in an emulator, right in the browser,")).toBeTruthy();
    expect(screen.getByText("Next:")).toBeTruthy();
    expect(screen.getByText("Play")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Play" })).toBeNull();
  });

  it("shows an actionable error and restores the hero for an unsupported file", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    loadRomMock.mockResolvedValue({ blob: new Blob(["disc"]), fileName: "game.iso" });

    render(withSettings(<EmulatorTestView />));
    fireEvent.change(screen.getByLabelText(/Drop a ROM or choose a file/), {
      target: { files: [new File(["disc"], "game.iso")] },
    });

    expect((await screen.findByRole("alert")).textContent).toContain("Cannot play game.iso.");
    expect(screen.getByText("Play a patched ROM in an emulator, right in the browser,")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Play" })).toBeNull();
  });

  it("replaces the current game without a game list", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    addEntry(entry());
    addEntry(entry({ blob: new Blob(["second"]), core: "snes", fileName: "second.sfc", id: "second" }));

    render(withSettings(<EmulatorTestView />));

    expect(getEmulatorSessionState().currentGameId).toBe("second");
    expect(await screen.findByTitle("EmulatorJS test for second.sfc")).toBeTruthy();
    expect(screen.queryByText("game.nes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
  });

  it("shows extraction progress before it opens the selected game", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    let finishLoad: ((value: { blob: Blob; fileName: string }) => void) | undefined;
    loadRomMock.mockImplementation(
      async (_blob: Blob, _fileName: string, options: { onProgress?: (progress: WorkflowProgress) => void }) => {
        options.onProgress?.({
          id: "extract",
          label: "Extracting games.zip...",
          percent: 42,
          role: "input",
          sequence: 1,
          stage: "decompress",
          workflow: "apply",
        });
        return new Promise<{ blob: Blob; fileName: string }>((resolve) => {
          finishLoad = resolve;
        });
      },
    );

    render(withSettings(<EmulatorTestView />));
    fireEvent.change(screen.getByLabelText(/Drop a ROM or choose a file/), {
      target: { files: [new File(["archive"], "games.zip")] },
    });

    expect(await screen.findByText("Extracting games.zip...")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    await act(async () => finishLoad?.({ blob: new Blob(["game"]), fileName: "game.nes" }));
    expect(await screen.findByTitle("EmulatorJS test for game.nes")).toBeTruthy();
    expect(emulatorAudioMocks.prepareEmulatorAudioContext).toHaveBeenCalledWith("rom-weaver-game.nes");
  });

  it("ignores a replacement that finishes after Stop is pressed", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    let finishLoad: ((value: { blob: Blob; fileName: string }) => void) | undefined;
    loadRomMock.mockImplementation(
      async () =>
        new Promise<{ blob: Blob; fileName: string }>((resolve) => {
          finishLoad = resolve;
        }),
    );
    addEntry(entry());

    render(withSettings(<EmulatorTestView />));
    fireEvent.change(screen.getByLabelText(/Choose another ROM/), {
      target: { files: [new File(["archive"], "replacement.zip")] },
    });
    await waitFor(() => expect(loadRomMock).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Stop and unload game" }));
    await act(async () => finishLoad?.({ blob: new Blob(["replacement"]), fileName: "replacement.nes" }));

    expect(getEmulatorSessionState()).toEqual({ currentGameId: null, entries: [] });
    expect(screen.getByText("Play a patched ROM in an emulator, right in the browser,")).toBeTruthy();
  });

  it("keeps a WebGL 2 error visible and blocks the player", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    addEntry(entry());

    render(withSettings(<EmulatorTestView />));

    expect((await screen.findByRole("alert")).textContent).toContain("requires a browser with WebGL 2");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByTitle("EmulatorJS test for game.nes")).toBeNull();
  });

  it("centers a new game on coarse-pointer screens", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query === "(pointer: coarse)" })),
    );
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    addEntry(entry());

    render(withSettings(<EmulatorTestView />));

    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "center",
      }),
    );
  });

  it("unloads the game and returns to the hero when Stop is pressed", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    addEntry(entry());

    render(withSettings(<EmulatorTestView />));
    fireEvent.click(await screen.findByRole("button", { name: "Stop and unload game" }));

    expect(getEmulatorSessionState()).toEqual({ currentGameId: null, entries: [] });
    expect(screen.getByText("Play a patched ROM in an emulator, right in the browser,")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Play" })).toBeNull();
  });

  it("keeps prepared audio when a retained game gains its blob", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    addEntry(
      entry({
        artifact: {
          dispose: vi.fn(),
          getBlob: vi.fn(async () => new Blob(["game"])),
        },
        blob: undefined,
      }),
    );
    emulatorAudioMocks.disposeEmulatorAudioContext.mockClear();

    render(withSettings(<EmulatorTestView />));

    await waitFor(() => expect(screen.getByTitle("EmulatorJS test for game.nes")).toBeTruthy());
    expect(emulatorAudioMocks.disposeEmulatorAudioContext).not.toHaveBeenCalled();
  });
});
