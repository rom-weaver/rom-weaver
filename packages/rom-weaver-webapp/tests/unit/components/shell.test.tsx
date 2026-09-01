// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { Masthead, Reveal, SiteFooter, UpdateBanner } from "../../../src/webapp/components/shell.tsx";
import type { WorkflowTab } from "../../../src/webapp/components/shell.tsx";

/**
 * App-shell contract: the masthead tablist and the phone dock (both named
 * "Workflow" - the webapp browser test drives tabs by that role/name), the
 * brand's build/threads/runtime controls, the actions cluster, and the
 * update banner.
 */

// The suite runs without vitest globals, so RTL cannot auto-clean between tests.
afterEach(cleanup);

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const TABS = [
  { href: "apply", icon: <svg aria-hidden="true" />, id: "patcher", label: "Apply" },
  { href: "create", icon: <svg aria-hidden="true" />, id: "creator", label: "Create" },
  { href: "test", icon: <svg aria-hidden="true" />, id: "test", label: "Test" },
  { group: "docs", href: "docs", icon: <svg aria-hidden="true" />, id: "docs", label: "Docs", placement: "more" },
  {
    beta: true,
    group: "tools",
    href: "trim",
    icon: <svg aria-hidden="true" />,
    id: "trim",
    label: "Trim",
    placement: "more",
  },
  {
    beta: true,
    group: "tools",
    href: "ppf-undo",
    icon: <svg aria-hidden="true" />,
    id: "ppf-undo",
    label: "PPF undo",
    placement: "more",
  },
] satisfies WorkflowTab[];

const mastheadProps = {
  currentTab: "patcher",
  homeHref: "/apply",
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

describe("Masthead", () => {
  it("renders the Workflow rail and dock with the selected mode and the tool buttons", () => {
    const onSelectTab = vi.fn();
    const { container, getAllByRole, getByRole } = render(
      withSettings(<Masthead {...mastheadProps} onSelectTab={onSelectTab} />),
    );
    const [rail, dock] = getAllByRole("tablist", { name: "Workflow" });
    expect(rail?.classList.contains("mode-rail")).toBe(true);
    expect(dock?.classList.contains("dock-tabs")).toBe(true);
    expect(rail?.querySelector(".mode-thumb")).toBeTruthy();
    expect(dock?.querySelector(".dock-thumb")).toBeTruthy();
    // "/" maps to no route, so the brand has to name one or the browser
    // hard-reloads and every staged file goes with it.
    const logoHome = getByRole("link", { name: "rom-weaver home" });
    expect(logoHome.getAttribute("href")).toBe("/apply");
    expect(logoHome.querySelector(".brand-mark")).toBeTruthy();
    expect(container.querySelector(".brand-word-link")?.getAttribute("href")).toBe("/apply");

    for (const [list, selectedClass, labels] of [
      [rail, "mode", ["Apply", "Create", "Test"]],
      [dock, "dock-tab", ["Apply", "Create", "Test"]],
    ] as const) {
      const tabs = Array.from(list?.querySelectorAll('[role="tab"]') ?? []);
      expect(tabs.map((tab) => tab.textContent)).toEqual(labels);
      expect(list?.querySelector('[data-mode="docs"]')).toBeNull();
      expect(list?.querySelector('[data-mode="trim"]')).toBeNull();
      expect(list?.querySelector('[data-mode="ppf-undo"]')).toBeNull();
      expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
      expect(tabs[0]?.classList.contains(selectedClass)).toBe(true);
      // roving tabindex: exactly one reachable tab per list
      expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0").length).toBe(1);
    }

    fireEvent.click(rail?.querySelectorAll('[role="tab"]')[1] as HTMLAnchorElement);
    expect(onSelectTab).toHaveBeenCalledWith("creator");

    // status, theme, accent, settings - external actions live in the shared
    // footer, Reset lives in the workflow panel head, and More is nav level
    expect(container.querySelectorAll(".masthead-tools .tool").length).toBe(4);
    expect(container.querySelector(".actions-sep")).toBeNull();
    expect(container.querySelector(".tool-support")).toBeNull();
    expect(container.querySelector(".accent-tool")).toBeTruthy();
    expect(container.querySelector('[aria-label="Reset"]')).toBeNull();
    // More shares the visual rail, but it is never a tab in the tablist.
    expect(container.querySelector(".mode-rail-shell > .desktop-more .mode-more")).toBeTruthy();
    expect(container.querySelector('.mode-rail [aria-haspopup="menu"]')).toBeNull();
  });

  it("only lands focus on the first menu item when More is opened by keyboard", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    const more = container.querySelector(".desktop-more .mode-more") as HTMLButtonElement;

    // A pointer open parks focus on the menu box, so no row wears a focus ring.
    fireEvent.pointerDown(more);
    fireEvent.click(more);
    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(menu);

    fireEvent.pointerDown(more);
    fireEvent.click(more);

    // Enter and Space fire click with no preceding pointerdown.
    fireEvent.click(more);
    const firstItem = container.querySelector('[role="menu"] [role="menuitem"]');
    expect(document.activeElement).toBe(firstItem);
  });

  it("keeps utility destinations behind More on both layouts", () => {
    const onOpenStorage = vi.fn();
    const { container, getByRole } = render(
      withSettings(
        <Masthead
          {...mastheadProps}
          offlineProgress={{ cachedBytes: 1, ready: true, totalBytes: 1 }}
          onOpenStorage={onOpenStorage}
          serviceWorkerStatus="active"
        />,
      ),
    );
    const more = container.querySelector(".desktop-more .mode-more") as HTMLButtonElement;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="menu"]')).toBeNull();

    fireEvent.click(more);
    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(menu.hidden).toBe(false);
    const menuStatus = getByRole("menuitem", { name: "Status" });
    expect(menuStatus.classList.contains("more-status")).toBe(true);
    expect(menuStatus.getAttribute("data-sw")).toBe("active");
    expect(menuStatus.querySelector("svg")?.innerHTML).toBe(container.querySelector(".sub-status svg")?.innerHTML);
    // Docs and the beta tools file under their own headed groups.
    // Real links: a middle-click or "open in new tab" still reaches the route.
    expect(getByRole("menuitem", { name: "Docs" }).getAttribute("href")).toBe("docs");
    // With the selected workflow in the rail, More is not "you are here".
    expect(more.classList.contains("is-current")).toBe(false);
    expect(getByRole("menuitem", { name: "Trim Beta" })).toBeTruthy();
    expect(getByRole("menuitem", { name: "PPF undo Beta" })).toBeTruthy();
    expect(getByRole("group", { name: "Tools" })).toBeTruthy();
    expect(getByRole("group", { name: "Docs" })).toBeTruthy();
    expect(getByRole("group", { name: "Project" })).toBeTruthy();
    expect(getByRole("menuitem", { name: "What\u2019s new" })).toBeTruthy();
    // The head row keeps the app's own surfaces one tap away on desktop too.
    expect(getByRole("menuitem", { name: "Settings" }).classList.contains("more-head-item")).toBe(true);
    fireEvent.click(getByRole("menuitem", { name: "Storage" }));
    expect(onOpenStorage).toHaveBeenCalledTimes(1);
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("marks More current when the selected workflow lives inside it", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} currentTab="docs" />));
    expect(container.querySelector(".desktop-more .mode-more.is-current")).not.toBeNull();
    expect(container.querySelector(".mobile-more .dock-action.is-current")).not.toBeNull();
  });

  it("activates a tab with Space as well as Enter", () => {
    const onSelectTab = vi.fn();
    const { getAllByRole } = render(withSettings(<Masthead {...mastheadProps} onSelectTab={onSelectTab} />));
    const rail = getAllByRole("tablist", { name: "Workflow" })[0] as HTMLElement;
    fireEvent.keyDown(rail, { key: " " });
    expect(onSelectTab).toHaveBeenCalledWith("patcher");
    fireEvent.keyDown(rail, { key: "ArrowRight" });
    expect(onSelectTab).toHaveBeenCalledWith("creator");
  });

  it("carries the build, thread count and runtime state on the brand sub-line", () => {
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
    expect(threads.textContent).toBe("8 Threads");
    expect(threads.getAttribute("aria-label")).toBe("8 threads");
    fireEvent.click(threads);
    // no deep-link handler supplied, so the thread count still just opens settings
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    const status = container.querySelector(".sub-status") as HTMLButtonElement;
    // a service worker controlling this page is `active`; `ready` is the cache
    // that is only standing by for the next load
    expect(status.dataset.sw).toBe("active");
    expect(status.getAttribute("aria-label")).toBe("Offline active");
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
    expect(container.querySelector(".masthead-status-percent")?.textContent).toBe("25%");
    expect(container.querySelector(".sub-status")?.getAttribute("aria-label")).toBe("Installing offline copy — 25%");

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

  it("preloads the Log dialog before interaction completes", () => {
    const onPreloadLog = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onPreloadLog={onPreloadLog} />));
    const more = container.querySelector(".desktop-more .mode-more") as HTMLButtonElement;
    fireEvent.pointerEnter(more);
    fireEvent.focus(more);
    fireEvent.pointerDown(more);
    expect(onPreloadLog).toHaveBeenCalledTimes(3);
  });

  it("renders GitHub and Support in the shared footer", () => {
    const { container, getByRole } = render(
      withSettings(
        <>
          <Masthead {...mastheadProps} />
          <SiteFooter docsHref="docs" donateHref="https://example.com/donate" githubHref="https://example.com/repo" />
        </>,
      ),
    );
    const footer = container.querySelector(".site-footer");
    expect(footer).toBeTruthy();
    expect(getByRole("link", { name: "View source on GitHub" }).closest(".site-footer")).toBe(footer);
    expect(getByRole("link", { name: "View source on GitHub" }).getAttribute("href")).toBe("https://example.com/repo");
    expect(getByRole("link", { name: "Support" }).closest(".site-footer")).toBe(footer);
    expect(getByRole("link", { name: "Support" }).getAttribute("href")).toBe("https://example.com/donate");
    // The one crawlable path to the guides now that the rail has no Docs tab.
    expect(getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("docs");
    expect(container.querySelector(".masthead-tools a")).toBeNull();
  });

  it("commits an accent straight from the masthead tray", () => {
    const onAccentChange = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onAccentChange={onAccentChange} />));
    const button = container.querySelector(".accent-tool") as HTMLButtonElement;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".accent-tray")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const swatches = Array.from(container.querySelectorAll<HTMLInputElement>(".accent-tray input"));
    expect(swatches.length).toBe(6);
    expect(swatches.filter((swatch) => swatch.checked).map((swatch) => swatch.value)).toEqual(["madder"]);
    fireEvent.click(swatches[1] as HTMLInputElement);
    expect(onAccentChange).toHaveBeenCalledWith("woad");
    // stays open so a second lot can be compared without reopening
    expect(container.querySelector(".accent-tray")).toBeTruthy();
  });

  it("closes an open picker on Escape", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    fireEvent.click(container.querySelector(".accent-tool") as HTMLButtonElement);
    expect(container.querySelector(".accent-tray")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector(".accent-tray")).toBeNull();
  });

  it("preloads Settings before interaction completes", () => {
    const onPreloadSettings = vi.fn();
    const { container } = render(withSettings(<Masthead {...mastheadProps} onPreloadSettings={onPreloadSettings} />));
    const settings = container.querySelector(".masthead-settings") as HTMLButtonElement;
    fireEvent.pointerEnter(settings);
    fireEvent.focus(settings);
    fireEvent.pointerDown(settings);
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
