// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProgressActionButton } from "../../../src/presentation/react/progress-action-button.tsx";
import { createProgressViewModel } from "../../../src/presentation/workflow-presentation.ts";

/**
 * Accessibility contract for the run/progress button: the live meter must be an
 * announced progressbar (not aria-hidden), and replacing the run <button> with the
 * progress panel must not strand keyboard focus on <body>.
 */

describe("ProgressActionButton meter accessibility", () => {
  it("exposes the running meter as a determinate progressbar", () => {
    const progress = createProgressViewModel({ label: "Compressing", percent: 42, threads: 4 });
    const { container } = render(
      <ProgressActionButton disabled={false} label="Run" onClick={() => undefined} progress={progress} />,
    );
    const meter = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(meter).toBeTruthy();
    expect(meter.getAttribute("aria-hidden")).toBeNull();
    expect(meter.getAttribute("aria-valuemin")).toBe("0");
    expect(meter.getAttribute("aria-valuemax")).toBe("100");
    expect(meter.getAttribute("aria-valuenow")).toBe("42");
    expect(meter.getAttribute("aria-live")).toBe("polite");
  });

  it("omits the numeric value while indeterminate", () => {
    const progress = createProgressViewModel({ label: "Working" });
    const { container } = render(
      <ProgressActionButton disabled={false} label="Run" onClick={() => undefined} progress={progress} />,
    );
    const meter = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(meter.classList.contains("indet")).toBe(true);
    expect(meter.getAttribute("aria-valuenow")).toBeNull();
    expect(meter.getAttribute("aria-valuemin")).toBeNull();
  });
});

describe("ProgressActionButton focus management", () => {
  it("moves focus to cancel while running and restores it to the run button when done", () => {
    const onCancel = vi.fn();
    const props = { disabled: false, label: "Run", onCancel, onClick: () => undefined } as const;
    const { container, rerender } = render(<ProgressActionButton {...props} progress={null} />);

    const runButton = container.querySelector("button.btn.primary.run") as HTMLButtonElement;
    runButton.focus();
    expect(document.activeElement).toBe(runButton);

    const progress = createProgressViewModel({ label: "Working", percent: 10 });
    rerender(<ProgressActionButton {...props} progress={progress} />);
    const cancel = container.querySelector(".progress-cancel") as HTMLButtonElement;
    expect(document.activeElement).toBe(cancel);

    rerender(<ProgressActionButton {...props} progress={null} />);
    expect(document.activeElement).toBe(container.querySelector("button.btn.primary.run"));
  });

  it("does not steal focus when it has moved elsewhere during a run", () => {
    const onCancel = vi.fn();
    const props = { disabled: false, label: "Run", onCancel, onClick: () => undefined } as const;
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);

    const progress = createProgressViewModel({ label: "Working", percent: 10 });
    const { rerender } = render(<ProgressActionButton {...props} progress={progress} />);

    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    rerender(<ProgressActionButton {...props} progress={null} />);
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
