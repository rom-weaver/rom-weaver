// @vitest-environment happy-dom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import {
  describeWarmupUnit,
  Masthead,
  offlineWarmupPercent,
  prefersReducedMotion,
  readPwaState,
  resolveRuntimeState,
} from "../../src/webapp/components/shell.tsx";
import type { WorkflowTab } from "../../src/webapp/components/shell.tsx";

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const TABS = [
  { dock: true, group: "patches", href: "apply", icon: <svg aria-hidden="true" />, id: "patcher", label: "Apply" },
  { dock: true, group: "patches", href: "create", icon: <svg aria-hidden="true" />, id: "creator", label: "Create" },
  { dock: true, group: "roms", href: "test", icon: <svg aria-hidden="true" />, id: "test", label: "Test" },
  { group: "project", href: "docs", icon: <svg aria-hidden="true" />, id: "docs", label: "Docs" },
  { group: "patches", href: "apply-patch#bundle", icon: <svg aria-hidden="true" />, id: "bundle", label: "Bundles" },
  { beta: true, group: "roms", href: "trim", icon: <svg aria-hidden="true" />, id: "trim", label: "Trim" },
] satisfies WorkflowTab[];

const mastheadProps = {
  currentTab: "patcher",
  githubHref: "https://example.com/repo",
  homeHref: "/apply-patch",
  onOpenWhatsNew: () => undefined,
  onOpenLog: () => undefined,
  onOpenSettings: () => undefined,
  onOpenStatus: () => undefined,
  onSelectTab: () => undefined,
  tabs: TABS,
  threads: 8,
  version: "1.2.3",
};

/* The desktop sidebar and the phone Menu sheet render the same description.
   The sheet fills in on its first open, so reaching it means opening Menu. */
const navs = (container: HTMLElement) => {
  fireEvent.click(container.querySelector(".dock-menu") as HTMLButtonElement);
  return {
    sheet: container.querySelector(".menu-sheet") as HTMLElement,
    side: container.querySelector(".side-nav") as HTMLElement,
  };
};
const rowNamed = (scope: HTMLElement, name: string) =>
  Array.from(scope.querySelectorAll<HTMLElement>(".nav-row")).find(
    (row) => row.querySelector(".nav-row-label")?.textContent === name,
  ) as HTMLElement;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("the navigation both layouts share", () => {
  it("routes every row to its handler, from either layout", () => {
    const onOpenLog = vi.fn();
    const onOpenStatus = vi.fn();
    const onSelectTab = vi.fn();
    const { container } = render(
      withSettings(
        <Masthead {...mastheadProps} onOpenLog={onOpenLog} onOpenStatus={onOpenStatus} onSelectTab={onSelectTab} />,
      ),
    );

    for (const scope of Object.values(navs(container))) {
      onSelectTab.mockClear();
      fireEvent.click(rowNamed(scope, "Status"));
      fireEvent.click(rowNamed(scope, "Logs"));
      fireEvent.click(rowNamed(scope, "What\u2019s new"));
      expect(onSelectTab).toHaveBeenCalledWith("whats-new");
      fireEvent.click(rowNamed(scope, "Trim"));
      expect(onSelectTab).toHaveBeenCalledWith("trim");
      fireEvent.click(rowNamed(scope, "Docs"));
      expect(onSelectTab).toHaveBeenCalledWith("docs");
      fireEvent.click(rowNamed(scope, "Bundles"));
      expect(onSelectTab).toHaveBeenCalledWith("bundle");
    }
    expect(onOpenStatus).toHaveBeenCalledTimes(2);
    expect(onOpenLog).toHaveBeenCalledTimes(2);
  });

  it("falls back to the Log dialog when no Storage handler is given", () => {
    const onOpenLog = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onOpenLog={onOpenLog} />));

    fireEvent.click(rowNamed(navs(container).side, "Storage"));

    expect(onOpenLog).toHaveBeenCalledTimes(1);
  });

  it("keeps Settings, Storage and Logs in the nav rather than behind a glyph", () => {
    const onOpenSettings = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onOpenSettings={onOpenSettings} />));
    const { side } = navs(container);
    // Each is a button, not a link: a dialog is not a URL.
    for (const name of ["Status", "Storage", "Logs", "Settings"]) {
      expect(rowNamed(side, name).tagName).toBe("BUTTON");
    }
    fireEvent.click(rowNamed(side, "Settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe("dismissing an open picker", () => {
  const openAccent = (container: HTMLElement) => {
    const tool = container.querySelector(".topbar-tools .accent-tool") as HTMLButtonElement;
    fireEvent.click(tool);
    return tool;
  };

  it("closes on a pointer press outside the tools cluster", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const tool = openAccent(container);
    expect(tool.getAttribute("aria-expanded")).toBe("true");

    fireEvent.pointerDown(document.body);

    expect(tool.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open for a press inside the cluster itself", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const tool = openAccent(container);

    fireEvent.pointerDown(container.querySelector(".topbar-tools .accent-tray") as HTMLElement);

    expect(tool.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on a document-level Escape and hands focus back", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const tool = openAccent(container);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(tool.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(tool);
  });
});

describe("dock tabs", () => {
  it("selects a tab on click", () => {
    const onSelectTab = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onSelectTab={onSelectTab} />));
    const dock = container.querySelector(".dock") as HTMLElement;

    fireEvent.click(dock.querySelectorAll<HTMLAnchorElement>(".dock-tab")[1] as HTMLAnchorElement);

    expect(onSelectTab).toHaveBeenCalledWith("creator");
  });

  it("leaves a modified click to the browser so the link opens normally", () => {
    const onSelectTab = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onSelectTab={onSelectTab} />));
    const dock = container.querySelector(".dock") as HTMLElement;

    fireEvent.click(dock.querySelectorAll<HTMLAnchorElement>(".dock-tab")[1] as HTMLAnchorElement, { metaKey: true });

    expect(onSelectTab).not.toHaveBeenCalled();
  });
});

describe("external links", () => {
  it("confirms before leaving from either layout, and opens the page once accepted", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const confirmExternalNavigation = vi.fn(async () => true);
    const { container } = render(
      withSettings(
        <Masthead
          {...mastheadProps}
          confirmExternalNavigation={confirmExternalNavigation}
          donateHref="https://example.com/donate"
        />,
      ),
    );

    for (const scope of Object.values(navs(container))) {
      confirmExternalNavigation.mockClear();
      fireEvent.click(rowNamed(scope, "GitHub"));
      await vi.waitFor(() => expect(confirmExternalNavigation).toHaveBeenCalledWith("https://example.com/repo"));
      fireEvent.click(rowNamed(scope, "Support"));
      await vi.waitFor(() => expect(confirmExternalNavigation).toHaveBeenCalledWith("https://example.com/donate"));
    }
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith("https://example.com/donate", "_blank", "noopener,noreferrer"),
    );
  });

  it("confirms before leaving from the top bar tiles too", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const confirmExternalNavigation = vi.fn(async () => true);
    const { container } = render(
      withSettings(
        <Masthead
          {...mastheadProps}
          confirmExternalNavigation={confirmExternalNavigation}
          donateHref="https://example.com/donate"
        />,
      ),
    );
    const tiles = within(container.querySelector(".topbar-tools") as HTMLElement);

    fireEvent.click(tiles.getByRole("link", { name: "View source on GitHub" }));

    await vi.waitFor(() => expect(confirmExternalNavigation).toHaveBeenCalledWith("https://example.com/repo"));
  });

  it("does not open the page when the reader declines", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const confirmExternalNavigation = vi.fn(async () => false);
    const { container } = render(
      withSettings(<Masthead {...mastheadProps} confirmExternalNavigation={confirmExternalNavigation} />),
    );

    fireEvent.click(rowNamed(navs(container).side, "GitHub"));
    await vi.waitFor(() => expect(confirmExternalNavigation).toHaveBeenCalledTimes(1));

    expect(open).not.toHaveBeenCalled();
  });

  it("leaves the link alone when there is nothing to confirm", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));

    const defaultAllowed = fireEvent.click(rowNamed(navs(container).side, "GitHub"));

    expect(defaultAllowed).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("offlineWarmupPercent", () => {
  it("prefers bytes and falls back to file counts", () => {
    expect(offlineWarmupPercent({ cachedBytes: 40, ready: false, totalBytes: 100 })).toBe(40);
    expect(offlineWarmupPercent({ cachedBytes: 0, cachedFiles: 3, ready: false, totalBytes: 0, totalFiles: 4 })).toBe(
      75,
    );
  });

  it("caps a finished-looking install at 99 and reports nothing without totals", () => {
    expect(offlineWarmupPercent({ cachedBytes: 100, ready: false, totalBytes: 100 })).toBe(99);
    expect(offlineWarmupPercent({ cachedBytes: 0, ready: false, totalBytes: 0 })).toBeNull();
    expect(offlineWarmupPercent({ cachedBytes: 1, ready: true, totalBytes: 2 })).toBeNull();
    expect(offlineWarmupPercent(null)).toBeNull();
  });

  it("counts a missing cachedFiles as none cached yet", () => {
    expect(offlineWarmupPercent({ cachedBytes: 0, ready: false, totalBytes: 0, totalFiles: 4 })).toBe(0);
  });
});

describe("resolveRuntimeState with the offline-copy preference", () => {
  it("shows online when the preference is off, except for worker-off and update states", () => {
    const ready = { cachedBytes: 1, ready: true, totalBytes: 1 };
    expect(resolveRuntimeState("active", false, ready, false)).toBe("online");
    expect(resolveRuntimeState("active", false, null, false)).toBe("online");
    expect(resolveRuntimeState("off", false, ready, false)).toBe("disabled");
    expect(resolveRuntimeState("active", true, ready, false)).toBe("update");
  });
});

describe("describeWarmupUnit", () => {
  const localizer = {
    message: (id: string, values?: Record<string, unknown>) => `${id}:${String(values?.name ?? "")}`,
  };
  const describeUnit = (progress: Parameters<typeof describeWarmupUnit>[1]) =>
    describeWarmupUnit(localizer as unknown as Parameters<typeof describeWarmupUnit>[0], progress);

  it("prefers the structured detail over the raw unit label", () => {
    expect(describeUnit({ detail: { kind: "identify-group", name: "Computers" }, unit: "emulatorjs:loader.js" })).toBe(
      "ui.runtime.detailIdentifyGroup:Computers",
    );
  });

  it("parses the raw unit label when no detail is given", () => {
    expect(describeUnit({ unit: "emulatorjs:loader.js" })).toBe("ui.runtime.detailEmulatorFile:loader.js");
  });

  it("reports nothing for a unit it cannot read", () => {
    expect(describeUnit(null)).toBeNull();
    expect(describeUnit({ unit: "" })).toBeNull();
    expect(describeUnit({ unit: "no-separator" })).toBeNull();
    expect(describeUnit({ unit: "emulatorjs:" })).toBeNull();
    expect(describeUnit({ unit: "something-else:name" })).toBeNull();
  });
});

describe("readPwaState", () => {
  it("is true for a standalone display mode and for iOS standalone", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("standalone") })),
    );
    expect(readPwaState()).toBe(true);

    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    expect(readPwaState()).toBe(false);
  });
});

describe("prefersReducedMotion", () => {
  it("reads the reduce query", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("reduce") })),
    );
    expect(prefersReducedMotion()).toBe(true);
  });
});

describe("the status the prerendered shell resolves", () => {
  // The masthead must answer the way index.html's parser-time resolver already did, or
  // hydration mismatches and React discards the prerendered page. Server rendering runs
  // no effects, so it shows exactly that first-render answer.
  const setServiceWorker = (controller: object | null) => {
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller } });
  };
  const READY_WARMUP = { cachedBytes: 1, ready: true, totalBytes: 1 };
  const renderShell = (offlineProgress?: typeof READY_WARMUP) =>
    renderToStaticMarkup(withSettings(<Masthead {...mastheadProps} offlineProgress={offlineProgress ?? null} />));

  afterEach(() => {
    document.documentElement.removeAttribute("data-service-worker-enabled");
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  it("resolves active once a controller and a finished warm-up are both present", () => {
    document.documentElement.dataset.serviceWorkerEnabled = "true";
    setServiceWorker({});
    window.localStorage.setItem("rom-weaver-offline-ready", "true");

    expect(renderShell(READY_WARMUP)).toContain('data-sw="active"');
  });

  it("renders the persisted offline-copy opt-out as online", () => {
    document.documentElement.dataset.serviceWorkerEnabled = "true";
    setServiceWorker({});
    window.localStorage.setItem("rom-weaver-offline-ready", "true");

    const html = renderToStaticMarkup(
      <RomWeaverSettingsProvider settings={{ offlineCopyEnabled: false }}>
        <Masthead {...mastheadProps} offlineProgress={READY_WARMUP} />
      </RomWeaverSettingsProvider>,
    );
    expect(html).toContain('data-sw="online"');
  });

  it("stays installing while the warm-up has not finished", () => {
    document.documentElement.dataset.serviceWorkerEnabled = "true";
    setServiceWorker({});

    expect(renderShell()).toContain('data-sw="installing"');
  });

  it("stays installing while no worker controls the page yet", () => {
    document.documentElement.dataset.serviceWorkerEnabled = "true";
    setServiceWorker(null);
    window.localStorage.setItem("rom-weaver-offline-ready", "true");

    expect(renderShell()).toContain('data-sw="installing"');
  });

  it("resolves disabled when the page runs without a service worker", () => {
    document.documentElement.dataset.serviceWorkerEnabled = "false";

    expect(renderShell()).toContain('data-sw="disabled"');
  });

  it("resolves disabled when reading the warm-up flag throws", () => {
    document.documentElement.dataset.serviceWorkerEnabled = "true";
    setServiceWorker({});
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage is blocked");
    });

    expect(renderShell()).toContain('data-sw="installing"');
  });
});

describe("the pull request build tag", () => {
  it("confirms before leaving for the pull request", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const confirmExternalNavigation = vi.fn(async () => true);
    const { container } = render(
      withSettings(
        <Masthead {...mastheadProps} channelBadge="pr-42" confirmExternalNavigation={confirmExternalNavigation} />,
      ),
    );

    const badge = container.querySelector(".build-tag a") as HTMLAnchorElement;
    expect(badge.getAttribute("href")).toBe("https://example.com/repo/pull/42");
    fireEvent.click(badge);

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(badge.href, "_blank", "noopener,noreferrer"));
  });
});

describe("the theme control", () => {
  it("names the choice that is on, and changes it when another is picked", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const themeTool = container.querySelector('.topbar-tools .tool[aria-label^="Theme"]') as HTMLButtonElement;
    expect(themeTool.getAttribute("aria-label")).toBe("Theme: Match system");

    fireEvent.click(themeTool);
    fireEvent.click(container.querySelectorAll('.topbar-tools [role="menuitemradio"]')[1] as HTMLButtonElement);

    expect(themeTool.getAttribute("aria-label")).toBe("Theme: Dark");
  });
});
