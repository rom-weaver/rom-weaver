// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowProgress } from "../../../src/platform/browser/browser-api.ts";
import { EmulatorTestView } from "../../../src/public/react/emulator-test-view.tsx";
import {
  addEntry,
  disposeEntry,
  getEmulatorSessionState,
  restartCurrentGameWithSave,
} from "../../../src/public/react/emulator-session-store.ts";
import type { EmulatorSessionEntry } from "../../../src/public/react/emulator-session-store.ts";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { navigatorWith } from "../navigator-test-utils.ts";

const emulatorAudioMocks = vi.hoisted(() => ({
  disposeEmulatorAudioContext: vi.fn(),
  prepareEmulatorAudioContext: vi.fn(() => true),
  registerEmulatorStartRequestHandler: vi.fn(() => () => undefined),
  requestEmulatorStartFromUserAction: vi.fn(() => true),
}));

vi.mock("../../../src/public/react/emulator-audio-context.ts", () => emulatorAudioMocks);

const loadRomMock = vi.hoisted(() => vi.fn());
const pendingSaveMocks = vi.hoisted(() => ({
  clearPendingTestSave: vi.fn(),
  loadDroppedSram: vi.fn(),
  readPendingTestSave: vi.fn(),
  stagePendingTestSave: vi.fn(),
}));

vi.mock("../../../src/public/react/components/emulator-load-rom.ts", () => ({
  loadEmulatorRom: loadRomMock,
}));

vi.mock("../../../src/storage/browser/emulator-saves.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/storage/browser/emulator-saves.ts")>()),
  clearPendingTestSave: pendingSaveMocks.clearPendingTestSave,
  loadDroppedSram: pendingSaveMocks.loadDroppedSram,
  readPendingTestSave: pendingSaveMocks.readPendingTestSave,
  stagePendingTestSave: pendingSaveMocks.stagePendingTestSave,
}));

vi.mock("../../../src/public/react/components/emulator-document.ts", () => ({
  createEmulatorDocument: () => "<!doctype html><html><body></body></html>",
  createEmulatorGameIdentity: ({ checksum }: { checksum: string }) => ({
    gameId: 1,
    gameName: checksum,
    saveId: checksum,
  }),
}));

const NativeURL = URL;

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const entry = (overrides: Partial<EmulatorSessionEntry> = {}): EmulatorSessionEntry => ({
  blob: new Blob(["game"]),
  checksum: "a".repeat(40),
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
  vi.clearAllMocks();
  pendingSaveMocks.readPendingTestSave.mockResolvedValue(undefined);
  pendingSaveMocks.clearPendingTestSave.mockResolvedValue(undefined);
  pendingSaveMocks.loadDroppedSram.mockResolvedValue("stored");
  loadRomMock.mockReset();
  loadRomMock.mockImplementation(async (blob: Blob, fileName: string) => ({
    blob,
    checksum: "b".repeat(40),
    fileName,
  }));
});

const stubReducedMotion = () => {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        addEventListener: vi.fn(),
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
};

const stubUserActivation = (isActive: boolean) => {
  Object.defineProperty(window.navigator, "userActivation", {
    configurable: true,
    value: { hasBeenActive: isActive, isActive },
  });
};

afterEach(() => {
  cleanup();
  while (getEmulatorSessionState().entries.length) disposeEntry(getEmulatorSessionState().entries[0].id);
  window.history.replaceState(null, "", "/test-rom");
  Reflect.deleteProperty(window.navigator, "userActivation");
  delete (document as { hasFocus?: () => boolean }).hasFocus;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EmulatorTestView", () => {
  it("opens a matching uploaded ROM with the saved upload", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    pendingSaveMocks.readPendingTestSave.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3, 4]),
      fileName: "zelda.srm",
      gameId: "zelda-a-link-to-the-past",
      platform: "snes",
      updatedAt: 1,
    });
    loadRomMock.mockImplementation(async (blob: Blob) => ({
      blob,
      checksum: "b".repeat(40),
      fileName: "zelda.sfc",
      platform: "snes",
    }));

    const view = render(withSettings(<EmulatorTestView />));
    expect(await screen.findByText("zelda.srm")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Drop or click to add a ROM or archive/), {
      target: { files: [new File(["rom"], "zelda.sfc")] },
    });

    await waitFor(() => expect(pendingSaveMocks.clearPendingTestSave).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Waiting for EmulatorJS to load the save bytes.")).toBeTruthy();
    const iframe = document.querySelector("iframe");
    expect(iframe?.contentWindow).toBeTruthy();
    view.rerender(withSettings(<EmulatorTestView active={false} />));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { gameId: "b".repeat(40), kind: "sram-loaded", source: "rom-weaver-emulator" },
          source: iframe?.contentWindow,
        }),
      );
    });
    view.rerender(withSettings(<EmulatorTestView />));
    expect(screen.getByText("Save loaded and game restarted. Check the game's Continue menu.")).toBeTruthy();
    expect(screen.queryByText("zelda.srm")).toBeNull();
  });
  it("holds a save dropped without a ROM for the next ROM", async () => {
    const save = new File([new Uint8Array([7])], "zelda.srm");
    pendingSaveMocks.stagePendingTestSave.mockResolvedValue({
      bytes: new Uint8Array([7]),
      fileName: "zelda.srm",
      updatedAt: 1,
    });

    render(withSettings(<EmulatorTestView pageDrop={{ files: [save], id: 1 }} />));

    expect(await screen.findByText("zelda.srm")).toBeTruthy();
    expect(pendingSaveMocks.stagePendingTestSave).toHaveBeenCalledWith({ data: save, fileName: "zelda.srm" });
    expect(loadRomMock).not.toHaveBeenCalled();
  });

  it("stores a held dropped save for whichever ROM opens next", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    const bytes = new Uint8Array([1, 2]);
    pendingSaveMocks.readPendingTestSave.mockResolvedValue({ bytes, fileName: "zelda.srm", updatedAt: 1 });
    loadRomMock.mockImplementation(async (blob: Blob) => ({
      blob,
      checksum: "b".repeat(40),
      fileName: "zelda.sfc",
      platform: "snes",
    }));

    render(withSettings(<EmulatorTestView />));
    expect(await screen.findByText("zelda.srm")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Drop or click to add a ROM or archive/), {
      target: { files: [new File(["rom"], "zelda.sfc")] },
    });

    await waitFor(() =>
      expect(pendingSaveMocks.loadDroppedSram).toHaveBeenCalledWith("b".repeat(40), bytes, "zelda.sfc"),
    );
    expect(pendingSaveMocks.clearPendingTestSave).toHaveBeenCalledTimes(1);
    expect(getEmulatorSessionState().entries[0]?.savePreviewRevision).toBe(1);
    await waitFor(() => expect(screen.queryByText("zelda.srm")).toBeNull());
  });

  it("keeps a held save when a save arrives with the ROM", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    pendingSaveMocks.readPendingTestSave.mockResolvedValue({
      bytes: new Uint8Array([1]),
      fileName: "zelda.srm",
      updatedAt: 1,
    });

    render(
      withSettings(
        <EmulatorTestView
          pageDrop={{ files: [new File(["rom"], "mario.nes"), new File([new Uint8Array([4, 5])], "mario.sav")], id: 1 }}
        />,
      ),
    );

    await waitFor(() =>
      expect(pendingSaveMocks.loadDroppedSram).toHaveBeenCalledWith(
        "b".repeat(40),
        new Uint8Array([4, 5]),
        "mario.nes",
      ),
    );
    expect(pendingSaveMocks.clearPendingTestSave).not.toHaveBeenCalled();
    expect(screen.getByText("zelda.srm")).toBeTruthy();
  });

  it("loads nothing when a save dropped with its ROM cannot be read", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    const save = new File([new Uint8Array([4])], "game.sav");
    vi.spyOn(save, "arrayBuffer").mockRejectedValue(new DOMException("File changed", "NotReadableError"));

    render(withSettings(<EmulatorTestView pageDrop={{ files: [new File(["rom"], "game.nes"), save], id: 1 }} />));

    expect(await screen.findByText(/Could not load game.nes/)).toBeTruthy();
    expect(getEmulatorSessionState().entries).toHaveLength(0);
  });

  it("opens a Save editor hand-off without reading a save dropped beside the ROM", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    pendingSaveMocks.readPendingTestSave.mockResolvedValue({
      bytes: new Uint8Array([7]),
      fileName: "edited.srm",
      gameId: "zelda",
      platform: "snes",
      updatedAt: 1,
    });
    loadRomMock.mockImplementation(async (blob: Blob, fileName: string) => ({
      blob,
      checksum: "b".repeat(40),
      fileName,
      platform: "snes",
    }));
    const save = new File([new Uint8Array([4])], "zelda.srm");
    const read = vi.spyOn(save, "arrayBuffer").mockRejectedValue(new DOMException("File changed", "NotReadableError"));

    render(withSettings(<EmulatorTestView pageDrop={{ files: [new File(["rom"], "zelda.sfc"), save], id: 1 }} />));

    await waitFor(() => expect(getEmulatorSessionState().entries[0]?.savePreviewRevision).toBe(1));
    expect(read).not.toHaveBeenCalled();
    expect(pendingSaveMocks.loadDroppedSram).not.toHaveBeenCalled();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it("stores a save dropped together with its ROM", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);

    render(
      withSettings(
        <EmulatorTestView
          pageDrop={{ files: [new File(["rom"], "game.nes"), new File([new Uint8Array([4])], "game.sav")], id: 1 }}
        />,
      ),
    );

    await waitFor(() =>
      expect(pendingSaveMocks.loadDroppedSram).toHaveBeenCalledWith("b".repeat(40), new Uint8Array([4]), "game.nes"),
    );
    expect(loadRomMock).toHaveBeenCalledWith(expect.any(File), "game.nes", expect.anything());
    expect(getEmulatorSessionState().entries[0]?.savePreviewRevision).toBe(1);
  });

  it("discards a staged save from its tray", async () => {
    pendingSaveMocks.readPendingTestSave.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3, 4]),
      fileName: "zelda.srm",
      gameId: "zelda-a-link-to-the-past",
      platform: "snes",
      updatedAt: 1,
    });
    render(withSettings(<EmulatorTestView />));
    expect(await screen.findByText("Save to load")).toBeTruthy();
    expect(screen.getByText("Add the ROM of the game that made this save.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard save" }));
    await waitFor(() => expect(pendingSaveMocks.clearPendingTestSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("zelda.srm")).toBeNull());
  });
  it("keeps a staged save when the uploaded ROM uses another system", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    pendingSaveMocks.readPendingTestSave.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3, 4]),
      fileName: "ruby.sav",
      gameId: "pokemon-ruby",
      platform: "gba",
      updatedAt: 1,
    });
    loadRomMock.mockImplementation(async (blob: Blob) => ({
      blob,
      checksum: "b".repeat(40),
      fileName: "zelda.sfc",
      platform: "snes",
    }));

    render(withSettings(<EmulatorTestView />));
    expect(await screen.findByText("ruby.sav")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Drop or click to add a ROM or archive/), {
      target: { files: [new File(["rom"], "zelda.sfc")] },
    });

    expect(await screen.findByText(/zelda.sfc does not match ruby.sav/)).toBeTruthy();
    expect(pendingSaveMocks.clearPendingTestSave).not.toHaveBeenCalled();
    expect(getEmulatorSessionState().entries[0]?.savePreviewRevision).toBeUndefined();
  });
  it("does not restore a consumed save from an older storage read", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    const staged = {
      bytes: new Uint8Array([1, 2, 3, 4]),
      fileName: "zelda.srm",
      gameId: "zelda-a-link-to-the-past",
      platform: "snes",
      updatedAt: 1,
    };
    let finishFirstRead: ((save: typeof staged) => void) | undefined;
    pendingSaveMocks.readPendingTestSave.mockReset();
    pendingSaveMocks.readPendingTestSave
      .mockReturnValueOnce(
        new Promise<typeof staged>((resolve) => {
          finishFirstRead = resolve;
        }),
      )
      .mockResolvedValueOnce(staged);
    loadRomMock.mockImplementation(async (blob: Blob) => ({
      blob,
      checksum: "b".repeat(40),
      fileName: "zelda.sfc",
      platform: "snes",
    }));

    render(withSettings(<EmulatorTestView />));
    fireEvent.change(screen.getByLabelText(/Drop or click to add a ROM or archive/), {
      target: { files: [new File(["rom"], "zelda.sfc")] },
    });
    await waitFor(() => expect(pendingSaveMocks.clearPendingTestSave).toHaveBeenCalledTimes(1));
    await act(async () => finishFirstRead?.(staged));
    expect(screen.queryByText("zelda.srm")).toBeNull();
  });
  it("shows the hero drop state with ghost steps for an empty session", () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);

    render(withSettings(<EmulatorTestView />));

    expect(screen.getByRole("heading", { level: 1, name: "Test your ROM online." })).toBeTruthy();
    expect(screen.getByText("Next:")).toBeTruthy();
    expect(screen.getByText("Play")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Play" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Play a practice ROM/ }));
    expect(screen.getByRole("link", { name: "Start a practice run" }).getAttribute("href")).toBe(
      "/test-rom?guide=test",
    );
    const download = screen.getByRole("link", { name: "Download the sample ROM" });
    expect(download.getAttribute("href")).toBe("/hello-world.nes");
    expect(download.hasAttribute("download")).toBe(true);
  });

  it("loads the homebrew ROM into the guided Test flow", async () => {
    stubObjectUrls();
    stubReducedMotion();
    stubUserActivation(true);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    const fetchSample = vi.fn().mockResolvedValue({
      blob: () => Promise.resolve(new Blob(["sample"])),
      ok: true,
      status: 200,
    } as Response);
    vi.stubGlobal("fetch", fetchSample);

    render(withSettings(<EmulatorTestView />));
    fireEvent.click(screen.getByRole("button", { name: /Play a practice ROM/ }));
    fireEvent.click(screen.getByRole("link", { name: "Start a practice run" }));

    expect(emulatorAudioMocks.prepareEmulatorAudioContext).toHaveBeenCalledWith();
    await waitFor(() => expect(getEmulatorSessionState().entries[0]?.fileName).toBe("hello-world.nes"));
    expect(fetchSample).toHaveBeenCalledWith("/hello-world.nes", { signal: expect.any(AbortSignal) });
    expect(getEmulatorSessionState().currentGameId).toBe(getEmulatorSessionState().entries[0]?.id);
    expect(emulatorAudioMocks.prepareEmulatorAudioContext).toHaveBeenCalledWith("b".repeat(40));
    expect(screen.getByText("hello-world.nes", { selector: ".emulator-player-copy .ck-v" })).toBeTruthy();
    expect(screen.getByText("b".repeat(40))).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("dialog", { name: "A game is loaded" })).toBeTruthy());
    expect(screen.getByTitle("EmulatorJS test for hello-world.nes")).toBeTruthy();
  });

  it("leaves a held save for the visitor's own ROM when the guided sample loads", async () => {
    stubObjectUrls();
    stubReducedMotion();
    stubUserActivation(true);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    pendingSaveMocks.readPendingTestSave.mockResolvedValue({
      bytes: new Uint8Array([1]),
      fileName: "zelda.srm",
      updatedAt: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ blob: () => Promise.resolve(new Blob(["sample"])), ok: true, status: 200 } as Response),
    );

    render(withSettings(<EmulatorTestView />));
    expect(await screen.findByText("zelda.srm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Play a practice ROM/ }));
    fireEvent.click(screen.getByRole("link", { name: "Start a practice run" }));

    await waitFor(() => expect(getEmulatorSessionState().entries[0]?.fileName).toBe("hello-world.nes"));
    expect(pendingSaveMocks.loadDroppedSram).not.toHaveBeenCalled();
    expect(pendingSaveMocks.clearPendingTestSave).not.toHaveBeenCalled();
    expect(screen.queryByText(/does not match/)).toBeNull();
  });

  it("copies the game name and SHA-1 from the player header", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", navigatorWith({ clipboard: { writeText } }));
    Object.defineProperty(document, "hasFocus", { configurable: true, value: vi.fn(() => true) });
    addEntry(entry({ checksum: "A".repeat(40), fileName: "hello-world.nes" }));

    render(withSettings(<EmulatorTestView />));

    fireEvent.click(screen.getByRole("button", { name: "Copy NAME hello-world.nes" }));
    fireEvent.click(screen.getByRole("button", { name: `Copy SHA-1 ${"A".repeat(40)}` }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenNthCalledWith(1, "hello-world.nes");
    expect(writeText).toHaveBeenNthCalledWith(2, "A".repeat(40));
  });

  it("creates a fresh ROM URL when the save editor restarts a game", async () => {
    const { createObjectUrl, revokeObjectUrl } = stubObjectUrls();
    createObjectUrl.mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    addEntry(entry());

    render(withSettings(<EmulatorTestView />));
    await waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));
    act(() => restartCurrentGameWithSave("game"));

    await waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(2));
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:first");
    expect(screen.getByText("Waiting for EmulatorJS to load the save bytes.")).toBeTruthy();
  });

  it("cancels a sample fetch when the guide exits", async () => {
    stubObjectUrls();
    stubReducedMotion();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    let finishFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finishFetch = resolve;
          }),
      ),
    );

    render(withSettings(<EmulatorTestView />));
    fireEvent.click(screen.getByRole("button", { name: /Play a practice ROM/ }));
    fireEvent.click(screen.getByRole("link", { name: "Start a practice run" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave the guide" }));
    fireEvent.change(screen.getByLabelText(/Drop or click to add a ROM or archive/), {
      target: { files: [new File(["local"], "local.nes")] },
    });

    await waitFor(() => expect(getEmulatorSessionState().entries[0]?.fileName).toBe("local.nes"));
    await act(async () =>
      finishFetch?.({
        blob: () => Promise.resolve(new Blob(["sample"])),
        ok: true,
        status: 200,
      } as Response),
    );
    expect(loadRomMock).toHaveBeenCalledOnce();
    expect(getEmulatorSessionState().entries[0]?.fileName).toBe("local.nes");
  });

  it("starts the homebrew guide from the Test guide URL", async () => {
    window.history.replaceState(null, "", "/test-rom?guide=test");
    stubObjectUrls();
    stubReducedMotion();
    stubUserActivation(false);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        blob: () => Promise.resolve(new Blob(["sample"])),
        ok: true,
        status: 200,
      } as Response),
    );

    render(withSettings(<EmulatorTestView />));

    await waitFor(() => expect(getEmulatorSessionState().entries[0]?.fileName).toBe("hello-world.nes"));
    expect(emulatorAudioMocks.prepareEmulatorAudioContext).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("dialog", { name: "A game is loaded" })).toBeTruthy());
  });

  it("shows an actionable error and restores the hero for an unsupported file", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    loadRomMock.mockResolvedValue({ blob: new Blob(["disc"]), checksum: "b".repeat(40), fileName: "game.iso" });

    render(withSettings(<EmulatorTestView />));
    fireEvent.change(screen.getByLabelText(/Drop or click to add a ROM or archive/), {
      target: { files: [new File(["disc"], "game.iso")] },
    });

    expect((await screen.findByRole("alert")).textContent).toContain("Cannot play game.iso.");
    expect(screen.getByRole("heading", { level: 1, name: "Test your ROM online." })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Play" })).toBeNull();
  });

  it("rejects an empty ROM with a clear message instead of booting it", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    loadRomMock.mockResolvedValue({
      blob: new Blob([]),
      checksum: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
      fileName: "empty.nes",
    });

    render(withSettings(<EmulatorTestView />));
    fireEvent.change(screen.getByLabelText(/Drop or click to add a ROM or archive/), {
      target: { files: [new File([], "empty.nes")] },
    });

    const alert = (await screen.findByRole("alert")).textContent;
    expect(alert).toContain("Cannot play empty.nes.");
    expect(alert).toContain("empty (0 bytes)");
    expect(getEmulatorSessionState().entries).toHaveLength(0);
  });

  it("unloads the previous game when the replacement file is unsupported", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    loadRomMock.mockResolvedValue({ blob: new Blob(["disc"]), checksum: "b".repeat(40), fileName: "game.iso" });
    addEntry(entry());

    const { container } = render(withSettings(<EmulatorTestView />));
    expect(getEmulatorSessionState().currentGameId).toBe("game");
    fireEvent.change(container.querySelector("input[type=file]") as HTMLInputElement, {
      target: { files: [new File(["disc"], "game.iso")] },
    });

    expect((await screen.findByRole("alert")).textContent).toContain("Cannot play game.iso.");
    expect(getEmulatorSessionState().currentGameId).toBeNull();
    expect(screen.queryByTitle("EmulatorJS test for game.nes")).toBeNull();
  });

  it("uses the detected platform to load a PSP disc image", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    loadRomMock.mockResolvedValue({
      blob: new Blob(["disc"]),
      checksum: "b".repeat(40),
      fileName: "game.iso",
      platform: "Sony Playstation Portable",
    });

    render(withSettings(<EmulatorTestView />));
    fireEvent.change(screen.getByLabelText(/Drop or click to add a ROM or archive/), {
      target: { files: [new File(["disc"], "game.iso")] },
    });

    await waitFor(() => expect(getEmulatorSessionState().entries[0]?.core).toBe("psp"));
    expect(getEmulatorSessionState().entries[0]?.platform).toBe("Sony Playstation Portable");
  });

  it("does not start the core for an FDS image and links the BIOS issue", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    loadRomMock.mockResolvedValue({
      blob: new Blob(["disk"]),
      checksum: "b".repeat(40),
      fileName: "game.fds",
      platform: "Nintendo Famicom Disk System",
    });

    render(withSettings(<EmulatorTestView />));
    fireEvent.change(screen.getByLabelText(/Drop or click to add a ROM or archive/), {
      target: { files: [new File(["disk"], "game.fds.zip")] },
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("game.fds needs the Famicom Disk System BIOS.");
    expect(alert.querySelector("a")?.getAttribute("href")).toBe("https://github.com/rom-weaver/rom-weaver/issues/1223");
    expect(screen.queryByTitle("EmulatorJS test for game.fds")).toBeNull();
  });

  it("does not start the core for a retained FDS session entry", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    addEntry(entry({ fileName: "patched.fds", id: "fds", platform: "Nintendo Famicom Disk System" }));

    render(withSettings(<EmulatorTestView />));

    expect((await screen.findByRole("alert")).textContent).toContain("patched.fds needs the Famicom Disk System BIOS.");
    expect(screen.queryByTitle("EmulatorJS test for patched.fds")).toBeNull();
  });

  it("does not start the core for a headerless FDS image under a renamed output", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    const disk = new Uint8Array(64);
    disk.set([1, ...new TextEncoder().encode("*NINTENDO-HVC*")]);
    addEntry(entry({ blob: new Blob([disk]), fileName: "Zelda v1.1", id: "renamed-fds" }));

    render(withSettings(<EmulatorTestView />));

    expect((await screen.findByRole("alert")).textContent).toContain("Zelda v1.1 needs the Famicom Disk System BIOS.");
    expect(screen.queryByTitle("EmulatorJS test for Zelda v1.1")).toBeNull();
  });

  it("shows the BIOS notice next to a save mismatch error", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    pendingSaveMocks.readPendingTestSave.mockResolvedValue({
      bytes: new Uint8Array([1]),
      fileName: "other.sav",
      platform: "gba",
    });
    loadRomMock.mockResolvedValue({
      blob: new Blob(["disk"]),
      checksum: "b".repeat(40),
      fileName: "game.fds",
      platform: "Nintendo Famicom Disk System",
    });

    render(withSettings(<EmulatorTestView />));
    fireEvent.change(screen.getByLabelText(/Drop or click to add a ROM or archive/), {
      target: { files: [new File(["disk"], "game.fds.zip")] },
    });

    const alerts = await screen.findAllByRole("alert");
    const text = alerts.map((alert) => alert.textContent).join(" ");
    expect(text).toContain("game.fds does not match other.sav.");
    expect(text).toContain("game.fds needs the Famicom Disk System BIOS.");
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
    let finishLoad: ((value: { blob: Blob; checksum: string; fileName: string }) => void) | undefined;
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
        return new Promise<{ blob: Blob; checksum: string; fileName: string }>((resolve) => {
          finishLoad = resolve;
        });
      },
    );

    render(withSettings(<EmulatorTestView />));
    fireEvent.change(screen.getByLabelText(/Drop or click to add a ROM or archive/), {
      target: { files: [new File(["archive"], "games.zip")] },
    });

    expect(await screen.findByText("Extracting games.zip...")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    await act(async () => finishLoad?.({ blob: new Blob(["game"]), checksum: "b".repeat(40), fileName: "game.nes" }));
    expect(await screen.findByTitle("EmulatorJS test for game.nes")).toBeTruthy();
    expect(emulatorAudioMocks.prepareEmulatorAudioContext).toHaveBeenCalledWith("b".repeat(40));
  });

  it("ignores a replacement that finishes after Stop is pressed", async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    let finishLoad: ((value: { blob: Blob; checksum: string; fileName: string }) => void) | undefined;
    loadRomMock.mockImplementation(
      async () =>
        new Promise<{ blob: Blob; checksum: string; fileName: string }>((resolve) => {
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
    await act(async () =>
      finishLoad?.({ blob: new Blob(["replacement"]), checksum: "b".repeat(40), fileName: "replacement.nes" }),
    );

    expect(getEmulatorSessionState()).toEqual({ currentGameId: null, entries: [] });
    expect(screen.getByRole("heading", { level: 1, name: "Test your ROM online." })).toBeTruthy();
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
    expect(screen.getByRole("heading", { level: 1, name: "Test your ROM online." })).toBeTruthy();
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
        checksum: undefined,
      }),
    );
    emulatorAudioMocks.disposeEmulatorAudioContext.mockClear();

    render(withSettings(<EmulatorTestView />));

    await waitFor(() => expect(screen.getByTitle("EmulatorJS test for game.nes")).toBeTruthy());
    expect(emulatorAudioMocks.disposeEmulatorAudioContext).not.toHaveBeenCalled();
  });
});

describe("fallback fullscreen game validation", () => {
  const openFullscreenGame = async () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    addEntry(entry());
    const view = render(withSettings(<EmulatorTestView />));
    await screen.findByTitle("EmulatorJS test for game.nes");
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(document.querySelector("dialog")?.open).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    return view;
  };

  it("keeps a validated replacement visible in fallback fullscreen and restores scrolling on stop", async () => {
    const previousOverflow = document.body.style.overflow;
    const view = await openFullscreenGame();
    const oldFrame = screen.getByTitle("EmulatorJS test for game.nes");
    view.rerender(withSettings(<EmulatorTestView pageDrop={{ id: 1, files: [new File(["second"], "second.nes")] }} />));
    const replacement = await screen.findByTitle("EmulatorJS test for second.nes");
    await waitFor(() => expect(document.querySelector("dialog")?.open).toBe(true));
    expect(oldFrame.isConnected).toBe(false);
    expect(replacement.closest("dialog")?.open).toBe(true);
    expect(replacement.closest(".is-pseudo-fullscreen")).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Stop and unload game" }));
    await waitFor(() => expect(document.querySelector("iframe")).toBeNull());
    expect(document.querySelector(".is-pseudo-fullscreen")).toBeNull();
    expect(document.body.style.overflow).toBe(previousOverflow);
  });

  it("leaves fullscreen and unlocks scrolling when a renamed replacement requires the FDS BIOS", async () => {
    const previousOverflow = document.body.style.overflow;
    const view = await openFullscreenGame();
    const disk = new Uint8Array(64);
    disk.set([1, ...new TextEncoder().encode("*NINTENDO-HVC*")]);
    view.rerender(withSettings(<EmulatorTestView pageDrop={{ id: 1, files: [new File([disk], "renamed.nes")] }} />));
    expect((await screen.findByRole("alert")).textContent).toContain("renamed.nes needs the Famicom Disk System BIOS.");
    await waitFor(() => expect(document.body.style.overflow).toBe(previousOverflow));
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(document.querySelector(".is-pseudo-fullscreen")).toBeNull();
  });

  it("keeps exit and dialog-close controls working after replacement, and unlocks on unmount", async () => {
    const previousOverflow = document.body.style.overflow;
    const view = await openFullscreenGame();
    view.rerender(withSettings(<EmulatorTestView pageDrop={{ id: 1, files: [new File(["second"], "second.nes")] }} />));
    await screen.findByTitle("EmulatorJS test for second.nes");
    await waitFor(() => expect(document.querySelector("dialog")?.open).toBe(true));
    const exit = document.querySelector<HTMLButtonElement>(".emulator-pseudo-exit");
    expect(exit).toBeTruthy();
    fireEvent.click(exit as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector("dialog")?.open).toBe(false));
    expect(document.body.style.overflow).toBe(previousOverflow);
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(document.querySelector("dialog")?.open).toBe(true);
    act(() => document.querySelector("dialog")?.close());
    await waitFor(() => expect(document.querySelector(".is-pseudo-fullscreen")).toBeNull());
    expect(document.body.style.overflow).toBe(previousOverflow);
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(document.body.style.overflow).toBe("hidden");
    view.unmount();
    expect(document.body.style.overflow).toBe(previousOverflow);
  });
});
