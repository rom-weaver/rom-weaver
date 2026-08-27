// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PpfUndoForm } from "../../../src/webapp/components/ppf-undo-form.tsx";

vi.mock("../../../src/platform/browser/browser-api.ts", () => ({ undoPpf: vi.fn() }));

describe("PpfUndoForm", () => {
  it("stages the PPF undo inputs and derives a restored ROM name", () => {
    const onSessionChange = vi.fn();
    render(<PpfUndoForm onSessionChange={onSessionChange} />);

    // The empty form shows only ghost steps; the workflow steps appear on staging.
    expect(screen.queryByRole("button", { name: "Restore original ROM" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Drop a patched ROM and PPF patch"), {
      target: { files: [new File(["patched"], "game.sfc"), new File(["patch"], "game.ppf")] },
    });

    const run = screen.getByRole("button", { name: "Restore original ROM" });
    expect(screen.getByText("game.sfc")).toBeTruthy();
    expect(screen.getByText("game.ppf")).toBeTruthy();
    expect((screen.getByLabelText("Output filename") as HTMLTextAreaElement).value).toBe("game-restored.sfc");
    expect((run as HTMLButtonElement).disabled).toBe(false);
    expect(onSessionChange).toHaveBeenLastCalledWith(true);
  });
});
