// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SampleTutorial, type SampleTutorialStep } from "../../src/public/react/components/ds/sample-tutorial.tsx";

const STEPS: readonly SampleTutorialStep[] = [
  { body: "Review the first section.", target: "#tutorial-first", title: "First section" },
  { body: "Review the second section.", target: "#tutorial-second", title: "Second section" },
];

describe("sample tutorial", () => {
  it("highlights live sections while progression stays in the guide", async () => {
    const onClose = vi.fn();
    render(
      <div className="rw-app">
        <section id="tutorial-first">First</section>
        <section id="tutorial-second">Second</section>
        <SampleTutorial loadingBody="Loading." onClose={onClose} ready steps={STEPS} />
      </div>,
    );

    const first = document.querySelector("#tutorial-first") as HTMLElement;
    await waitFor(() => expect(first.classList.contains("sample-tutorial-target")).toBe(true));
    fireEvent.click(first);
    expect(screen.getByRole("heading", { name: "First section" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const second = document.querySelector("#tutorial-second") as HTMLElement;
    await waitFor(() => expect(second.classList.contains("sample-tutorial-target")).toBe(true));
    expect(first.classList.contains("sample-tutorial-target")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
