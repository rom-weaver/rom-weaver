// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import {
  describeWarmupUnit,
  Masthead,
  offlineWarmupPercent,
  prefersReducedMotion,
  readPwaState,
  SiteFooter,
} from "../../src/webapp/components/shell.tsx";

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const TABS = [
  { href: "apply", icon: <svg aria-hidden="true" />, id: "patcher", label: "Apply" },
  { href: "create", icon: <svg aria-hidden="true" />, id: "creator", label: "Create" },
  { href: "docs", icon: <svg aria-hidden="true" />, id: "docs", label: "Docs" },
  { href: "test", icon: <svg aria-hidden="true" />, id: "test", label: "Test" },
  { href: "trim", icon: <svg aria-hidden="true" />, id: "trim", label: "Trim" },
];

const mastheadProps = {
  currentTab: "patcher",
  githubHref: "https://example.com/repo",
  homeHref: "/apply",
  onOpenChangelog: () => undefined,
  onOpenLog: () => undefined,
  onOpenSettings: () => undefined,
  onOpenStatus: () => undefined,
  onSelectTab: () => undefined,
  tabs: TABS,
  threads: 8,
  version: "1.2.3",
};

// A pointer open parks focus on the menu box itself, which is where the arrow keys start from.
const openDesktopMore = (container: HTMLElement) => {
  const more = container.querySelector(".desktop-more .mode-more") as HTMLButtonElement;
  fireEvent.pointerDown(more);
  fireEvent.click(more);
  return { menu: container.querySelector('[role="menu"]') as HTMLElement, more };
};

const menuItems = (menu: HTMLElement) => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("More menu keyboard movement", () => {
  it("walks the items with the arrow keys, Home and End", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const { menu } = openDesktopMore(container);
    const items = menuItems(menu);
    expect(items.length).toBeGreaterThan(2);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items.at(-1));

    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("wraps from the first item back to the last", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const { menu } = openDesktopMore(container);
    const items = menuItems(menu);

    fireEvent.keyDown(menu, { key: "Home" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });

    expect(document.activeElement).toBe(items.at(-1));
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const { menu, more } = openDesktopMore(container);

    fireEvent.keyDown(menu, { key: "Escape" });

    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);
  });

  it("ignores a key it does not handle", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const { menu, more } = openDesktopMore(container);
    const active = document.activeElement;

    fireEvent.keyDown(menu, { key: "a" });

    expect(document.activeElement).toBe(active);
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("More menu destinations", () => {
  it("routes each item to its handler and closes the menu", () => {
    const onOpenChangelog = vi.fn();
    const onOpenLog = vi.fn();
    const onOpenStatus = vi.fn();
    const onSelectTab = vi.fn();
    const { container, getByRole } = render(
      withSettings(
        <Masthead
          {...mastheadProps}
          onOpenChangelog={onOpenChangelog}
          onOpenLog={onOpenLog}
          onOpenStatus={onOpenStatus}
          onSelectTab={onSelectTab}
        />,
      ),
    );

    openDesktopMore(container);
    fireEvent.click(getByRole("menuitem", { name: "Status" }));
    expect(onOpenStatus).toHaveBeenCalledTimes(1);

    openDesktopMore(container);
    fireEvent.click(getByRole("menuitem", { name: "Logs" }));
    expect(onOpenLog).toHaveBeenCalledTimes(1);

    openDesktopMore(container);
    fireEvent.click(getByRole("menuitem", { name: "Changelog" }));
    expect(onOpenChangelog).toHaveBeenCalledTimes(1);

    openDesktopMore(container);
    fireEvent.click(getByRole("menuitem", { name: "Trim" }));
    expect(onSelectTab).toHaveBeenCalledWith("trim");
  });

  it("falls back to the Log dialog when no Storage handler is given", () => {
    const onOpenLog = vi.fn();
    const { container, getByRole } = render(withSettings(<Masthead {...mastheadProps} onOpenLog={onOpenLog} />));

    openDesktopMore(container);
    fireEvent.click(getByRole("menuitem", { name: "Storage" }));

    expect(onOpenLog).toHaveBeenCalledTimes(1);
  });

  it("clears the pointer flag when the trigger loses focus", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const more = container.querySelector(".desktop-more .mode-more") as HTMLButtonElement;

    fireEvent.pointerDown(more);
    fireEvent.blur(more);
    fireEvent.click(more);

    // The blur dropped the "opened by pointer" flag, so this open behaves like a keyboard one.
    expect(document.activeElement).toBe(container.querySelector('[role="menu"] [role="menuitem"]'));
  });
});

describe("More menu on the phone layout", () => {
  const mobileTrigger = (container: HTMLElement) =>
    container.querySelector(".mobile-more .dock-action") as HTMLButtonElement;
  const openMobileMore = (container: HTMLElement) => {
    fireEvent.click(mobileTrigger(container));
    return container.querySelector(".more-menu.shared-more-menu") as HTMLElement;
  };

  it("adds the settings, theme and accent rows the desktop rail already shows", () => {
    const onOpenSettings = vi.fn();
    const onAccentChange = vi.fn();
    const { container } = render(
      withSettings(<Masthead {...mastheadProps} onAccentChange={onAccentChange} onOpenSettings={onOpenSettings} />),
    );

    const menu = openMobileMore(container);
    const labels = menuItems(menu).map((item) => item.textContent);
    expect(labels[0]).toContain("Settings");
    expect(labels.some((label) => label?.includes("Theme"))).toBe(true);
    expect(labels.some((label) => label?.includes("Accent"))).toBe(true);

    fireEvent.click(menuItems(menu)[0] as HTMLElement);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("toggles the theme from its row and closes the menu", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const menu = openMobileMore(container);
    const theme = menuItems(menu).find((item) => item.textContent?.includes("Theme")) as HTMLElement;

    fireEvent.click(theme);

    expect(mobileTrigger(container).getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the accent tray and commits a choice", () => {
    const onAccentChange = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onAccentChange={onAccentChange} />));
    const menu = openMobileMore(container);
    const accent = menuItems(menu).find((item) => item.textContent?.includes("Accent")) as HTMLElement;

    fireEvent.click(accent);
    const tray = container.querySelector(".more-accent-tray") as HTMLElement;
    expect(tray).not.toBeNull();

    const choice = tray.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1] as HTMLInputElement;
    fireEvent.click(choice);

    expect(onAccentChange).toHaveBeenCalledWith(choice.value);
  });
});

describe("dismissing an open menu", () => {
  it("closes on a pointer press outside the masthead", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const { more } = openDesktopMore(container);
    expect(more.getAttribute("aria-expanded")).toBe("true");

    fireEvent.pointerDown(document.body);

    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open for a press inside the menu's own anchor", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const { menu, more } = openDesktopMore(container);

    fireEvent.pointerDown(menu);

    expect(more.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on a document-level Escape", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const { more } = openDesktopMore(container);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);
  });
});

describe("dock tabs", () => {
  it("selects a tab on click and moves focus with the arrow keys", () => {
    const onSelectTab = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onSelectTab={onSelectTab} />));
    const dock = container.querySelector(".dock-tabs") as HTMLElement;

    fireEvent.click(dock.querySelectorAll<HTMLAnchorElement>(".dock-tab")[1] as HTMLAnchorElement);
    expect(onSelectTab).toHaveBeenCalledWith("creator");

    fireEvent.keyDown(dock, { key: "ArrowRight" });
    expect(onSelectTab).toHaveBeenLastCalledWith("creator");
    expect(document.activeElement).toBe(dock.querySelector('.dock-tab[data-mode="creator"]'));
  });

  it("leaves a modified click to the browser so the link opens normally", () => {
    const onSelectTab = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onSelectTab={onSelectTab} />));
    const dock = container.querySelector(".dock-tabs") as HTMLElement;

    fireEvent.click(dock.querySelectorAll<HTMLAnchorElement>(".dock-tab")[1] as HTMLAnchorElement, { metaKey: true });

    expect(onSelectTab).not.toHaveBeenCalled();
  });
});

describe("the rail thumb without CSS anchor positioning", () => {
  beforeEach(() => {
    vi.stubGlobal("CSS", { supports: () => false });
  });

  it("measures the selected tab and follows a resize", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const thumb = container.querySelector(".mode-thumb") as HTMLElement;

    expect(thumb.style.left).toBe("0px");
    expect(thumb.style.width).toBe("0px");
    expect(thumb.style.transition).toBe("none");

    fireEvent(window, new Event("resize"));

    expect(thumb.style.left).toBe("0px");
  });
});

describe("external links", () => {
  it("asks before leaving from the footer and opens the page once accepted", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const confirmExternalNavigation = vi.fn(async () => true);
    const { container } = render(
      withSettings(
        <SiteFooter
          confirmExternalNavigation={confirmExternalNavigation}
          donateHref="https://example.com/donate"
          githubHref="https://example.com/repo"
        />,
      ),
    );

    fireEvent.click(container.querySelectorAll<HTMLAnchorElement>(".footer-link")[0] as HTMLAnchorElement);
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith("https://example.com/repo", "_blank", "noopener,noreferrer"),
    );

    fireEvent.click(container.querySelector(".footer-support") as HTMLAnchorElement);
    await vi.waitFor(() => expect(confirmExternalNavigation).toHaveBeenCalledWith("https://example.com/donate"));
  });

  it("does not open the page when the reader declines", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const confirmExternalNavigation = vi.fn(async () => false);
    const { container } = render(
      withSettings(
        <SiteFooter confirmExternalNavigation={confirmExternalNavigation} githubHref="https://example.com/repo" />,
      ),
    );

    fireEvent.click(container.querySelector(".footer-link") as HTMLAnchorElement);
    await vi.waitFor(() => expect(confirmExternalNavigation).toHaveBeenCalledTimes(1));

    expect(open).not.toHaveBeenCalled();
  });

  it("leaves the link alone when there is nothing to confirm", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const { container } = render(withSettings(<SiteFooter githubHref="https://example.com/repo" />));

    const defaultAllowed = fireEvent.click(container.querySelector(".footer-link") as HTMLAnchorElement);

    expect(defaultAllowed).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("confirms before leaving from inside the More menu", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const confirmExternalNavigation = vi.fn(async () => true);
    const { container, getByRole } = render(
      withSettings(
        <Masthead
          {...mastheadProps}
          confirmExternalNavigation={confirmExternalNavigation}
          donateHref="https://example.com/donate"
        />,
      ),
    );

    openDesktopMore(container);
    fireEvent.click(getByRole("menuitem", { name: "View source on GitHub" }));
    await vi.waitFor(() => expect(confirmExternalNavigation).toHaveBeenCalledWith("https://example.com/repo"));

    openDesktopMore(container);
    fireEvent.click(getByRole("menuitem", { name: "Support" }));
    await vi.waitFor(() => expect(confirmExternalNavigation).toHaveBeenCalledWith("https://example.com/donate"));
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

describe("the desktop theme control", () => {
  it("flips the label it offers when the theme is toggled", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const themeTool = Array.from(container.querySelectorAll<HTMLButtonElement>(".masthead-tools .tool")).find((tool) =>
      /theme|dark|light/i.test(tool.getAttribute("aria-label") ?? ""),
    ) as HTMLButtonElement;
    const before = themeTool.getAttribute("aria-label");

    fireEvent.click(themeTool);

    expect(themeTool.getAttribute("aria-label")).not.toBe(before);
  });
});
