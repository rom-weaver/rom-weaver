// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { Masthead, Reveal, SiteFooter, UpdateBanner } from "../../../src/webapp/components/shell.tsx";

/**
 * App-shell contract: the masthead tablist (named "Workflow" - the webapp
 * browser test drives tabs by that role/name), tool buttons, and the reveal /
 * update banner mechanics.
 */

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const TABS = [
  { href: "weave", icon: <svg aria-hidden="true" />, id: "patcher", label: "Weave" },
  { href: "create", icon: <svg aria-hidden="true" />, id: "creator", label: "Create" },
  { href: "trim", icon: <svg aria-hidden="true" />, id: "trim", label: "Trim" },
];

const mastheadProps = {
  currentTab: "patcher",
  githubHref: "https://example.com/repo",
  onOpenLog: () => undefined,
  onReset: () => undefined,
  onOpenSettings: () => undefined,
  onSelectTab: () => undefined,
  tabs: TABS,
};

const buildStatusProps = {
  commitHash: "a1b2c3d4e5f6",
  commitsSinceVersion: 3,
  dirty: true,
  donateHref: "https://example.com/donate",
  githubHref: "https://example.com/repo",
  legalHref: "/docs/notices",
  privacyHref: "/docs/privacy",
  threads: 8,
  version: "1.2.3",
  versionTitle: "v1.2.3+main.dirty.a1b2c3d",
};

describe("Masthead", () => {
  it("renders the Workflow tablist with the selected mode and the tool buttons", () => {
    const onSelectTab = vi.fn();
    const onReset = vi.fn();
    const { container, getByRole } = render(
      withSettings(<Masthead {...mastheadProps} onReset={onReset} onSelectTab={onSelectTab} />),
    );
    const rail = getByRole("tablist", { name: "Workflow" });
    expect(rail.classList.contains("mode-rail")).toBe(true);
    expect(rail.querySelector(".mode-thumb")).toBeTruthy();
    const logoHome = getByRole("link", { name: "Home" });
    expect(logoHome.getAttribute("href")).toBe("/");
    expect(logoHome.querySelector(".brand-mark")).toBeTruthy();
    const nameHome = getByRole("link", { name: "rom-weaver home" });
    expect(nameHome.getAttribute("href")).toBe("/");
    expect(nameHome.querySelector(".brand-word")).toBeTruthy();
    const tabs = Array.from(rail.querySelectorAll('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Weave", "Create", "Trim"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("href")).toBe("create");
    fireEvent.click(tabs[1] as HTMLAnchorElement);
    expect(onSelectTab).toHaveBeenCalledWith("creator");
    expect(container.querySelectorAll(".masthead-tools .tool").length).toBe(5);
    // the accent picker sits in an anchor, so it is not a direct child
    expect(container.querySelectorAll(".masthead-tools > .tool").length).toBe(4);
    expect(container.querySelector(".accent-tool")).toBeTruthy();
    // language is a settings-only field; the masthead carries no picker for it
    expect(container.querySelector('[aria-label="Language"]')).toBeNull();
    expect(container.querySelector(".masthead-tools .masthead-link")).toBeNull();
    expect(getByRole("button", { name: "Log" })).toBeTruthy();
    const reset = getByRole("button", { name: "Reset" });
    expect(container.querySelector(".masthead-version")).toBeNull();
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("keeps diagnostics in the Log dialog", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    expect(container.querySelector(".console-copy-toggle")).toBeNull();
    expect(container.querySelector(".mobile-devtools-toggle")).toBeNull();
    expect(container.querySelector(".masthead-version")).toBeNull();
  });

  it("links pull request build badges to their pull request", () => {
    const { container, getByRole, rerender } = render(
      withSettings(<Masthead {...mastheadProps} channelBadge="pr-123" />),
    );
    const badge = getByRole("link", { name: "Open pull request 123" });
    expect(badge.classList.contains("channel-badge")).toBe(true);
    expect(badge.classList.contains("channel-badge-link")).toBe(true);
    expect(badge.getAttribute("href")).toBe("https://example.com/repo/pull/123");
    expect(badge.getAttribute("target")).toBe("_blank");

    rerender(withSettings(<Masthead {...mastheadProps} channelBadge="nightly" />));
    expect(container.querySelector(".channel-badge")?.tagName).toBe("SPAN");
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

  it("shows build metadata and service worker status in the footer", () => {
    const { container, getByRole, rerender } = render(
      withSettings(<SiteFooter {...buildStatusProps} serviceWorkerStatus="active" />),
    );
    const runtimeStatus = container.querySelector(".masthead-runtime");
    expect(runtimeStatus?.textContent).toBe("· web · sw");
    expect(runtimeStatus?.closest(".site-footer")).toBeTruthy();
    expect(runtimeStatus?.getAttribute("title")).toBe(
      "This page is controlled by the service worker and its offline cache is available.",
    );
    expect(container.querySelector(".runtime-badge")).toBeNull();
    expect(container.querySelector(".masthead-threads-full")?.textContent).toBe("· 8 threads");
    expect(container.querySelector(".masthead-threads-short")?.textContent).toBe("· 8T");
    expect(container.querySelector(".masthead-threads .sr-only")?.textContent).toBe("8 threads");
    expect(container.querySelector(".masthead-threads")?.getAttribute("title")).toBe("8 threads");
    const version = getByRole("link", { name: "v1.2.3+3" });
    expect(version.getAttribute("href")).toBe("https://example.com/repo/releases/tag/v1.2.3");
    const commit = getByRole("link", { name: "a1b2c3d" });
    expect(commit.getAttribute("href")).toBe("https://example.com/repo/commit/a1b2c3d4e5f6");
    expect(container.querySelector(".build-version-label")?.textContent).toBe("v1.2.3+3 · a1b2c3d*");
    expect(container.querySelector(".build-version-label")?.getAttribute("title")).toBe("v1.2.3+main.dirty.a1b2c3d");
    const github = getByRole("link", { name: "GitHub" });
    expect(github.closest(".site-footer-links")).toBeTruthy();
    expect(getByRole("link", { name: "Support" }).getAttribute("href")).toBe("https://example.com/donate");
    expect(getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe("/docs/privacy");
    expect(getByRole("link", { name: "Legal" }).getAttribute("href")).toBe("/docs/notices");
    rerender(withSettings(<SiteFooter {...buildStatusProps} serviceWorkerStatus="ready" />));
    expect(container.querySelector(".masthead-runtime")?.textContent).toBe("· web · sw");
    rerender(withSettings(<SiteFooter {...buildStatusProps} serviceWorkerStatus="off" />));
    expect(container.querySelector(".masthead-runtime")?.textContent).toBe("· web · sw off");
    expect(container.querySelector(".masthead-runtime")?.getAttribute("title")).toBe(
      "Service-worker offline support is unavailable.",
    );
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
  it("offers reload from the compact notice and opens release notes", () => {
    const onDismiss = vi.fn();
    const onReload = vi.fn();
    const onShowChangelog = vi.fn();
    const { container } = render(
      withSettings(
        <UpdateBanner
          onDismiss={onDismiss}
          onReload={onReload}
          onShowChangelog={onShowChangelog}
          open
          title="v1 → v2"
        />,
      ),
    );
    const changelogButton = container.querySelector(".updates .updates-ver") as HTMLButtonElement;
    expect(changelogButton.textContent).toBe("What’s new");
    expect(changelogButton.getAttribute("aria-label")).toContain("v1 → v2");
    fireEvent.click(changelogButton);
    expect(onShowChangelog).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector(".updates .btn.primary") as HTMLButtonElement);
    expect(onReload).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector(".updates .banner-x") as HTMLButtonElement);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
