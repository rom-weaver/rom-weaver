// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { Masthead } from "../../../src/webapp/components/shell.tsx";
import type { WorkflowTab } from "../../../src/webapp/components/shell.tsx";

afterEach(cleanup);

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const TABS = [
  { href: "apply", icon: <svg aria-hidden="true" />, id: "patcher", label: "Apply" },
  { href: "create", icon: <svg aria-hidden="true" />, id: "creator", label: "Create" },
  { href: "test", icon: <svg aria-hidden="true" />, id: "test", label: "Test" },
] satisfies WorkflowTab[];

const props = {
  currentTab: "patcher",
  githubHref: "https://example.com/repo",
  homeHref: "/apply",
  onOpenChangelog: () => undefined,
  onOpenLog: () => undefined,
  onOpenSettings: () => undefined,
  onOpenStatus: () => undefined,
  onSelectTab: () => undefined,
  tabs: TABS,
  version: "1.2.3",
};

const findInput = (container: HTMLElement) => container.querySelector(".find-input") as HTMLInputElement;

describe("Find", () => {
  it("opens from the rail trigger with the browse list and focus in the box", () => {
    const { container, getByRole } = render(withSettings(<Masthead {...props} />));
    expect(container.querySelector(".find-palette")).toBeNull();
    // Find and More share the rail's trailing slot; neither is a tab.
    expect(container.querySelector('.mode-rail [aria-haspopup="dialog"]')).toBeNull();

    fireEvent.click(container.querySelector(".desktop-find .mode-find") as HTMLButtonElement);

    expect(document.activeElement).toBe(findInput(container));
    const options = getByRole("listbox", { name: "Find" }).querySelectorAll('[role="option"]');
    expect(options[0]?.textContent).toContain("Apply");
    expect(Array.from(options).map((option) => option.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Status"), expect.stringContaining("Settings")]),
    );
  });

  it("opens with Ctrl+K and closes on Escape, returning focus to the trigger", () => {
    const { container } = render(withSettings(<Masthead {...props} />));
    fireEvent.keyDown(document, { ctrlKey: true, key: "k" });
    expect(container.querySelector(".find-palette")).not.toBeNull();

    fireEvent.keyDown(findInput(container), { key: "Escape" });

    expect(container.querySelector(".find-palette")).toBeNull();
    // Focus returns to whichever Find trigger the layout shows.
    expect(
      document.activeElement?.classList.contains("dock-find") ||
        document.activeElement?.classList.contains("mode-find"),
    ).toBe(true);
  });

  it("filters as you type and opens a tool with Enter", () => {
    const onSelectTab = vi.fn();
    const { container, getByRole } = render(withSettings(<Masthead {...props} onSelectTab={onSelectTab} />));
    fireEvent.click(container.querySelector(".desktop-find .mode-find") as HTMLButtonElement);
    fireEvent.change(findInput(container), { target: { value: "crea" } });

    const first = getByRole("listbox", { name: "Find" }).querySelector('[role="option"]');
    expect(first?.textContent).toContain("Create");
    expect(first?.querySelector(".find-kind")?.textContent).toBe("Tool");
    fireEvent.keyDown(findInput(container), { key: "Enter" });

    expect(onSelectTab).toHaveBeenCalledWith("creator");
    expect(container.querySelector(".find-palette")).toBeNull();
  });

  it("deep-links a setting through the field handler", () => {
    const onOpenSettingsField = vi.fn();
    const { container, getByRole } = render(
      withSettings(<Masthead {...props} onOpenSettingsField={onOpenSettingsField} />),
    );
    fireEvent.click(container.querySelector(".desktop-find .mode-find") as HTMLButtonElement);
    fireEvent.change(findInput(container), { target: { value: "threads" } });

    const option = getByRole("listbox", { name: "Find" }).querySelector('button[role="option"]') as HTMLElement;
    expect(option.querySelector(".find-kind")?.textContent).toBe("Setting");
    fireEvent.click(option);

    expect(onOpenSettingsField).toHaveBeenCalledWith("settings-worker-threads");
  });

  it("closes Find when More opens, and exposes a dock trigger for phones", () => {
    const { container } = render(withSettings(<Masthead {...props} />));
    fireEvent.click(container.querySelector(".dock-find") as HTMLButtonElement);
    expect(container.querySelector(".find-palette")).not.toBeNull();

    fireEvent.click(container.querySelector(".desktop-more .mode-more") as HTMLButtonElement);

    expect(container.querySelector(".find-palette")).toBeNull();
  });
});
