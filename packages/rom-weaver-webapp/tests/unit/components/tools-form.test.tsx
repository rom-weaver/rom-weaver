// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolsForm } from "../../../src/webapp/components/tools-form.tsx";

vi.mock("../../../src/platform/browser/browser-api.ts", () => ({ undoPpf: vi.fn() }));

describe("ToolsForm", () => {
  it("stages the PPF undo inputs and derives a restored ROM name", () => {
    const onSessionChange = vi.fn();
    render(<ToolsForm onSessionChange={onSessionChange} />);

    expect(screen.getByRole("tab", { name: "PPF undo" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Identify" }).getAttribute("aria-selected")).toBe("false");
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

    fireEvent.click(screen.getByRole("tab", { name: "Identify" }));
    expect(screen.getByRole("tab", { name: "Identify" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Identify" })).toBeTruthy();
  });

  it("does not stage page drops in PPF undo while Identify is active", () => {
    const onSessionChange = vi.fn();
    const { container, rerender } = render(<ToolsForm onSessionChange={onSessionChange} />);

    fireEvent.click(screen.getByRole("tab", { name: "Identify" }));
    rerender(
      <ToolsForm
        onSessionChange={onSessionChange}
        pageDrop={{
          files: [new File(["rom"], "game.sfc"), new File(["patch"], "game.ppf")],
          id: 1,
        }}
      />,
    );

    expect(container.querySelector("#panel-tools-ppf-undo")?.textContent).not.toContain("game.sfc");
    expect(container.querySelector("#panel-tools-ppf-undo")?.textContent).not.toContain("game.ppf");
  });
});
