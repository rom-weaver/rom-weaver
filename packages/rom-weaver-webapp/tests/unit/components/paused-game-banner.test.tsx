// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addEntry,
  disposeEntry,
  getEmulatorSessionState,
  type EmulatorSessionEntry,
} from "../../../src/public/react/emulator-session-store.ts";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { PausedGameBanner } from "../../../src/webapp/components/paused-game-banner.tsx";

const WARNING = "Starting another action closes it to free memory. Progress since its last in-game save is lost.";

const entry = (overrides: Partial<EmulatorSessionEntry> = {}): EmulatorSessionEntry => ({
  blob: new Blob(["disc"]),
  fileName: "disc.chd",
  id: "disc",
  sizeBytes: 464 * 1024 * 1024,
  source: "local",
  ...overrides,
});

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

afterEach(() => {
  while (getEmulatorSessionState().entries.length) disposeEntry(getEmulatorSessionState().entries[0].id);
});

describe("PausedGameBanner", () => {
  it("warns outside Test that a paused disc-sized game closes when another action starts", () => {
    const onOpenTest = vi.fn();
    addEntry(entry());
    render(withSettings(<PausedGameBanner active onOpenTest={onOpenTest} />));

    expect(screen.getByRole("status").textContent).toBe(`disc.chd is paused in Test. ${WARNING}Back to Test`);
    fireEvent.click(screen.getByRole("button", { name: "Back to Test" }));
    expect(onOpenTest).toHaveBeenCalledOnce();
  });

  it("stays hidden in Test, for a cartridge-sized game, and once dismissed for that game", () => {
    addEntry(entry());
    const { rerender } = render(withSettings(<PausedGameBanner active={false} onOpenTest={() => undefined} />));
    expect(screen.queryByRole("status")).toBeNull();

    rerender(withSettings(<PausedGameBanner active onOpenTest={() => undefined} />));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();

    act(() => addEntry(entry({ fileName: "next.chd", id: "next" })));
    expect(screen.getByRole("status").textContent).toContain("next.chd is paused in Test.");

    act(() => addEntry(entry({ fileName: "cartridge.gba", id: "cartridge", sizeBytes: 32 * 1024 * 1024 })));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
