// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmulatorJsTest } from "../../../src/public/react/components/emulatorjs-test.tsx";

vi.mock("../../../src/public/react/components/ds/modal.tsx", () => ({
  Modal: ({
    onClose,
    open,
    subtitle,
    title,
  }: {
    onClose: () => void;
    open: boolean;
    subtitle?: string;
    title?: string;
  }) =>
    open ? (
      <div role="dialog">
        <span>{title}</span>
        <span>{subtitle}</span>
        <button onClick={onClose} type="button">
          Close
        </button>
      </div>
    ) : null,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EmulatorJsTest", () => {
  it("opens the applied ROM in a modal over the page", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGL2RenderingContext);
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:applied-rom");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const appliedRom = new Blob(["rom"]);

    render(
      <div className="rw-app">
        <EmulatorJsTest core="nes" output={{ fileName: "modified-world.nes", getBlob: async () => appliedRom }} />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test in EmulatorJS" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("modified-world.nes")).toBeTruthy();
    expect(createObjectUrl).toHaveBeenCalledWith(appliedRom);

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:applied-rom");
  });
});
