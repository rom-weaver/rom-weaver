// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmulatorTestView } from "../../../src/public/react/emulator-test-view.tsx";
import {
  addEntry,
  disposeEntry,
  getEmulatorSessionState,
  setCurrentGame,
  type EmulatorSessionEntry,
} from "../../../src/public/react/emulator-session-store.ts";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";

vi.mock("../../../src/public/react/components/emulator-document.ts", () => ({
  createEmulatorDocument: () => "<!doctype html><html><body></body></html>",
  createEmulatorGameIdentity: ({ fileName }: { fileName: string }) => ({
    gameId: 1,
    gameLabel: fileName,
    gameName: `rom-weaver-${fileName}`,
  }),
}));

const NativeURL = URL;

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const entry = (overrides: Partial<EmulatorSessionEntry> = {}): EmulatorSessionEntry => ({
  core: "nes",
  fileName: "game.nes",
  id: "game",
  objectUrl: "blob:game",
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
    expect(screen.getByText("Session outputs")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Session outputs" })).toBeNull();
  });

  it("disables an output when no EmulatorJS core supports it", () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    addEntry(entry({ core: undefined, fileName: "game.iso", id: "unsupported" }));

    render(withSettings(<EmulatorTestView />));

    expect(screen.getByRole("button", { name: "Play" }).getAttribute("disabled")).not.toBeNull();
    expect(screen.getByText("No emulator core for this system")).toBeTruthy();
  });

  it("changes the current game when Play is pressed", () => {
    stubObjectUrls();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    addEntry(entry());
    addEntry(entry({ core: "snes", fileName: "second.sfc", id: "second", objectUrl: "blob:second" }));
    setCurrentGame("game");

    render(withSettings(<EmulatorTestView />));

    fireEvent.click(screen.getAllByRole("button", { name: "Play" })[1]);

    expect(getEmulatorSessionState().currentGameId).toBe("second");
    expect(screen.getByTitle("EmulatorJS test for second.sfc")).toBeTruthy();
  });
});
