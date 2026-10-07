// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getViewTutorialStep,
  SampleTutorial,
  SampleTutorialStart,
  type SampleTutorialStep,
} from "../../src/public/react/components/ds/sample-tutorial.tsx";
import { RomWeaverSettingsProvider, useUiLocalizer } from "../../src/public/react/settings-context.tsx";

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

const TutorialSection = ({ children, id, label }: { children?: ReactNode; id: string; label: string }) => {
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
      {children}
    </section>
  );
};

// The app commits .rw-app long before the guide mounts, and ending the guide
// unmounts only the guide. Both matter here: the portal container is resolved
// on the guide's first render, and the drawer restore runs on its teardown.
const renderGuidedWorkbench = ({ onClose = vi.fn() }: { onClose?: () => void } = {}) => {
  const workbench = (guided: boolean) => (
    <div className="rw-app">
      {/* The shell's top bar. The guide clamps the card below it, so a test that
          leaves it out is testing a page whose chrome the card cannot cover. */}
      <div className="topbar" />
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
const renderAnchored = async (row: { height: number; left: number; top: number; width: number }, topbarHeight = 0) => {
  renderGuidedWorkbench();
  const target = document.querySelector("#tutorial-first") as HTMLElement;
  const guide = document.querySelector(".sample-tutorial-dialog") as HTMLElement;
  await waitFor(() => expect(target.classList.contains("sample-tutorial-target")).toBe(true));
  stubRect(target, row);
  stubRect(guide, { height: 200, left: 0, top: 0, width: 720 });
  // A zero height is happy-dom's own answer for an unstubbed box, and the guide
  // reads that as chrome owning no band - the default here keeps every other
  // placement case measuring against a bare margin.
  if (topbarHeight)
    stubRect(document.querySelector(".topbar") as HTMLElement, {
      height: topbarHeight,
      left: 0,
      top: 0,
      width: 1024,
    });
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
        downloadLabel="Download a test bundle"
        downloadName="first-weave.zip"
        error=""
        guideHref="/apply-patch?guide=apply"
        label="Start guided Apply"
        loading={false}
        onStart={onStart}
        onSecondaryStart={onSecondaryStart}
        secondaryLabel="Start guided bundle"
        secondaryHref="/bundle?guide=bundle"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /New here\?/ }));
    const download = screen.getByRole("link", { name: /Download a test bundle/ });
    expect(download.getAttribute("href")).toBe("/first-weave.zip");
    expect(download.hasAttribute("download")).toBe(true);

    const guidedApply = screen.getByRole("link", { name: /Start guided Apply/ });
    expect(guidedApply.getAttribute("href")).toBe("/apply-patch?guide=apply");
    fireEvent.click(guidedApply);
    expect(onStart).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link", { name: /Start guided Apply/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /New here\?/ }));
    const guidedBundle = screen.getByRole("link", { name: /Start guided bundle/ });
    expect(guidedBundle.getAttribute("href")).toBe("/bundle?guide=bundle");
    fireEvent.click(guidedBundle);
    expect(onSecondaryStart).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link", { name: /Start guided bundle/ })).toBeNull();
  });
  it("reopens the sample menu when loading fails", async () => {
    const props = {
      downloadHref: "/first-weave.zip",
      downloadLabel: "Download a test bundle",
      downloadName: "first-weave.zip",
      error: "",
      guideHref: "/bundle?guide=bundle",
      label: "Start guided bundle",
      loading: false,
      onStart: vi.fn(),
    };
    const { rerender } = render(<SampleTutorialStart {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /New here\?/ }));
    fireEvent.click(screen.getByRole("link", { name: /Start guided bundle/ }));
    expect(screen.queryByRole("link", { name: /Start guided bundle/ })).toBeNull();
    rerender(<SampleTutorialStart {...props} error="Could not load practice files" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Could not load practice files"));
    expect(screen.getByRole("link", { name: /Start guided bundle/ })).toBeTruthy();
  });
});

it("removes the guide query when the tutorial ends", () => {
  window.history.replaceState(null, "", "/apply-patch?guide=apply");
  const onClose = vi.fn();
  render(
    <div className="rw-app">
      <SampleTutorial loadingBody="Loading." onClose={onClose} ready steps={STEPS} />
    </div>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Leave the guide" }));
  expect(window.location.search).toBe("");
  expect(onClose).toHaveBeenCalledOnce();
});

describe("sample tutorial", () => {
  it("exposes the live step independently of translated copy", async () => {
    renderGuidedWorkbench();
    const guide = screen.getByRole("dialog");
    expect(guide.getAttribute("data-step")).toBe("1");
    expect(guide.getAttribute("data-step-count")).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(guide.getAttribute("data-step")).toBe("2"));
    expect(guide.getAttribute("data-step-count")).toBe("2");
  });

  it("centers an announced progress bar while the guided workbench is preparing", () => {
    render(
      <div className="rw-app">
        <SampleTutorial loadingBody="Loading." onClose={vi.fn()} ready={false} steps={STEPS} />
      </div>,
    );

    const guide = screen.getByRole("dialog", { name: "Loading the sample files" });
    expect(guide.getAttribute("aria-busy")).toBe("true");
    expect(guide.getAttribute("data-loading")).toBe("true");
    expect(guide.hasAttribute("data-step")).toBe(false);
    expect(guide.hasAttribute("data-step-count")).toBe(false);
    expect(screen.getByRole("progressbar", { name: "Loading sample files" }).getAttribute("aria-valuetext")).toBe(
      "Getting the sample ready",
    );
  });

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
    const actions = screen.getByRole("list", { name: "On this card" });
    expect(actions.textContent).toContain("Checks");
    expect(actions.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("Esc or ✕ leaves the guide.")).toBeTruthy();
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(back.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector("[aria-live]")?.textContent).not.toContain("leaves the guide");
    fireEvent.click(first);
    expect(screen.getByRole("heading", { name: "First section" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const second = document.querySelector("#tutorial-second") as HTMLElement;
    await waitFor(() => expect(second.classList.contains("sample-tutorial-target")).toBe(true));
    expect(screen.getByRole("button", { name: "Second drawer" }).getAttribute("aria-expanded")).toBe("true");
    expect(first.classList.contains("sample-tutorial-target")).toBe(false);
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(false);

    back.focus();
    fireEvent.click(back);
    await waitFor(() => expect(screen.getByRole("heading", { name: "First section" })).toBeTruthy());
    expect(document.activeElement).toBe(back);
    expect(back.disabled).toBe(false);
    expect(back.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Second section" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the same target mounted when its parent rerenders equivalent steps", async () => {
    const workbench = (steps: readonly SampleTutorialStep[]) => (
      <div className="rw-app">
        <TutorialSection id="tutorial-first" label="First drawer" />
        <SampleTutorial loadingBody="Loading." onClose={vi.fn()} ready steps={steps} />
      </div>
    );
    const { rerender } = render(workbench(STEPS.map((step) => ({ ...step }))));

    const target = document.querySelector("#tutorial-first") as HTMLElement;
    await waitFor(() => expect(target.classList.contains("sample-tutorial-target")).toBe(true));
    const ring = document.querySelector(".sample-tutorial-ring");
    expect(screen.getByRole("button", { name: "First drawer" }).getAttribute("aria-expanded")).toBe("true");

    rerender(workbench(STEPS.map((step) => ({ ...step }))));

    expect(document.querySelector(".sample-tutorial-ring")).toBe(ring);
    expect(target.classList.contains("sample-tutorial-target")).toBe(true);
    expect(screen.getByRole("button", { name: "First drawer" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps one live region across steps so the change is announced", async () => {
    renderGuidedWorkbench();

    const region = document.querySelector("[aria-live]");
    expect(region?.textContent).toContain("First section");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    // The card commits the new step when its exit animation settles, so the
    // text lands a frame later than the click.
    await waitFor(() => expect(region?.textContent).toContain("Second section"));
    // Update the existing live region so assistive technology can announce the changed content.
    expect(document.querySelector("[aria-live]")).toBe(region);
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

  it("clamps the card below the top bar rather than onto its controls", async () => {
    // A row too tall to fit the card below it anchors from its top, and the
    // slot above (200 - 14 - 200) is off the top of the page, so the card is
    // clamped. A bare 12px margin would park it over the top bar's theme and
    // project controls; the clamp starts at the bar's bottom plus that margin.
    const guide = await renderAnchored({ height: 400, left: 200, top: 200, width: 600 }, 46);

    await waitFor(() => expect(guide.style.top).toBe("58px"));
  });

  it("ignores chrome that owns no band, so a scrolled-away top bar costs nothing", async () => {
    const guide = await renderAnchored({ height: 400, left: 200, top: 200, width: 600 });

    await waitFor(() => expect(guide.style.top).toBe("12px"));
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

      // Growth that still leaves the row and its card on screen moves nothing:
      // 200 + 300 + 14 + 200 clears the 768px viewport's 12px floor.
      scrollBy.mockClear();
      grow(300);
      expect(scrollBy).not.toHaveBeenCalled();

      // A drawer opening that pushes the card off screen re-reveals the row.
      grow(450);
      expect(scrollBy).toHaveBeenCalled();

      // Once the user scrolls, the page is theirs - later growth re-places the
      // card but never scrolls out from under them.
      fireEvent.wheel(window);
      scrollBy.mockClear();
      grow(520);
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
    const onClose = vi.fn();
    const workbench = (guided: boolean) => (
      <div className="rw-app">
        <section id="tutorial-cta">
          <button className="btn run" type="button">
            Apply
          </button>
        </section>
        {guided ? <SampleTutorial loadingBody="Loading." onClose={onClose} ready steps={ctaSteps} /> : null}
      </div>
    );
    const { rerender } = render(workbench(false));
    rerender(workbench(true));

    const button = screen.getByRole("button", { name: "Apply" });
    await waitFor(() => expect(button.dataset.guideCta).toBe("true"));
    fireEvent.click(button);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    rerender(workbench(false));
    expect(button.dataset.guideCta).toBeUndefined();
  });

  it("re-closes an opened drawer when the final action ends the guide", async () => {
    const ctaSteps: readonly SampleTutorialStep[] = [
      {
        body: "Press it.",
        cta: ".btn.run",
        openDrawers: true,
        target: "#tutorial-cta",
        title: "Finish",
      },
    ];
    const onClose = vi.fn();
    const workbench = (guided: boolean) => (
      <div className="rw-app">
        <TutorialSection id="tutorial-cta" label="Output options">
          <button className="btn run" type="button">
            Apply
          </button>
        </TutorialSection>
        {guided ? <SampleTutorial loadingBody="Loading." onClose={onClose} ready steps={ctaSteps} /> : null}
      </div>
    );
    const { rerender } = render(workbench(false));
    rerender(workbench(true));

    const drawer = screen.getByRole("button", { name: "Output options" });
    await waitFor(() => expect(drawer.getAttribute("aria-expanded")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onClose).toHaveBeenCalledOnce();
    rerender(workbench(false));
    expect(drawer.getAttribute("aria-expanded")).toBe("false");
  });

  it("re-closes the drawers it opened when the guide ends", async () => {
    const { endGuide } = renderGuidedWorkbench();

    const drawer = screen.getByRole("button", { name: "First drawer" });
    await waitFor(() => expect(drawer.getAttribute("aria-expanded")).toBe("true"));
    endGuide();
    expect(drawer.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("sample tutorial shared anchor motion", () => {
  it("finishes moving when consecutive steps share their anchor", async () => {
    const animate = vi
      .spyOn(HTMLElement.prototype, "animate")
      .mockImplementation(() => ({ cancel: vi.fn(), finished: Promise.resolve() }) as unknown as Animation);
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    try {
      const sharedSteps = STEPS.map((step) => ({ ...step, target: "#tutorial-first" }));
      render(
        <div className="rw-app">
          <TutorialSection id="tutorial-first" label="First drawer" />
          <SampleTutorial loadingBody="Loading." onClose={vi.fn()} ready steps={sharedSteps} />
        </div>,
      );
      await waitFor(() => expect(document.querySelector(".sample-tutorial-ring")).toBeTruthy());
      fireEvent.click(document.querySelector(".sample-tutorial-next") as HTMLButtonElement);
      await waitFor(() =>
        expect(document.querySelector(".sample-tutorial-dialog")?.getAttribute("data-step")).toBe("2"),
      );
      expect(document.querySelector(".sample-tutorial-dialog")?.hasAttribute("data-moving")).toBe(false);
    } finally {
      animate.mockRestore();
      frame.mockRestore();
    }
  });
});

describe("sample tutorial step card", () => {
  const ViewGuide = ({ steps }: { steps?: readonly SampleTutorialStep[] }) => {
    const localizer = useUiLocalizer();
    return (
      <SampleTutorial
        loadingBody="Loading."
        onClose={vi.fn()}
        ready
        steps={steps ?? [getViewTutorialStep(localizer, "#tutorial-first"), STEPS[1] as SampleTutorialStep]}
      />
    );
  };
  const viewWorkbench = (
    detailedViewEnabled: boolean,
    withToggle = true,
    steps?: (localizer: ReturnType<typeof useUiLocalizer>) => readonly SampleTutorialStep[],
  ) => (
    <RomWeaverSettingsProvider settings={{ detailedViewEnabled }}>
      <div className="rw-app">
        <div className="workflow-panel-head">
          {withToggle ? (
            <label className="panel-view-toggle">
              <input type="checkbox" />
              <span>Detailed</span>
            </label>
          ) : null}
        </div>
        <TutorialSection id="tutorial-first" label="First drawer" />
        <TutorialSection id="tutorial-second" label="Second drawer" />
        {steps ? <BuiltGuide steps={steps} /> : <ViewGuide />}
      </div>
    </RomWeaverSettingsProvider>
  );
  const BuiltGuide = ({
    steps,
  }: {
    steps: (localizer: ReturnType<typeof useUiLocalizer>) => readonly SampleTutorialStep[];
  }) => <ViewGuide steps={steps(useUiLocalizer())} />;
  const mergedViewSteps = (localizer: ReturnType<typeof useUiLocalizer>) => [
    getViewTutorialStep(localizer, "#tutorial-first", {
      body: "Check the first section.",
      target: "#tutorial-first",
      title: "First section",
      tryIt: "Open the first drawer.",
    }),
    STEPS[1] as SampleTutorialStep,
  ];

  it("numbers the step in the beacon and kicker and shows its Try it action", () => {
    render(
      <div className="rw-app">
        <TutorialSection id="tutorial-first" label="First drawer" />
        <TutorialSection id="tutorial-second" label="Second drawer" />
        <SampleTutorial
          loadingBody="Loading."
          onClose={vi.fn()}
          ready
          steps={[
            { ...(STEPS[0] as SampleTutorialStep), tryIt: "Open the first drawer." },
            STEPS[1] as SampleTutorialStep,
          ]}
        />
      </div>,
    );

    expect(document.querySelector(".sample-tutorial-beacon")?.textContent).toBe("0x01");
    expect(document.querySelector(".sample-tutorial-kicker")?.textContent).toBe("Practice run · Step 1 of 2");
    expect(document.querySelectorAll(".sample-tutorial-pips i")).toHaveLength(2);
    expect(document.querySelector(".sample-tutorial-pips [data-state='current']")).toBe(
      document.querySelector(".sample-tutorial-pips i"),
    );
    const tryIt = document.querySelector(".sample-tutorial-try");
    expect(tryIt?.textContent).toBe("Try itOpen the first drawer.");
  });

  it("describes the current view and follows the Detailed setting while the step is open", async () => {
    const { rerender } = render(viewWorkbench(false));

    expect(screen.getByRole("heading", { name: "Choose how much to see" })).toBeTruthy();
    expect(screen.getByText(/You're in Simple view/)).toBeTruthy();
    expect(document.querySelector(".sample-tutorial-compare [data-current='true']")?.textContent).toContain("Simple");
    expect(screen.getByText(/Switch Detailed on/)).toBeTruthy();
    const head = document.querySelector(".workflow-panel-head") as HTMLElement;
    await waitFor(() => expect(head.classList.contains("sample-tutorial-lift")).toBe(true));

    rerender(viewWorkbench(true));
    expect(screen.getByText(/You're in Detailed view/)).toBeTruthy();
    expect(document.querySelector(".sample-tutorial-compare [data-current='true']")?.textContent).toContain("Detailed");
    expect(screen.getByText(/Switch Detailed off/)).toBeTruthy();
  });

  it("changes the live view from the guide comparison without advancing", async () => {
    const Workbench = () => {
      const [detailed, setDetailed] = useState(false);
      return (
        <RomWeaverSettingsProvider settings={{ detailedViewEnabled: detailed }}>
          <div className="rw-app">
            <div className="workflow-panel-head">
              <label className="panel-view-toggle">
                <input
                  checked={detailed}
                  onChange={(event) => setDetailed(event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>Detailed</span>
              </label>
            </div>
            <TutorialSection id="tutorial-first" label="First drawer" />
            <ViewGuide />
          </div>
        </RomWeaverSettingsProvider>
      );
    };
    render(<Workbench />);
    await waitFor(() => expect(document.querySelector("#tutorial-first.sample-tutorial-target")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detailed", pressed: false }));
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
    expect(screen.getByText(/You're in Detailed view/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Detailed", pressed: true }));
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("button", { name: "Simple", pressed: false }));
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
    expect(document.querySelector(".sample-tutorial-dialog")?.getAttribute("data-step")).toBe("1");
  });

  it("lifts the switch in the target's own panel, not a hidden panel's earlier copy", async () => {
    // Visited workflows stay mounted but hidden, each with its own heading -
    // a document-wide lookup would light up the first one, which is not on screen.
    const ViewOnly = () => {
      const localizer = useUiLocalizer();
      return (
        <SampleTutorial
          loadingBody="Loading."
          onClose={vi.fn()}
          ready
          steps={[getViewTutorialStep(localizer, "#tutorial-first")]}
        />
      );
    };
    render(
      <RomWeaverSettingsProvider settings={{ detailedViewEnabled: false }}>
        <div className="rw-app">
          <section hidden id="panel-hidden">
            <div className="workflow-panel-head">
              <label className="panel-view-toggle">
                <input type="checkbox" />
                <span>Detailed</span>
              </label>
            </div>
          </section>
          <section id="panel-shown">
            <div className="workflow-panel-head">
              <label className="panel-view-toggle">
                <input type="checkbox" />
                <span>Detailed</span>
              </label>
            </div>
            <TutorialSection id="tutorial-first" label="First drawer" />
          </section>
          <ViewOnly />
        </div>
      </RomWeaverSettingsProvider>,
    );

    const shown = document.querySelector("#panel-shown .workflow-panel-head") as HTMLElement;
    await waitFor(() => expect(shown.classList.contains("sample-tutorial-lift")).toBe(true));
    expect(
      document.querySelector("#panel-hidden .workflow-panel-head")?.classList.contains("sample-tutorial-lift"),
    ).toBe(false);
  });

  it("leaves the view step out when the page has no Detailed switch", () => {
    render(viewWorkbench(false, false));

    expect(screen.queryByRole("heading", { name: "Choose how much to see" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Second section" })).toBeTruthy();
    expect(document.querySelector(".sample-tutorial-kicker")?.textContent).toBe("Practice run · Step 1 of 1");
  });

  it("folds the view explanation into a card's own step", async () => {
    render(viewWorkbench(false, true, mergedViewSteps));

    expect(screen.getByRole("heading", { name: "First section" })).toBeTruthy();
    expect(document.querySelector(".sample-tutorial-kicker")?.textContent).toBe("Practice run · Step 1 of 2");
    expect(screen.getByText(/^Check the first section\. You're in Simple view/)).toBeTruthy();
    expect(document.querySelector(".sample-tutorial-compare")).toBeTruthy();
    expect(screen.getByText(/Switch Detailed on/)).toBeTruthy();
    const head = document.querySelector(".workflow-panel-head") as HTMLElement;
    await waitFor(() => expect(head.classList.contains("sample-tutorial-lift")).toBe(true));
  });

  it("keeps a folded view step as a plain step when the page has no Detailed switch", () => {
    render(viewWorkbench(false, false, mergedViewSteps));

    expect(screen.getByRole("heading", { name: "First section" })).toBeTruthy();
    expect(document.querySelector(".sample-tutorial-kicker")?.textContent).toBe("Practice run · Step 1 of 2");
    expect(screen.getByText("Check the first section.")).toBeTruthy();
    expect(screen.queryByText(/You're in Simple view/)).toBeNull();
    expect(document.querySelector(".sample-tutorial-compare")).toBeNull();
    expect(document.querySelector(".sample-tutorial-try")?.textContent).toBe("Try itOpen the first drawer.");
  });

  it("holds Continue on a locked step that has no work of its own", async () => {
    const workbench = (locked: boolean) => (
      <div className="rw-app">
        <TutorialSection id="tutorial-first" label="First drawer" />
        <TutorialSection id="tutorial-second" label="Second drawer" />
        <SampleTutorial
          loadingBody="Loading."
          onClose={vi.fn()}
          ready
          steps={[{ ...(STEPS[0] as SampleTutorialStep), locked }, STEPS[1] as SampleTutorialStep]}
        />
      </div>
    );
    const { rerender } = render(workbench(true));

    const next = screen.getByRole("button", { name: "Continue" });
    expect(next.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(next);
    expect(screen.getByRole("heading", { name: "First section" })).toBeTruthy();

    rerender(workbench(false));
    expect(next.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(next);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Second section" })).toBeTruthy());
  });

  it("runs a locked step's Continue work and moves on once the step unlocks", async () => {
    const onContinue = vi.fn();
    const workbench = ({ busy = false, error = "", locked = true } = {}) => (
      <div className="rw-app">
        <TutorialSection id="tutorial-first" label="First drawer" />
        <TutorialSection id="tutorial-second" label="Second drawer" />
        <SampleTutorial
          download={{ href: "/first-weave.zip", name: "first-weave.zip" }}
          error={error}
          loadingBody="Loading."
          onClose={vi.fn()}
          ready
          steps={[{ ...(STEPS[0] as SampleTutorialStep), busy, locked, onContinue }, STEPS[1] as SampleTutorialStep]}
        />
      </div>
    );
    const { rerender } = render(workbench());

    const next = screen.getByRole("button", { name: "Continue" });
    expect(next.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByRole("link", { name: "Download first-weave.zip" }).getAttribute("href")).toBe(
      "/first-weave.zip",
    );
    fireEvent.click(next);
    expect(onContinue).toHaveBeenCalledOnce();
    rerender(workbench({ busy: true }));
    expect(next.getAttribute("aria-busy")).toBe("true");
    expect(next.textContent).toBe("Loading sample files…");
    // A second press while the files load starts nothing new.
    fireEvent.click(next);
    expect(onContinue).toHaveBeenCalledOnce();

    rerender(workbench({ locked: false }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Second section" })).toBeTruthy());
    // The download belongs to the first step only.
    expect(screen.queryByRole("link", { name: "Download first-weave.zip" })).toBeNull();
  });

  it("stays on a locked step whose Continue work failed", async () => {
    const workbench = ({ error = "", locked = true } = {}) => (
      <div className="rw-app">
        <TutorialSection id="tutorial-first" label="First drawer" />
        <TutorialSection id="tutorial-second" label="Second drawer" />
        <SampleTutorial
          error={error}
          loadingBody="Loading."
          onClose={vi.fn()}
          ready
          steps={[{ ...(STEPS[0] as SampleTutorialStep), locked, onContinue: vi.fn() }, STEPS[1] as SampleTutorialStep]}
        />
      </div>
    );
    const { rerender } = render(workbench());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    rerender(workbench({ error: "Could not load the sample. Try again." }));
    expect(screen.getByRole("status").textContent).toBe("Could not load the sample. Try again.");

    // Files the reader adds afterwards unlock the step without carrying it on.
    rerender(workbench({ locked: false }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("heading", { name: "First section" })).toBeTruthy();
  });

  it("highlights the row on screen, not a hidden panel's copy of it", async () => {
    render(
      <div className="rw-app">
        {/* A visited workbench stays mounted, hidden, with the same row ids. */}
        <div hidden>
          <TutorialSection id="tutorial-first" label="Hidden drawer" />
        </div>
        <div className="panel">
          <TutorialSection id="tutorial-first" label="First drawer" />
          <TutorialSection id="tutorial-second" label="Second drawer" />
          <SampleTutorial loadingBody="Loading." onClose={vi.fn()} ready steps={STEPS} />
        </div>
      </div>,
    );
    const [hidden, shown] = Array.from(document.querySelectorAll<HTMLElement>("[id='tutorial-first']"));
    await waitFor(() => expect(shown?.classList.contains("sample-tutorial-target")).toBe(true));
    expect(hidden?.classList.contains("sample-tutorial-target")).toBe(false);
    expect(document.querySelector(".sample-tutorial-ring")).toBeTruthy();
  });
});
