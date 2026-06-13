// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { Masthead, Reveal, Selvage, UpdateBanner } from "../../../src/webapp/components/shell.tsx";

/**
 * App-shell contract: the masthead tablist (named "Workflow" — the webapp
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
  currentTab: "patcher",
  devToolsEnabled: false,
  onCopyConsoleLogs: () => Promise.resolve(),
  onOpenLog: () => undefined,
  onOpenSettings: () => undefined,
  onSelectTab: () => undefined,
  onToggleMobileDevTools: () => undefined,
  tabs: TABS,
};

describe("Masthead", () => {
  it("renders the Workflow tablist with the selected mode and the tool buttons", () => {
    const onSelectTab = vi.fn();
    const { container, getByRole } = render(
      withSettings(<Masthead {...mastheadProps} onSelectTab={onSelectTab} />),
    );
    const rail = getByRole("tablist", { name: "Workflow" });
    expect(rail.classList.contains("mode-rail")).toBe(true);
    expect(rail.querySelector(".mode-thumb")).toBeTruthy();
    const tabs = Array.from(rail.querySelectorAll('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Apply", "Create", "Trim"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tabs[1] as HTMLButtonElement);
    expect(onSelectTab).toHaveBeenCalledWith("creator");
    // theme + log + settings tools always present
    expect(container.querySelectorAll(".masthead-tools .tool").length).toBe(3);
  });

  it("shows the console-copy tool only when dev tools are enabled", () => {
    const { container } = render(withSettings(<Masthead {...mastheadProps} devToolsEnabled />));
    expect(container.querySelector(".console-copy-toggle")).toBeTruthy();
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
  it("offers reload and dismiss for a pending update", () => {
    const onReload = vi.fn();
    const onDismiss = vi.fn();
    const { container } = render(
      withSettings(<UpdateBanner onDismiss={onDismiss} onReload={onReload} open title="v1 → v2" />),
    );
    expect(container.querySelector(".updates .updates-ver")?.textContent).toBe("v1 → v2");
    fireEvent.click(container.querySelector(".updates .btn.primary") as HTMLButtonElement);
    expect(onReload).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector(".updates .banner-x") as HTMLButtonElement);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("Selvage", () => {
  it("renders the status dot, metadata, and links", () => {
    const { container } = render(
      withSettings(
        <Selvage
          cacheLabel="cache v18"
          donateHref="https://example.com/donate"
          githubHref="https://example.com/repo"
          stage="Apply — track 1"
          state="running"
          threads={8}
          version="1.2.3"
        />,
      ),
    );
    const state = container.querySelector(".sv-state");
    expect(state?.classList.contains("running")).toBe(true);
    expect(container.querySelector(".sv-stage")?.textContent).toBe("Apply — track 1");
    expect(container.querySelector(".sv-threads")?.textContent).toContain("8");
    expect(container.querySelector(".sv-cache")?.textContent).toBe("cache v18");
    expect(container.querySelector(".sv-link.donate")).toBeTruthy();
  });

  it("keeps the dot neutral while idle", () => {
    const { container } = render(withSettings(<Selvage state="idle" />));
    const state = container.querySelector(".sv-state");
    expect(state?.className).toBe("sv-state");
  });
});
