// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { Masthead, Reveal, Selvage, UpdateBanner } from "../../../src/webapp/components/shell.tsx";

/**
 * App-shell contract: the masthead tablist (named "Workflow" - the webapp
 * browser test drives tabs by that role/name), tool buttons, the reveal
 * banner mechanics, and the selvage status strip.
 */

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const TABS = [
  { icon: <svg aria-hidden="true" />, id: "patcher", label: "Apply" },
  { icon: <svg aria-hidden="true" />, id: "creator", label: "Create" },
  { icon: <svg aria-hidden="true" />, id: "trim", label: "Trim" },
];

const mastheadProps = {
  branch: "prototype/mobile-forward-ui",
  commit: "71f6a6c6",
  donateHref: "https://example.com/donate",
  currentTab: "patcher",
  onOpenLog: () => undefined,
  onReportIssue: () => undefined,
  onReset: () => undefined,
  onOpenSettings: () => undefined,
  onSelectTab: () => undefined,
  tabs: TABS,
  threads: 8,
  version: "1.2.3",
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
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Apply", "Create", "Trim"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tabs[1] as HTMLButtonElement);
    expect(onSelectTab).toHaveBeenCalledWith("creator");
    // reset is the leftmost utility; settings remains the rightmost
    expect(container.querySelectorAll(".masthead-tools .tool").length).toBe(6);
    expect(container.querySelector(".language-tool")).toBeNull();
    expect(getByRole("button", { name: "Log" })).toBeTruthy();
    expect(getByRole("button", { name: "Report issue" })).toBeTruthy();
    const reset = getByRole("button", { name: "Reset" });
    expect(container.querySelector(".masthead-tools > .tool")).toBe(reset);
    const settings = getByRole("button", { name: "Settings" });
    expect(container.querySelector(".masthead-tools > .tool:last-child")).toBe(settings);
    expect(container.querySelector(".masthead-version")?.textContent).toBe("v1.2.3· 8 threads");
    fireEvent.click(getByRole("button", { name: "Build information for v1.2.3" }));
    expect(document.body.querySelector(".build-version-pop")?.textContent).toContain("prototype/mobile-forward-ui");
    expect(document.body.querySelector(".build-version-pop")?.textContent).toContain("71f6a6c6");
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
    expect(container.querySelector(".updates .updates-ver-full")?.textContent).toBe("v1 → v2");
    expect(container.querySelector(".updates .updates-ver-mobile")?.textContent).toBe("What’s new");
    fireEvent.click(container.querySelector(".updates .updates-ver") as HTMLButtonElement);
    expect(onShowChangelog).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector(".updates .btn.primary") as HTMLButtonElement);
    expect(onReload).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector(".updates .banner-x") as HTMLButtonElement);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("Selvage", () => {
  it("renders version, threads, and links", () => {
    const { container } = render(
      withSettings(
        <Selvage
          donateHref="https://example.com/donate"
          githubHref="https://example.com/repo"
          threads={8}
          version="1.2.3"
        />,
      ),
    );
    expect(container.querySelector(".sv-meta")?.textContent).toBe("v1.2.3");
    expect(container.querySelector(".sv-threads")?.textContent).toContain("8");
    expect(container.querySelector(".sv-link.donate")).toBeTruthy();
  });

  it("omits threads when none are provided", () => {
    const { container } = render(withSettings(<Selvage version="1.2.3" />));
    expect(container.querySelector(".sv-threads")).toBeNull();
  });
});
