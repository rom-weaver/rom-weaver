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
    // Build facts stay with the title in both layouts.
    expect(container.querySelectorAll("h1").length).toBe(1);
    expect(container.querySelectorAll(".brand").length).toBe(1);
    expect(container.querySelectorAll(".masthead-threads").length).toBe(1);
    expect(container.querySelectorAll(".sub-status").length).toBe(2);
    expect(container.querySelector(".brand-copy .build-facts")).toBeTruthy();

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

  it("spends Escape on the sheet when the open popover is the chrome's, not the sheet's", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    // Keyboard activation fires click with no pointerdown, so the brand-row
    // popover is still mounted when the sheet opens over it. It is inert behind
    // the sheet, so it MUST NOT claim the press the sheet is waiting for.
    fireEvent.click(container.querySelector('.shell-head-tools .tool[aria-label^="Theme"]') as HTMLButtonElement);
    fireEvent.click(container.querySelector(".dock-menu") as HTMLButtonElement);
    const sheet = container.querySelector(".menu-sheet") as HTMLElement;
    expect(sheet.hidden).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(sheet.hidden).toBe(true);
  });

  it("spends Escape on the sheet's own popover before the sheet", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    fireEvent.click(container.querySelector(".dock-menu") as HTMLButtonElement);
    const sheet = container.querySelector(".menu-sheet") as HTMLElement;
    fireEvent.click(sheet.querySelector(".nav-appearance .accent-tool") as HTMLButtonElement);
    expect(sheet.querySelector(".accent-tray")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(sheet.querySelector(".accent-tray")).toBeNull();
    expect(sheet.hidden).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(sheet.hidden).toBe(true);
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

  it("opens only the accent picker that was pressed", () => {
    const onAccentChange = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onAccentChange={onAccentChange} />));
    const button = container.querySelector(".topbar-tools .accent-tool") as HTMLButtonElement;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".accent-tray")).toBeNull();
    fireEvent.click(button);
    const swatches = Array.from(container.querySelectorAll<HTMLInputElement>(".topbar-tools .accent-tray input"));
    expect(swatches.length).toBe(6);
    // Four copies of the pair are on the page: the chrome copy and the nav copy
    // of each layout. A key of "accent" alone opened every one of them at once.
    expect(container.querySelectorAll(".accent-tray").length).toBe(1);
    expect(swatches.filter((swatch) => swatch.checked).map((swatch) => swatch.value)).toEqual(["madder"]);
    fireEvent.click(swatches[1] as HTMLInputElement);
    expect(onAccentChange).toHaveBeenCalledWith("woad");
    // stays open so a second lot can be compared without reopening
    expect(container.querySelector(".accent-tray")).toBeTruthy();
  });

  it("gives every accent picker its own radio group, so the copies never join", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    fireEvent.click(container.querySelector(".dock-menu") as HTMLButtonElement);
    const names = Array.from(container.querySelectorAll<HTMLButtonElement>(".accent-tool")).map((button) => {
      fireEvent.click(button);
      const input = container.querySelector<HTMLInputElement>(".accent-tray input");
      fireEvent.click(button);
      return input?.name;
    });
    // One shared name would make the pickers one radio group and leave only one
    // of them able to show a choice.
    expect(names.length).toBe(4);
    expect(new Set(names).size).toBe(4);
  });

  it("names theme and accent inside the navigation as well as in the chrome", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    // The sheet's copy waits for the sheet, so the prerendered shell carries
    // only the sidebar's.
    expect(container.querySelectorAll(".nav-appearance").length).toBe(1);
    fireEvent.click(container.querySelector(".dock-menu") as HTMLButtonElement);
    const blocks = Array.from(container.querySelectorAll(".nav-appearance"));
    // One for the desktop sidebar's foot, one for the phone Menu sheet's foot.
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      expect(block.querySelector(".nav-group-label")?.textContent).toBe("Appearance");
      expect(block.querySelectorAll('.tool[aria-label^="Theme"]').length).toBe(1);
      expect(block.querySelectorAll(".accent-tool").length).toBe(1);
    }
  });

  it("commits an appearance choice from the phone header copy too", () => {
    const onAccentChange = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onAccentChange={onAccentChange} />));
    // A press inside the copy the phone layout shows must not count as an
    // outside press: that closed the popover on pointerdown, so the click
    // never reached the choice and nothing was ever committed.
    const tile = container.querySelector(".shell-head-tools .accent-tool") as HTMLButtonElement;
    fireEvent.click(tile);
    const swatch = container.querySelectorAll<HTMLInputElement>(".shell-head-tools .accent-tray input")[1];
    fireEvent.pointerDown(swatch as HTMLInputElement);
    expect(container.querySelector(".shell-head-tools .accent-tray")).toBeTruthy();
    fireEvent.click(swatch as HTMLInputElement);
    expect(onAccentChange).toHaveBeenCalledWith("woad");
  });

  it("keeps a row's accessible name containing the label it shows", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    for (const row of container.querySelectorAll<HTMLElement>(".side-nav .nav-row")) {
      const visible = row.querySelector(".nav-row-label")?.textContent ?? "";
      // WCAG 2.5.3: a speech user says what they can read, so the accessible
      // name has to contain it. "Saves" is not contained in "Save Editor".
      expect((row.getAttribute("aria-label") ?? visible).toLowerCase()).toContain(visible.toLowerCase());
    }
    expect(container.querySelector('.nav-row[href="save-editor"]')?.getAttribute("aria-label")).toBeNull();
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
    // The chip owns the percent; the wording beside it MUST NOT repeat it.
    expect(container.querySelector(".sub-status-text")?.textContent).toBe("Installing offline copy");
    // The accessible name replaces the chip rather than adding to it, so it is
    // the one place that still has to carry the number.
    expect(container.querySelector(".sub-status")?.getAttribute("aria-label")).toBe("Installing offline copy: 25%");
    expect(container.querySelector(".install-rule")).toBeNull();

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
    expect(channel.getAttribute("aria-label")).toBe("Nightly build, v1.2.3n");
    expect(channel.querySelector(".tag-channel")).toBeNull();
    expect(channel.textContent).toBe("v1.2.3n");

    rerender(withSettings(<Masthead {...mastheadProps} channelBadge="beta" />));
    const beta = container.querySelector(".channel-badge") as HTMLButtonElement;
    expect(beta.querySelector(".tag-channel")).toBeNull();
    expect(beta.textContent).toBe("v1.2.3b");

    rerender(withSettings(<Masthead {...mastheadProps} channelBadge="dev" />));
    const dev = container.querySelector(".channel-badge") as HTMLButtonElement;
    expect(dev.querySelector(".tag-channel")).toBeNull();
    expect(dev.textContent).toBe("v1.2.3d");

    rerender(withSettings(<Masthead {...mastheadProps} channelBadge="dev" commitsSinceVersion={3} dirty />));
    expect((container.querySelector(".channel-badge") as HTMLButtonElement).textContent).toBe("v1.2.3d+3*");
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
