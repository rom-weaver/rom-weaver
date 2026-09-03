// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, Modal } from "../../../src/public/react/components/ds/modal.tsx";

afterEach(() => vi.restoreAllMocks());

describe("Modal", () => {
  it("keeps an open modal focused, traps Tab, and restores the page on close", () => {
    const onClose = vi.fn();
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    const { rerender } = render(
      <div className="rw-app">
        <button id="outside" type="button">
          Outside
        </button>
        <Modal
          headerActions={<button type="button">Action</button>}
          onClose={onClose}
          open
          subtitle="More detail"
          title="Settings"
        >
          <button id="first" type="button">
            First
          </button>
          <button id="last" type="button">
            Last
          </button>
        </Modal>
      </div>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Settings");
    expect(dialog.textContent).toContain("More detail");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(frame).toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(document.querySelector(".dlg-x") as HTMLButtonElement);
    fireEvent.click(document.querySelector(".rw-modal-backdrop") as HTMLButtonElement);
    expect(onClose).toHaveBeenCalledTimes(3);

    fireEvent.focusIn(document.querySelector("#outside") as HTMLButtonElement);
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement?.textContent).toBe("Action");
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement?.id).toBe("last");
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement?.textContent).toBe("Action");
    const activeElement = Object.getOwnPropertyDescriptor(document, "activeElement");
    const firstFocusable = document.querySelector(".modal-head button") as HTMLButtonElement;
    const focus = vi.spyOn(firstFocusable, "focus");
    Object.defineProperty(document, "activeElement", { configurable: true, value: document.querySelector("#outside") });
    try {
      fireEvent.keyDown(document, { key: "Tab" });
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      if (activeElement) Object.defineProperty(document, "activeElement", activeElement);
      else delete (document as Document & { activeElement?: Element }).activeElement;
    }

    rerender(
      <div className="rw-app">
        <button id="outside" type="button">
          Outside
        </button>
        <Modal onClose={onClose} open={false} title="Settings">
          Closed
        </Modal>
      </div>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("handles no focusable body content and renders confirmation actions", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <div className="rw-app">
        <Modal onClose={onClose} open title={undefined}>
          Read only
        </Modal>
      </div>,
    );
    const dialog = screen.getByRole("dialog");
    const tab = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);

    rerender(
      <div className="rw-app">
        <ConfirmDialog
          body="This cannot be undone."
          cancelLabel="No"
          confirmLabel="Yes"
          danger
          onCancel={onClose}
          onConfirm={onConfirm}
          open
          title="Delete this?"
        />
      </div>,
    );
    expect(screen.getByRole("dialog").textContent).toContain("This cannot be undone.");
    fireEvent.click(screen.getByRole("button", { name: /No/ }));
    fireEvent.click(screen.getByRole("button", { name: /Yes/ }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("falls back to the document body and can hide the close button", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose} open showCloseButton={false} title="Body portal">
        Content
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.querySelector(".dlg-x")).toBeNull();
    fireEvent.click(dialog.querySelector(".rw-modal-backdrop") as HTMLButtonElement);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
