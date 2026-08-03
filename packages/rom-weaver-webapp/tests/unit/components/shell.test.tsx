// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { Masthead, Reveal, UpdateBanner } from "../../../src/webapp/components/shell.tsx";

/**
 * App-shell contract: the masthead tablist and the phone dock (both named
 * "Workflow" - the webapp browser test drives tabs by that role/name), the
 * brand's build/threads/runtime controls, the actions cluster, and the
 * mobile-only update banner.
 */

// The suite runs without vitest globals, so RTL cannot auto-clean between tests.
afterEach(cleanup);

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const TABS = [
  { href: "apply", icon: <svg aria-hidden="true" />, id: "patcher", label: "Apply" },
  { href: "create", icon: <svg aria-hidden="true" />, id: "creator", label: "Create" },
  { href: "trim", icon: <svg aria-hidden="true" />, id: "trim", label: "Trim" },
];

const mastheadProps = {
  currentTab: "patcher",
  homeHref: "/apply",
  donateHref: "https://example.com/donate",
  githubHref: "https://example.com/repo",
  onOpenChangelog: () => undefined,
  onOpenLog: () => undefined,
  onOpenSettings: () => undefined,
  onOpenStatus: () => undefined,
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
    expect(dock?.classList.contains("dock")).toBe(true);
    expect(rail?.querySelector(".mode-thumb")).toBeTruthy();
    expect(dock?.querySelector(".dock-thumb")).toBeTruthy();
    // "/" maps to no route, so the brand has to name one or the browser
    // hard-reloads and every staged file goes with it.
    const logoHome = getByRole("link", { name: "rom-weaver home" });
    expect(logoHome.getAttribute("href")).toBe("/apply");
    expect(logoHome.querySelector(".brand-mark")).toBeTruthy();
    expect(container.querySelector(".brand-word-link")?.getAttribute("href")).toBe("/apply");

    for (const [list, selectedClass] of [
      [rail, "mode"],
      [dock, "dock-tab"],
    ] as const) {
      const tabs = Array.from(list?.querySelectorAll('[role="tab"]') ?? []);
      expect(tabs.map((tab) => tab.textContent)).toEqual(["Apply", "Create", "Trim"]);
      expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
      expect(tabs[0]?.classList.contains(selectedClass)).toBe(true);
      // roving tabindex: exactly one reachable tab per list
      expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0").length).toBe(1);
    }

    fireEvent.click(rail?.querySelectorAll('[role="tab"]')[1] as HTMLAnchorElement);
    expect(onSelectTab).toHaveBeenCalledWith("creator");

    // github + support | theme, accent, log, settings - and Reset is gone: it
    // lives in the workflow panel head now
    expect(container.querySelectorAll(".masthead-tools .tool").length).toBe(6);
    expect(container.querySelector(".actions-sep")).toBeTruthy();
    expect(container.querySelector(".tool-support")).toBeTruthy();
    expect(container.querySelector(".accent-tool")).toBeTruthy();
    expect(container.querySelector('[aria-label="Reset"]')).toBeNull();
    expect(getByRole("button", { name: "Log" })).toBeTruthy();
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
    const onOpenChangelog = vi.fn();
    const onOpenSettings = vi.fn();
    const onOpenStatus = vi.fn();
    const { container, rerender } = render(
      withSettings(
        <Masthead
          {...mastheadProps}
          commitsSinceVersion={3}
          dirty
          onOpenChangelog={onOpenChangelog}
          onOpenSettings={onOpenSettings}
          onOpenStatus={onOpenStatus}
          serviceWorkerStatus="active"
        />,
      ),
    );
    const buildTag = container.querySelector(".build-tag .sub-link") as HTMLButtonElement;
    expect(buildTag.textContent).toBe("v1.2.3+3*");
    fireEvent.click(buildTag);
    expect(onOpenChangelog).toHaveBeenCalledTimes(1);

    const threads = container.querySelector(".masthead-threads") as HTMLButtonElement;
    expect(threads.textContent).toBe("8T");
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

  it("links pull request build tags to their pull request and channels to the changelog", () => {
    const { container, getByRole, rerender } = render(
      withSettings(<Masthead {...mastheadProps} channelBadge="pr-123" />),
    );
    const badge = getByRole("link", { name: "Pull request preview, PR #123, v1.2.3" });
    expect(badge.classList.contains("channel-badge")).toBe(true);
    expect(badge.getAttribute("data-channel")).toBe("pr");
    expect(badge.getAttribute("href")).toBe("https://example.com/repo/pull/123");
    expect(badge.getAttribute("target")).toBe("_blank");

    rerender(withSettings(<Masthead {...mastheadProps} channelBadge="nightly" />));
    const channel = container.querySelector(".channel-badge") as HTMLButtonElement;
    expect(channel.tagName).toBe("BUTTON");
    expect(channel.getAttribute("data-channel")).toBe("nightly");
    expect(channel.getAttribute("aria-label")).toBe("Nightly build, v1.2.3");
    expect(channel.querySelector(".tag-letter")?.textContent).toBe("N");
  });

  it("preloads the Log dialog before interaction completes", () => {
    const onPreloadLog = vi.fn();
    const { getByRole } = render(withSettings(<Masthead {...mastheadProps} onPreloadLog={onPreloadLog} />));
    const log = getByRole("button", { name: "Log" });
    fireEvent.pointerEnter(log);
    fireEvent.focus(log);
    fireEvent.pointerDown(log);
    expect(onPreloadLog).toHaveBeenCalledTimes(3);
  });

  it("keeps GitHub and Support in the masthead, with no footer to duplicate them", () => {
    const { container, getByRole } = render(withSettings(<Masthead {...mastheadProps} />));
    expect(getByRole("link", { name: "View source on GitHub" }).closest(".masthead-tools")).toBeTruthy();
    expect(getByRole("link", { name: "Support" }).getAttribute("href")).toBe("https://example.com/donate");
    expect(container.querySelector(".site-footer")).toBeNull();
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
    const { getByRole } = render(withSettings(<Masthead {...mastheadProps} onPreloadSettings={onPreloadSettings} />));
    const settings = getByRole("button", { name: "Settings" });
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
  it("is a single direct reload action, and renders nothing when closed", () => {
    const onReload = vi.fn();
    const { container, rerender } = render(withSettings(<UpdateBanner onReload={onReload} open={false} />));
    expect(container.querySelector(".update-banner")).toBeNull();
    rerender(withSettings(<UpdateBanner onReload={onReload} open />));
    const banner = container.querySelector(".update-banner") as HTMLButtonElement;
    expect(banner.textContent).toContain("Update available");
    expect(banner.textContent).toContain("Reload now");
    // no dismiss: the amber brand-line status is the persistent desktop notice
    expect(container.querySelector(".banner-x")).toBeNull();
    fireEvent.click(banner);
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
