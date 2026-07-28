// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SampleTutorial, type SampleTutorialStep } from "../../src/public/react/components/ds/sample-tutorial.tsx";

const STEPS: readonly SampleTutorialStep[] = [
  { body: "Review the first section.", openDrawers: true, target: "#tutorial-first", title: "First section" },
  { body: "Review the second section.", openDrawers: true, target: "#tutorial-second", title: "Second section" },
];

const TutorialSection = ({ id, label }: { id: string; label: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <section id={id}>
      <div className={open ? "cks is-open" : "cks"}>
        <button aria-expanded={open} className="cks-head" onClick={() => setOpen((current) => !current)} type="button">
          {label}
        </button>
      </div>
    </section>
  );
};

describe("sample tutorial", () => {
  it("highlights live sections, opens their drawers, and keeps progression in the guide", async () => {
    const onClose = vi.fn();
    render(
      <div className="rw-app">
        <TutorialSection id="tutorial-first" label="First drawer" />
        <TutorialSection id="tutorial-second" label="Second drawer" />
        <SampleTutorial loadingBody="Loading." onClose={onClose} ready steps={STEPS} />
      </div>,
    );

    const first = document.querySelector("#tutorial-first") as HTMLElement;
    await waitFor(() => expect(first.classList.contains("sample-tutorial-target")).toBe(true));
    expect(screen.getByRole("button", { name: "First drawer" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(first);
    expect(screen.getByRole("heading", { name: "First section" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const second = document.querySelector("#tutorial-second") as HTMLElement;
    await waitFor(() => expect(second.classList.contains("sample-tutorial-target")).toBe(true));
    expect(screen.getByRole("button", { name: "Second drawer" }).getAttribute("aria-expanded")).toBe("true");
    expect(first.classList.contains("sample-tutorial-target")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
