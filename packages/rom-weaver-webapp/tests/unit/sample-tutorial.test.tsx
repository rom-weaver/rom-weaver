// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SampleTutorial, type SampleTutorialStep } from "../../src/public/react/components/ds/sample-tutorial.tsx";

const STEPS: readonly SampleTutorialStep[] = [
  { body: "Open the first control.", target: "#tutorial-first", title: "First move" },
  { body: "The first control is open.", title: "First result" },
  { body: "Open the second control.", target: "#tutorial-second", title: "Second move" },
  { body: "The tutorial is complete.", title: "Finished" },
];

describe("sample tutorial", () => {
  it("advances from real target clicks through dialog prompts", async () => {
    const onClose = vi.fn();
    render(
      <div className="rw-app">
        <button id="tutorial-first" type="button">
          First
        </button>
        <button id="tutorial-second" type="button">
          Second
        </button>
        <SampleTutorial loadingBody="Loading." onClose={onClose} ready steps={STEPS} />
      </div>,
    );

    const first = screen.getByRole("button", { name: "First" });
    await waitFor(() => expect(first.classList.contains("sample-tutorial-target")).toBe(true));
    fireEvent.click(first);

    expect(screen.getByRole("heading", { name: "First result" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const second = screen.getByRole("button", { name: "Second" });
    await waitFor(() => expect(second.classList.contains("sample-tutorial-target")).toBe(true));
    fireEvent.click(second);

    fireEvent.click(screen.getByRole("button", { name: "Finish tutorial" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
