// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { Masthead, Reveal, UpdateBanner } from "../../../src/webapp/components/shell.tsx";

/**
 * App-shell contract: the masthead tablist (named "Workflow" - the webapp
 * browser test drives tabs by that role/name), tool buttons, and the reveal /
 * update banner mechanics.
 */

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const TABS = [
  { icon: <svg aria-hidden="true" />, id: "patcher", label: "Weave" },
  { icon: <svg aria-hidden="true" />, id: "creator", label: "Make Patch" },
  { icon: <svg aria-hidden="true" />, id: "trim", label: "Trim" },
];

const mastheadProps = {
  donateHref: "https://example.com/donate",
  githubHref: "https://example.com/repo",
  currentTab: "patcher",
  onOpenLog: () => undefined,
  onReset: () => undefined,
  onOpenSettings: () => undefined,
  onSelectTab: () => undefined,
  tabs: TABS,
  threads: 8,
  version: "v1.2.3 · main* · a1b2c3d",
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
    const tabs = Array.from(rail.querySelectorAll('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Weave", "Make Patch", "Trim"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tabs[1] as HTMLButtonElement);
    expect(onSelectTab).toHaveBeenCalledWith("creator");
    // the external links (GitHub then Donate) lead the row; a separator fences
    // them off from the app tools (Reset, Theme, Log, Settings) that trail
    expect(container.querySelectorAll(".masthead-tools .tool").length).toBe(6);
    expect(container.querySelector(".language-tool")).toBeNull();
    expect(getByRole("button", { name: "Log" })).toBeTruthy();
    const github = getByRole("link", { name: "GitHub" });
    expect(github.getAttribute("href")).toBe("https://example.com/repo");
    expect(container.querySelector(".masthead-tools > .tool")).toBe(github);
    const donate = getByRole("link", { name: "Donate" });
    expect(container.querySelector(".masthead-tools > .tools-sep")?.previousElementSibling).toBe(donate);
    const settings = getByRole("button", { name: "Settings" });
    expect(container.querySelector(".masthead-tools > .tool:last-child")).toBe(settings);
    const reset = getByRole("button", { name: "Reset" });
    expect(container.querySelector(".masthead-version")?.textContent).toBe("v1.2.3 · main* · a1b2c3d· 8 threads");
    expect(container.querySelector(".build-version-label")?.textContent).toBe("v1.2.3 · main* · a1b2c3d");
    expect(container.querySelector(".build-version-label")?.getAttribute("title")).toBe("v1.2.3+main.dirty.a1b2c3d");
    expect(container.querySelector(".build-version-label")?.closest("button")).toBeNull();
    expect(getByRole("link", { name: "Donate" }).getAttribute("href")).toBe("https://example.com/donate");
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("keeps diagnostics in the Log dialog", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} />));
    expect(container.querySelector(".console-copy-toggle")).toBeNull();
    expect(container.querySelector(".mobile-devtools-toggle")).toBeNull();
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
