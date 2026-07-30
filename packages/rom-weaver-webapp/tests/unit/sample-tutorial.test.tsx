// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SampleTutorial,
  SampleTutorialStart,
  type SampleTutorialStep,
} from "../../src/public/react/components/ds/sample-tutorial.tsx";

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

// The guide converts viewport boxes to document ones, so the page offset is
// part of every placement assertion.
const scrolledTo = (top: number) => {
  Object.defineProperty(window, "scrollY", { configurable: true, value: top, writable: true });
  Object.defineProperty(window, "scrollX", { configurable: true, value: 0, writable: true });
};

afterEach(() => scrolledTo(0));

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

describe("sample tutorial start", () => {
  it("offers the bundle as a download alongside the guided run", () => {
    const onStart = vi.fn();
    const onSecondaryStart = vi.fn();
    render(
      <SampleTutorialStart
        downloadHref="/first-weave.zip"
        downloadLabel="Download the bundle"
        downloadName="first-weave.zip"
        error=""
        label="Start guided Apply"
        loading={false}
        onStart={onStart}
        onSecondaryStart={onSecondaryStart}
        secondaryLabel="Start guided Bundle"
      />,
    );

    const download = screen.getByRole("link", { name: /Download the bundle/ });
    expect(download.getAttribute("href")).toBe("/first-weave.zip");
    expect(download.hasAttribute("download")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Start guided Apply/ }));
    expect(onStart).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Start guided Bundle/ }));
    expect(onSecondaryStart).toHaveBeenCalledOnce();
  });
});

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

  it("places the pair in document coordinates so the page scrolls it along", async () => {
    scrolledTo(900);
    const guide = await renderAnchored({ height: 100, left: 200, top: 200, width: 600 });
    const ring = document.querySelector(".sample-tutorial-ring") as HTMLElement;

    // Row box plus the 7px ring inset on every side, offset by the scroll: the
    // ring is absolute, so these are document coordinates, not viewport ones.
    expect(ring.style.top).toBe(`${193 + 900}px`);
    expect(ring.style.height).toBe("114px");
    expect(guide.style.top).toBe(`${314 + 900}px`);
  });

  it("does not re-place on scroll - the composited page already moves the pair", async () => {
    const guide = await renderAnchored({ height: 100, left: 200, top: 200, width: 600 });
    const ring = document.querySelector(".sample-tutorial-ring") as HTMLElement;
    const before = [ring.style.top, guide.style.top];

    // The row's viewport box has moved because the page scrolled under it. A
    // scroll handler that rewrote the boxes here could only ever trail the
    // composited scroll, which is exactly the shake - the document coordinates
    // are unchanged, so there is nothing to do.
    scrolledTo(400);
    stubRect(document.querySelector("#tutorial-first") as HTMLElement, {
      height: 100,
      left: 200,
      top: -200,
      width: 600,
    });
    fireEvent.scroll(window);

    expect([ring.style.top, guide.style.top]).toEqual(before);
  });

  it("stops re-revealing the row once the user takes over the scroll", async () => {
    // happy-dom has no layout, so its ResizeObserver never fires - the row's
    // growth has to be delivered by hand.
    const rowGrew: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          rowGrew.push(callback);
        }
        disconnect() {
          // The callback list is per-test, so nothing to tear down.
        }
        observe() {
          // Observation is implied: the test calls the callback itself.
        }
      },
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Swallowed: happy-dom would throw on the real one, and the call itself is
    // what this test is watching for.
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    try {
      await renderAnchored({ height: 100, left: 200, top: 200, width: 600 });
      const target = document.querySelector("#tutorial-first") as HTMLElement;
      const grow = (height: number) => {
        stubRect(target, { height, left: 200, top: 200, width: 600 });
        for (const callback of rowGrew) callback();
        vi.advanceTimersByTime(700);
      };

      // A drawer opening still re-reveals the row it just made taller.
      scrollBy.mockClear();
      grow(300);
      expect(scrollBy).toHaveBeenCalled();

      // Once the user scrolls, the page is theirs - later growth re-places the
      // card but never scrolls out from under them.
      fireEvent.wheel(window);
      scrollBy.mockClear();
      grow(500);
      expect(scrollBy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      scrollBy.mockRestore();
    }
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
