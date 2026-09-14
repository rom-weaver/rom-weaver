// @vitest-environment happy-dom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { Masthead, Reveal, UpdateBanner } from "../../../src/webapp/components/shell.tsx";
import type { WorkflowTab } from "../../../src/webapp/components/shell.tsx";

/**
 * App-shell contract: one description of the navigation rendered as the desktop
 * sidebar and as the phone Menu sheet, the dock's three workflow slots plus
 * Menu, the identity block's build/threads/runtime controls, the top bar's
 * appearance and project tiles, and the update banner.
 */

// The suite runs without vitest globals, so RTL cannot auto-clean between tests.
afterEach(cleanup);

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const TABS = [
  {
    dock: true,
    group: "patches",
    href: "apply",
    icon: <svg aria-hidden="true" />,
    id: "patcher",
    label: "Apply Patch",
    railLabel: "Apply",
  },
  {
    dock: true,
    group: "patches",
    href: "create",
    icon: <svg aria-hidden="true" />,
    id: "creator",
    label: "Create Patch",
    railLabel: "Create",
  },
  {
    dock: true,
    group: "roms",
    href: "test",
    icon: <svg aria-hidden="true" />,
    id: "test",
    label: "Test ROM",
    railLabel: "Test",
  },
  { group: "project", href: "docs", icon: <svg aria-hidden="true" />, id: "docs", label: "Docs" },
  {
    beta: true,
    group: "roms",
    href: "trim",
    icon: <svg aria-hidden="true" />,
    id: "trim",
    label: "Trim ROM",
    railLabel: "Trim",
  },
  {
    beta: true,
    group: "patches",
    href: "ppf-undo",
    icon: <svg aria-hidden="true" />,
    id: "ppf-undo",
    label: "PPF undo",
  },
  {
    beta: true,
    group: "roms",
    href: "save-editor",
    icon: <svg aria-hidden="true" />,
    id: "save-editor",
    label: "Save Editor",
    railLabel: "Saves",
  },
] satisfies WorkflowTab[];

const mastheadProps = {
  currentTab: "patcher",
  homeHref: "/apply",
  donateHref: "https://example.com/donate",
  githubHref: "https://example.com/repo",
  onOpenWhatsNew: () => undefined,
  onOpenLog: () => undefined,
  onOpenSettings: () => undefined,
  onOpenStatus: () => undefined,
  onOpenStorage: () => undefined,
  onSelectTab: () => undefined,
  tabs: TABS,
  threads: 8,
  version: "1.2.3",
};

/** Labels of the rows one nav actually shows, in order. */
const rowsOf = (nav: Element | null) =>
  Array.from(nav?.querySelectorAll<HTMLElement>(".nav-row") ?? [])
    .filter((row) => !row.hidden)
    .map((row) => row.querySelector(".nav-row-label")?.textContent ?? "");

describe("Masthead", () => {
  it("names every destination in the sidebar, under the group that supplies its noun", () => {
    const onSelectTab = vi.fn();
    const { container, getByRole } = render(withSettings(<Masthead {...mastheadProps} onSelectTab={onSelectTab} />));
    const nav = container.querySelector(".side-nav") as HTMLElement;
    expect(nav.getAttribute("aria-label")).toBe("Workflow");
    // Nothing is filed under an unnamed overflow: the four headings are the
    // whole map, and every workflow appears exactly once.
    expect(Array.from(nav.querySelectorAll(".nav-group-label")).map((h) => h.textContent)).toEqual([
      "Patches",
      "ROMs",
      "This device",
      "Project",
    ]);
    expect(rowsOf(nav)).toEqual([
      "Apply",
      "Create",
      "PPF undo",
      "Test",
      "Trim",
      "Saves",
      "Status",
      "Storage",
      "Logs",
      "Settings",
      "Docs",
      "What\u2019s new",
      "GitHub",
      "Support",
    ]);

    // "/" maps to no route, so the brand has to name one or the browser
    // hard-reloads and every staged file goes with it.
    const logoHome = getByRole("link", { name: "rom-weaver home" });
    expect(logoHome.getAttribute("href")).toBe("/apply");
    expect(logoHome.querySelector(".brand-mark")).toBeTruthy();
    expect(container.querySelector(".brand-word-link")?.getAttribute("href")).toBe("/apply");
    // The identity block is stated once, so the two layouts cannot disagree.
    expect(container.querySelectorAll("h1").length).toBe(1);
    expect(container.querySelectorAll(".brand").length).toBe(1);
    expect(container.querySelectorAll(".masthead-threads").length).toBe(1);
    expect(container.querySelectorAll(".sub-status").length).toBe(1);

    const apply = nav.querySelector('[aria-current="page"]') as HTMLAnchorElement;
    expect(apply.textContent).toBe("Apply");
    expect(apply.id).toBe("tab-patcher");
    expect(apply.getAttribute("aria-label")).toBe("Apply Patch");
    fireEvent.click(rowsOf(nav).length ? (nav.querySelectorAll(".nav-row")[1] as HTMLAnchorElement) : apply);
    expect(onSelectTab).toHaveBeenCalledWith("creator");
  });

  it("gives the phone Menu the same sections in the same order as the sidebar", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const sheet = container.querySelector(".menu-sheet") as HTMLElement;
    expect(sheet.getAttribute("aria-label")).toBe("Menu");
    expect(sheet.hasAttribute("hidden")).toBe(true);
    // The sheet's rows are the sidebar's rows, so the prerendered shell ships
    // them once and the sheet fills in the first time Menu is opened.
    expect(rowsOf(sheet)).toEqual([]);

    fireEvent.click(container.querySelector(".dock-menu") as HTMLButtonElement);

    expect(rowsOf(sheet)).toEqual(rowsOf(container.querySelector(".side-nav")));
  });

  it("docks three workflows plus Menu, and toggles the sheet from the same button", () => {
    const onSelectTab = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onSelectTab={onSelectTab} />));
    const dockNav = container.querySelector(".dock") as HTMLElement;
    const slots = Array.from(dockNav.children);
    expect(slots.map((slot) => slot.textContent)).toEqual(["Apply", "Create", "Test", "Menu"]);
    expect(slots[0]?.getAttribute("aria-current")).toBe("page");

    const menu = container.querySelector(".dock-menu") as HTMLButtonElement;
    const sheet = container.querySelector(".menu-sheet") as HTMLElement;
    expect(menu.getAttribute("aria-controls")).toBe(sheet.id);
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(sheet.hidden).toBe(false);
    // Clicking Menu again closes it; so does Escape.
    fireEvent.click(menu);
    expect(sheet.hidden).toBe(true);
    fireEvent.click(menu);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(sheet.hidden).toBe(true);

    fireEvent.click(slots[2] as HTMLAnchorElement);
    expect(onSelectTab).toHaveBeenCalledWith("test");
  });

  it("closes the Menu sheet when a row inside it routes", () => {
    const onSelectTab = vi.fn();
    const onOpenStorage = vi.fn();
    const { container } = render(
      withSettings(<Masthead {...mastheadProps} onOpenStorage={onOpenStorage} onSelectTab={onSelectTab} />),
    );
    fireEvent.click(container.querySelector(".dock-menu") as HTMLButtonElement);
    const sheet = container.querySelector(".menu-sheet") as HTMLElement;
    fireEvent.click(within(sheet).getByRole("button", { name: "Storage" }));
    expect(onOpenStorage).toHaveBeenCalledTimes(1);
    expect(sheet.hidden).toBe(true);
  });

  it("hides beta workflows from both layouts while the setting is off", () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{ betaToolsEnabled: false }}>
        <Masthead {...mastheadProps} />
      </RomWeaverSettingsProvider>,
    );
    fireEvent.click(container.querySelector(".dock-menu") as HTMLButtonElement);
    for (const nav of [".side-nav", ".menu-sheet"]) {
      const labels = rowsOf(container.querySelector(nav));
      expect(labels).not.toContain("Trim");
      expect(labels).not.toContain("PPF undo");
      expect(labels).not.toContain("Saves");
      expect(labels).toContain("Apply");
    }
    // The rows are still in the markup: the setting is client-only, so the
    // prerendered shell and the first hydration pass must agree on the DOM.
    expect(container.querySelector('.side-nav .nav-row[href="trim"]')?.hasAttribute("hidden")).toBe(true);
  });

  it("wears a BETA chip beside the name it qualifies", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const trim = container.querySelector('.side-nav .nav-row[href="trim"]') as HTMLElement;
    expect(trim.querySelector(".nav-beta")?.textContent).toBe("Beta");
    // The chip follows the label rather than being pushed to the row's edge.
    expect(trim.querySelector(".nav-row-label")?.nextElementSibling?.classList.contains("nav-beta")).toBe(true);
  });

  it("keeps every workflow row a real link so a modified click opens it normally", () => {
    const onSelectTab = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onSelectTab={onSelectTab} />));
    const row = container.querySelector('.side-nav .nav-row[href="whats-new"]') as HTMLAnchorElement;
    expect(row.getAttribute("href")).toBe("whats-new");
    fireEvent.click(row, { ctrlKey: true });
    expect(onSelectTab).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(onSelectTab).toHaveBeenCalledWith("whats-new");
  });

  it("marks the current page in the nav, including a view with no dock slot", () => {
    for (const [view, label] of [
      ["docs", "Docs"],
      ["trim", "Trim"],
      ["whats-new", "What\u2019s new"],
    ] as const) {
      const { container, unmount } = render(withSettings(<Masthead {...mastheadProps} currentTab={view} />));
      const current = container.querySelector('.side-nav [aria-current="page"]') as HTMLElement;
      expect(current.querySelector(".nav-row-label")?.textContent).toBe(label);
      // No dock slot claims to be the current page when the view is not docked.
      expect(container.querySelector('.dock [aria-current="page"]')).toBeNull();
      unmount();
    }
  });

  it("puts appearance and the project links in the top bar and the phone header, in one order", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const names = (scope: string) =>
      Array.from(container.querySelectorAll(`${scope} .tool`)).map((tool) => tool.getAttribute("aria-label"));
    const expected = ["Theme: Match system", "Accent: Madder", "Docs", "View source on GitHub", "Support"];
    expect(names(".topbar-tools")).toEqual(expected);
    expect(names(".shell-head-tools")).toEqual(expected);
    // Find belongs to the top bar, and no destination is listed twice there.
    expect(container.querySelector(".topbar .topbar-find")).toBeTruthy();
    expect(container.querySelector(".topbar .nav-row")).toBeNull();
  });

  it("offers theme as three named choices rather than a cycle", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const theme = container.querySelector('.topbar-tools .tool[aria-label^="Theme"]') as HTMLButtonElement;
    expect(theme.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(theme);
    const items = Array.from(container.querySelectorAll('.topbar-tools [role="menuitemradio"]'));
    expect(items.map((item) => item.firstChild?.nextSibling?.textContent)).toEqual(["Light", "Dark", "Match system"]);
    // "Match system" says which theme that currently resolves to.
    expect(items[2]?.querySelector(".tool-pop-note")?.textContent).toBeTruthy();
    fireEvent.click(items[0] as HTMLButtonElement);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(container.querySelector('.topbar-tools [role="menu"]')).toBeNull();
  });

  it("gives each accent picker its own radio group, so the two copies never join", () => {
    const onAccentChange = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onAccentChange={onAccentChange} />));
    const button = container.querySelector(".topbar-tools .accent-tool") as HTMLButtonElement;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".accent-tray")).toBeNull();
    fireEvent.click(button);
    const swatches = Array.from(container.querySelectorAll<HTMLInputElement>(".topbar-tools .accent-tray input"));
    expect(swatches.length).toBe(6);
    // The phone copy is on the page too; one shared name would make the two
    // pickers one radio group and leave only one of them able to show a choice.
    const names = new Set(
      Array.from(container.querySelectorAll<HTMLInputElement>(".accent-tray input")).map((input) => input.name),
    );
    expect(names.size).toBe(2);
    expect(swatches.filter((swatch) => swatch.checked).map((swatch) => swatch.value)).toEqual(["madder"]);
    fireEvent.click(swatches[1] as HTMLInputElement);
    expect(onAccentChange).toHaveBeenCalledWith("woad");
    // stays open so a second lot can be compared without reopening
    expect(container.querySelector(".accent-tray")).toBeTruthy();
  });

  it("closes an open picker on Escape", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    fireEvent.click(container.querySelector(".topbar-tools .accent-tool") as HTMLButtonElement);
    expect(container.querySelector(".accent-tray")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector(".accent-tray")).toBeNull();
  });

  it("carries the build, thread count and runtime state in one identity block", () => {
    const onOpenWhatsNew = vi.fn();
    const onOpenSettings = vi.fn();
    const onOpenStatus = vi.fn();
    const { container, rerender } = render(
      withSettings(
        <Masthead
          {...mastheadProps}
          commitsSinceVersion={3}
          dirty
          onOpenWhatsNew={onOpenWhatsNew}
          offlineProgress={{ cachedBytes: 1, ready: true, totalBytes: 1 }}
          onOpenSettings={onOpenSettings}
          onOpenStatus={onOpenStatus}
          serviceWorkerStatus="active"
        />,
      ),
    );
    const buildTag = container.querySelector(".build-tag .sub-link") as HTMLButtonElement;
    expect(buildTag.textContent).toBe("v1.2.3+3*");
    fireEvent.click(buildTag);
    expect(onOpenWhatsNew).toHaveBeenCalledTimes(1);

    const threads = container.querySelector(".masthead-threads") as HTMLButtonElement;
    expect(threads.textContent).toBe("8 threads");
    expect(threads.getAttribute("aria-label")).toBe("8 threads");
    fireEvent.click(threads);
    // no deep-link handler supplied, so the thread count still just opens settings
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    const status = container.querySelector(".sub-status") as HTMLButtonElement;
    // a service worker controlling this page is `active`; `ready` is the cache
    // that is only standing by for the next load
    expect(status.dataset.sw).toBe("active");
    expect(status.getAttribute("aria-label")).toBe("Offline active");
    // The state is a word, not a lone glyph.
    expect(status.querySelector(".sub-status-text")?.textContent).toBe("Offline active");
    fireEvent.click(status);
    expect(onOpenStatus).toHaveBeenCalledTimes(1);

    rerender(
      withSettings(
        <Masthead
          {...mastheadProps}
          offlineProgress={{ cachedBytes: 25, ready: false, totalBytes: 100 }}
          serviceWorkerStatus="active"
        />,
      ),
    );
    expect(container.querySelector(".sub-status-percent")?.textContent).toBe("25%");
    // Install progress is an overlay on the block's edge, so it moves nothing.
    expect(container.querySelector(".install-rule")?.parentElement?.classList.contains("shell-head")).toBe(true);

    rerender(withSettings(<Masthead {...mastheadProps} serviceWorkerStatus="off" />));
    expect(container.querySelector(".sub-status")?.getAttribute("data-sw")).toBe("disabled");
    // an available update outranks every other runtime state
    rerender(withSettings(<Masthead {...mastheadProps} serviceWorkerStatus="active" updateReady />));
    expect(container.querySelector(".sub-status")?.getAttribute("data-sw")).toBe("update");
  });

  it("routes the thread count to the threads deep link when one is offered", () => {
    const onOpenSettings = vi.fn();
    const onOpenThreads = vi.fn();
    const { container } = render(
      withSettings(<Masthead {...mastheadProps} onOpenSettings={onOpenSettings} onOpenThreads={onOpenThreads} />),
    );

    fireEvent.click(container.querySelector(".masthead-threads") as HTMLButtonElement);
    expect(onOpenThreads).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("shows the offline-copy opt-out in the masthead status", () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{ offlineCopyEnabled: false }}>
        <Masthead
          {...mastheadProps}
          offlineProgress={{ cachedBytes: 1, ready: true, totalBytes: 1 }}
          serviceWorkerStatus="active"
        />
      </RomWeaverSettingsProvider>,
    );
    const status = container.querySelector(".sub-status");
    expect(status?.getAttribute("data-sw")).toBe("online");
    expect(status?.getAttribute("aria-label")).toBe("Offline copy disabled");
  });

  it("links pull request build tags to their pull request and channels to What's new", () => {
    const { container, getByRole, rerender } = render(
      withSettings(<Masthead {...mastheadProps} channelBadge="pr-123" />),
    );
    const badge = getByRole("link", { name: "Pull request preview, PR #123, v1.2.3" });
    expect(badge.classList.contains("channel-badge")).toBe(true);
    expect(badge.getAttribute("data-channel")).toBe("pr");
    expect(badge.getAttribute("href")).toBe("https://example.com/repo/pull/123");
    expect(badge.getAttribute("target")).toBe("_blank");
    expect(badge.querySelector(".tag-extra")?.textContent).toBe(" / v1.2.3");

    rerender(withSettings(<Masthead {...mastheadProps} channelBadge="nightly" />));
    const channel = container.querySelector(".channel-badge") as HTMLButtonElement;
    expect(channel.tagName).toBe("BUTTON");
    expect(channel.getAttribute("data-channel")).toBe("nightly");
    expect(channel.getAttribute("aria-label")).toBe("Nightly build, v1.2.3");
    expect(channel.querySelector(".tag-channel")?.textContent).toBe("nightly");
    expect(channel.textContent).toBe("nightly / v1.2.3");

    rerender(withSettings(<Masthead {...mastheadProps} channelBadge="beta" />));
    const beta = container.querySelector(".channel-badge") as HTMLButtonElement;
    expect(beta.querySelector(".tag-channel")?.textContent).toBe("beta");
    expect(beta.textContent).toBe("beta / v1.2.3");

    rerender(withSettings(<Masthead {...mastheadProps} channelBadge="dev" />));
    const dev = container.querySelector(".channel-badge") as HTMLButtonElement;
    expect(dev.querySelector(".tag-channel")?.textContent).toBe("dev");
    expect(dev.textContent).toBe("dev / v1.2.3");
  });

  it("preloads the Log dialog when Menu is about to open", () => {
    const onPreloadLog = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onPreloadLog={onPreloadLog} />));
    fireEvent.click(container.querySelector(".dock-menu") as HTMLButtonElement);
    expect(onPreloadLog).toHaveBeenCalledTimes(1);
  });

  it("preloads the settings dialog from the thread chip", () => {
    const onPreloadSettings = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onPreloadSettings={onPreloadSettings} />));
    const threads = container.querySelector(".masthead-threads") as HTMLButtonElement;
    fireEvent.pointerEnter(threads);
    fireEvent.focus(threads);
    fireEvent.pointerDown(threads);
    expect(onPreloadSettings).toHaveBeenCalledTimes(3);
  });
});

describe("Reveal", () => {
  it("drives the CSS slide via hidden + is-open", () => {
    const { container, rerender } = render(<Reveal open={false}>banner</Reveal>);
    const reveal = container.querySelector(".reveal") as HTMLElement;
    expect(reveal.hidden).toBe(true);
    expect(reveal.classList.contains("is-open")).toBe(false);
    rerender(<Reveal open>banner</Reveal>);
    expect(reveal.hidden).toBe(false);
    expect(reveal.classList.contains("is-open")).toBe(true);
  });
});

describe("UpdateBanner", () => {
  it("offers reload, release notes, and dismissal", () => {
    const onDismiss = vi.fn();
    const onOpenWhatsNew = vi.fn();
    const onReload = vi.fn();
    const { container } = render(
      withSettings(
        <UpdateBanner
          onDismiss={onDismiss}
          onOpenWhatsNew={onOpenWhatsNew}
          onReload={onReload}
          open
          title="A newer app version is ready."
        />,
      ),
    );
    const whatsNewButton = container.querySelector(".updates .updates-ver") as HTMLButtonElement;
    expect(whatsNewButton.textContent).toBe("What’s new");
    expect(whatsNewButton.getAttribute("aria-label")).toContain("A newer app version is ready.");
    fireEvent.click(whatsNewButton);
    expect(onOpenWhatsNew).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector(".updates .btn.primary") as HTMLButtonElement);
    expect(onReload).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector(".updates .banner-x") as HTMLButtonElement);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
