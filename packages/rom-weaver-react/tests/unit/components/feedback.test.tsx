// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FileProgress,
  InlineProgress,
  Notice,
  ProgressTrack,
  RunButton,
} from "../../../src/public/react/components/ds/feedback.tsx";

/**
 * Feedback primitive contract: weave meter classes (.meter.track / .fill.bar
 * are read by the staging browser tests), the recessed progress panels with
 * their cancel control, notice roles, and the run/download button structure.
 */

describe("ProgressTrack", () => {
  it("renders a determinate fill scale", () => {
    const { container } = render(<ProgressTrack percent={42} />);
    const meter = container.querySelector(".meter.track");
    expect(meter?.classList.contains("indet")).toBe(false);
    expect((container.querySelector(".fill.bar") as HTMLElement).style.getPropertyValue("--scale")).toBe("0.42");
  });

  it("falls back to indeterminate without a usable percent", () => {
    const { container } = render(<ProgressTrack percent={null} />);
    expect(container.querySelector(".meter.indet")).toBeTruthy();
  });
});

describe("FileProgress", () => {
  it("renders the recessed panel with label, meter, readout, and cancel", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <FileProgress cancelLabel="Cancel patch staging" id="prog-1" label="Reading p.ips" onCancel={onCancel} value="12%" />,
    );
    const panel = container.querySelector(".prog-panel.fileprog");
    expect(panel?.id).toBe("prog-1");
    expect(panel?.querySelector(".prog .lab .what")?.textContent).toBe("Reading p.ips");
    expect(panel?.querySelector(".sub .run-pct")?.textContent).toBe("12%");
    const cancel = panel?.querySelector(".prog-actions .cancel") as HTMLButtonElement;
    expect(cancel.getAttribute("aria-label")).toBe("Cancel patch staging");
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("InlineProgress", () => {
  it("uses the borderless run panel when cancellable", () => {
    const { container } = render(<InlineProgress label="Applying" onCancel={() => undefined} percent={10} />);
    expect(container.querySelector(".prog-panel.runprog")).toBeTruthy();
  });
});

describe("Notice", () => {
  it("renders warn as status and error as alert, with a dismiss control", () => {
    const onDismiss = vi.fn();
    const { container, rerender } = render(
      <Notice level="warn" onDismiss={onDismiss}>
        heads up
      </Notice>,
    );
    const warn = container.querySelector(".notice.warn");
    expect(warn?.getAttribute("role")).toBe("status");
    fireEvent.click(warn?.querySelector(".notice-x") as HTMLButtonElement);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(<Notice level="error">broken</Notice>);
    expect(container.querySelector(".notice.error")?.getAttribute("role")).toBe("alert");
  });
});

describe("RunButton", () => {
  it("renders the primary run action", () => {
    const { container } = render(<RunButton id="run-1">APPLY &amp; DOWNLOAD</RunButton>);
    const button = container.querySelector("button.btn.primary.run");
    expect(button?.id).toBe("run-1");
    expect(button?.classList.contains("download-btn")).toBe(false);
  });

  it("renders the download summary variant", () => {
    const { container } = render(
      <RunButton download={{ format: "Patched", name: "game.zip", size: "10.2 KB" }} id="run-1" />,
    );
    const button = container.querySelector("button.download-btn.dl");
    expect(button).toBeTruthy();
    expect(button?.querySelector(".dl-kind")?.textContent).toBe("Patched");
    expect(button?.querySelector(".dl-name")?.textContent).toBe("game.zip");
    expect(button?.querySelector(".dl-size")?.textContent).toContain("10.2 KB");
  });
});
