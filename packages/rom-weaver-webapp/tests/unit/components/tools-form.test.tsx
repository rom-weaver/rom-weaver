// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolsForm } from "../../../src/webapp/components/tools-form.tsx";

vi.mock("../../../src/platform/browser/browser-api.ts", () => ({
  identifySave: vi.fn(async () => ({ recognition: { candidates: [], outcome: { unsupported: {} } }, saveSize: 4 })),
  undoPpf: vi.fn(),
}));
vi.mock("../../../src/storage/browser/emulator-saves.ts", () => ({ listEmulatorSaves: vi.fn(async () => []) }));

afterEach(cleanup);

describe("ToolsForm", () => {
  it("stages the PPF undo inputs and derives a restored ROM name", () => {
    const onSessionChange = vi.fn();
    render(<ToolsForm onSessionChange={onSessionChange} />);

    fireEvent.click(screen.getByRole("tab", { name: "PPF undo" }));
    expect(screen.getByRole("tab", { name: "PPF undo" }).getAttribute("aria-selected")).toBe("true");
    const run = screen.getByRole("button", { name: "Restore original ROM" });
    expect((run as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Drop a patched ROM and PPF patch"), {
      target: { files: [new File(["patched"], "game.sfc"), new File(["patch"], "game.ppf")] },
    });

    expect(screen.getByText("game.sfc")).toBeTruthy();
    expect(screen.getByText("game.ppf")).toBeTruthy();
    expect((screen.getByLabelText("Output filename") as HTMLTextAreaElement).value).toBe("game-restored.sfc");
    expect((run as HTMLButtonElement).disabled).toBe(false);
    expect(onSessionChange).toHaveBeenLastCalledWith(true);
  });

  it("routes a page drop to the visible Save Editor", async () => {
    render(<ToolsForm onSessionChange={vi.fn()} pageDrop={{ files: [new File(["save"], "game.sav")], id: 1 }} />);

    await waitFor(() => expect(screen.getByText(/game\.sav/)).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "PPF undo" }));
    expect((screen.getByRole("button", { name: "Restore original ROM" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
