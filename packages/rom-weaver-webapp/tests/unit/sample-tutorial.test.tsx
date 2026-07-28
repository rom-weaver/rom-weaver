// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SampleTutorial, type SampleTutorialStep } from "../../src/public/react/components/ds/sample-tutorial.tsx";

const STEPS: readonly SampleTutorialStep[] = [
  {
    actions: [["checks", "Checks"]],
    body: "Review the first section.",
    openDrawers: true,
    openMenu: true,
    target: "#tutorial-first",
    title: "First section",
  },
  { body: "Review the second section.", openDrawers: true, target: "#tutorial-second", title: "Second section" },
];

const TutorialSection = ({ id, label }: { id: string; label: string }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <section id={id}>
      <div className={open ? "cks is-open" : "cks"}>
        <button aria-expanded={open} className="cks-head" onClick={() => setOpen((current) => !current)} type="button">
          {label}
        </button>
      </div>
      <button
        aria-expanded={menuOpen}
        className="patch-menu-btn"
        onClick={() => setMenuOpen((current) => !current)}
        type="button"
      >
        Actions
      </button>
    </section>
  );
};

// The app commits .rw-app long before the guide mounts, and ending the guide
// unmounts only the guide. Both matter here: the portal container is resolved
// on the guide's first render, and the drawer restore runs on its teardown.
const renderGuidedWorkbench = ({ onClose = vi.fn() }: { onClose?: () => void } = {}) => {
  const workbench = (guided: boolean) => (
    <div className="rw-app">
      <TutorialSection id="tutorial-first" label="First drawer" />
      <TutorialSection id="tutorial-second" label="Second drawer" />
      {guided ? <SampleTutorial loadingBody="Loading." onClose={onClose} ready steps={STEPS} /> : null}
    </div>
  );
  const { rerender } = render(workbench(false));
  rerender(workbench(true));
  return { endGuide: () => rerender(workbench(false)) };
};

const stubRect = (element: HTMLElement, box: { height: number; left: number; top: number; width: number }) => {
  element.getBoundingClientRect = () =>
    ({
      bottom: box.top + box.height,
      height: box.height,
      left: box.left,
      right: box.left + box.width,
      top: box.top,
      width: box.width,
      x: box.left,
      y: box.top,
    }) as DOMRect;
};

// happy-dom reports zero-sized rects, so the geometry has to be stubbed after
// mount and a resize fired to re-measure. Viewport is 1024x768.
const renderAnchored = async (row: { height: number; left: number; top: number; width: number }) => {
  renderGuidedWorkbench();
  const target = document.querySelector("#tutorial-first") as HTMLElement;
  const guide = document.querySelector(".sample-tutorial-dialog") as HTMLElement;
  await waitFor(() => expect(target.classList.contains("sample-tutorial-target")).toBe(true));
  stubRect(target, row);
  stubRect(guide, { height: 200, left: 0, top: 0, width: 720 });
  fireEvent.resize(window);
  return guide;
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
    expect(first.querySelector(".patch-menu-btn")?.getAttribute("aria-expanded")).toBe("true");
    const actions = screen.getByRole("list", { name: "Available actions" });
    expect(actions.textContent).toContain("Checks");
    expect(actions.querySelector("svg")).toBeTruthy();
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

  it("keeps one live region across steps so the change is announced", async () => {
    renderGuidedWorkbench();

    const region = document.querySelector("[aria-live]");
    expect(region?.textContent).toContain("First section");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    // Same node, new content - a region inserted alongside its content never announces.
    expect(document.querySelector("[aria-live]")).toBe(region);
    expect(region?.textContent).toContain("Second section");
  });

  it("moves focus into the guide so it is reachable once the trigger unmounts", () => {
    renderGuidedWorkbench();

    expect(document.activeElement).toBe(document.querySelector(".sample-tutorial-dialog"));
  });

  it("leaves Escape to the controls that own it and closes only from inside the guide", async () => {
    const onClose = vi.fn();
    renderGuidedWorkbench({ onClose });

    const menu = document.querySelector("#tutorial-first .patch-menu-btn") as HTMLButtonElement;
    await waitFor(() => expect(menu.getAttribute("aria-expanded")).toBe("true"));
    menu.focus();
    fireEvent.keyDown(menu, { bubbles: true, key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    const guide = document.querySelector(".sample-tutorial-dialog") as HTMLElement;
    guide.focus();
    fireEvent.keyDown(guide, { bubbles: true, key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("anchors the card under its row on desktop", async () => {
    const guide = await renderAnchored({ height: 100, left: 200, top: 200, width: 600 });

    // Row bottom (300) + the 14px gap; centred on the row: 200 + 600/2 - 720/2.
    await waitFor(() => expect(guide.style.top).toBe("314px"));
    expect(guide.style.left).toBe("140px");
    expect(guide.dataset.anchored).toBe("true");
  });

  it("flips above the row when there is no room below", async () => {
    // Row bottom 700 + 14 + 200 overflows the 768px viewport, so it sits above.
    const guide = await renderAnchored({ height: 100, left: 200, top: 600, width: 600 });

    await waitFor(() => expect(guide.style.top).toBe("386px"));
  });

  it("marks the button the final step asks for and clears it on close", async () => {
    const ctaSteps: readonly SampleTutorialStep[] = [
      { body: "Press it.", cta: ".btn.run", target: "#tutorial-cta", title: "Finish" },
    ];
    const workbench = (guided: boolean) => (
      <div className="rw-app">
        <section id="tutorial-cta">
          <button className="btn run" type="button">
            Weave
          </button>
        </section>
        {guided ? <SampleTutorial loadingBody="Loading." onClose={vi.fn()} ready steps={ctaSteps} /> : null}
      </div>
    );
    const { rerender } = render(workbench(false));
    rerender(workbench(true));

    const button = screen.getByRole("button", { name: "Weave" });
    await waitFor(() => expect(button.dataset.guideCta).toBe("true"));
    rerender(workbench(false));
    expect(button.dataset.guideCta).toBeUndefined();
  });

  it("re-closes the drawers it opened when the guide ends", async () => {
    const { endGuide } = renderGuidedWorkbench();

    const drawer = screen.getByRole("button", { name: "First drawer" });
    await waitFor(() => expect(drawer.getAttribute("aria-expanded")).toBe("true"));
    endGuide();
    expect(drawer.getAttribute("aria-expanded")).toBe("false");
  });
});
