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
  { href: "apply-patch", icon: <svg aria-hidden="true" />, id: "patcher", label: "Apply Patch" },
  { href: "apply-patch#bundle", icon: <svg aria-hidden="true" />, id: "bundle", label: "Bundles" },
  { href: "create-patch", icon: <svg aria-hidden="true" />, id: "creator", label: "Create Patch" },
  { href: "test-rom", icon: <svg aria-hidden="true" />, id: "test", label: "Test ROM" },
] satisfies WorkflowTab[];

const props = {
  currentTab: "patcher",
  githubHref: "https://example.com/repo",
  homeHref: "/apply",
  onOpenWhatsNew: () => undefined,
  onOpenLog: () => undefined,
  onOpenSettings: () => undefined,
  onOpenStatus: () => undefined,
  onSelectTab: () => undefined,
  tabs: TABS,
  version: "1.2.3",
};

const findInput = (container: HTMLElement) => container.querySelector(".find-input") as HTMLInputElement;

describe("Find", () => {
  it("hides beta tools while the beta-tools setting is off, and ignores the shortcut behind a modal", () => {
    const tabs = [
      ...TABS,
      {
        beta: true,
        group: "tools" as const,
        href: "trim-rom",
        icon: <svg aria-hidden="true" />,
        id: "trim",
        label: "Trim ROM",
        placement: "more" as const,
      },
    ];
    const { container, getByRole } = render(
      <RomWeaverSettingsProvider settings={{ betaToolsEnabled: false }}>
        <Masthead {...props} tabs={tabs} />
      </RomWeaverSettingsProvider>,
    );
    fireEvent.click(container.querySelector(".desktop-find .find-trigger") as HTMLButtonElement);
    const labels = Array.from(getByRole("listbox", { name: "Find" }).querySelectorAll(".find-label")).map(
      (label) => label.textContent,
    );
    expect(labels).not.toContain("Trim ROM");
    fireEvent.keyDown(findInput(container), { key: "Escape" });

    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    fireEvent.keyDown(document, { key: "/" });
    expect(container.querySelector(".find-palette")).toBeNull();
    dialog.remove();
  });

  it("opens from the masthead trigger with the browse list and focus in the box", () => {
    const { container, getByRole } = render(withSettings(<Masthead {...props} />));
    expect(container.querySelector(".find-palette")).toBeNull();
    // Find lives in the actions cluster as a search field, never in the tablist.
    expect(container.querySelector('.mode-rail [aria-haspopup="dialog"]')).toBeNull();
    expect(container.querySelector(".masthead-tools .desktop-find .find-trigger")).not.toBeNull();

    fireEvent.click(container.querySelector(".desktop-find .find-trigger") as HTMLButtonElement);

    expect(document.activeElement).toBe(findInput(container));
    const options = getByRole("listbox", { name: "Find" }).querySelectorAll('[role="option"]');
    expect(options[0]?.textContent).toContain("Apply Patch");
    expect(Array.from(options).map((option) => option.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Status"), expect.stringContaining("Settings")]),
    );
  });

  it("opens with / or Ctrl+K and closes on Escape, returning focus to the trigger", () => {
    const { container } = render(withSettings(<Masthead {...props} />));
    // A slash typed into a field is text, not the shortcut.
    const field = document.createElement("input");
    document.body.append(field);
    fireEvent.keyDown(field, { key: "/" });
    expect(container.querySelector(".find-palette")).toBeNull();
    field.remove();

    fireEvent.keyDown(document, { key: "/" });
    expect(container.querySelector(".find-palette")).not.toBeNull();
    fireEvent.keyDown(findInput(container), { key: "Escape" });
    expect(container.querySelector(".find-palette")).toBeNull();

    fireEvent.keyDown(document, { ctrlKey: true, key: "k" });
    expect(container.querySelector(".find-palette")).not.toBeNull();

    fireEvent.keyDown(findInput(container), { key: "Escape" });

    expect(container.querySelector(".find-palette")).toBeNull();
    // Focus returns to whichever Find trigger the layout shows.
    expect(
      document.activeElement?.classList.contains("dock-find") ||
        document.activeElement?.classList.contains("find-trigger"),
    ).toBe(true);
  });

  it("resets the selected result when reopened after a search", () => {
    const onSelectTab = vi.fn();
    const { container } = render(withSettings(<Masthead {...props} onSelectTab={onSelectTab} />));
    fireEvent.click(container.querySelector(".desktop-find .find-trigger") as HTMLButtonElement);
    fireEvent.change(findInput(container), { target: { value: "threads" } });
    fireEvent.keyDown(findInput(container), { key: "ArrowDown" });
    fireEvent.keyDown(findInput(container), { key: "Escape" });
    fireEvent.click(container.querySelector(".desktop-find .find-trigger") as HTMLButtonElement);
    expect(findInput(container).value).toBe("");
    expect(container.querySelector(".find-option.is-active")?.textContent).toContain("Apply Patch");
    fireEvent.keyDown(findInput(container), { key: "Enter" });
    expect(onSelectTab).toHaveBeenCalledWith("patcher");
  });

  it("filters as you type and opens a tool with Enter", () => {
    const onSelectTab = vi.fn();
    const { container, getByRole } = render(withSettings(<Masthead {...props} onSelectTab={onSelectTab} />));
    fireEvent.click(container.querySelector(".desktop-find .find-trigger") as HTMLButtonElement);
    fireEvent.change(findInput(container), { target: { value: "crea" } });

    const first = getByRole("listbox", { name: "Find" }).querySelector('[role="option"]');
    expect(first?.textContent).toContain("Create Patch");
    expect(first?.querySelector(".find-kind")?.textContent).toBe("Tool");
    fireEvent.keyDown(findInput(container), { key: "Enter" });

    expect(onSelectTab).toHaveBeenCalledWith("creator");
    expect(container.querySelector(".find-palette")).toBeNull();
  });

  it("opens the bundle drawer through Apply Patch", () => {
    const onSelectTab = vi.fn();
    const { container, getByRole } = render(withSettings(<Masthead {...props} onSelectTab={onSelectTab} />));
    fireEvent.click(container.querySelector(".desktop-find .find-trigger") as HTMLButtonElement);
    fireEvent.change(findInput(container), { target: { value: "bundle" } });

    const first = getByRole("listbox", { name: "Find" }).querySelector('[role="option"]');
    expect(first?.textContent).toContain("Bundles — Apply Patch");
    fireEvent.keyDown(findInput(container), { key: "Enter" });

    expect(onSelectTab).toHaveBeenCalledWith("bundle");
  });

  it("uses the guide link for a CLI-only command", () => {
    const onSelectTab = vi.fn();
    const { container, getByRole } = render(withSettings(<Masthead {...props} onSelectTab={onSelectTab} />));
    fireEvent.click(container.querySelector(".desktop-find .find-trigger") as HTMLButtonElement);
    fireEvent.change(findInput(container), { target: { value: "inspect" } });

    const guide = getByRole("listbox", { name: "Find" }).querySelector('a[role="option"]') as HTMLAnchorElement;
    expect(guide.getAttribute("href")).toBe("/docs/identify-and-hash-files");
    fireEvent.click(guide);

    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it("deep-links a setting through the field handler", () => {
    const onOpenSettingsField = vi.fn();
    const { container, getByRole } = render(
      withSettings(<Masthead {...props} onOpenSettingsField={onOpenSettingsField} />),
    );
    fireEvent.click(container.querySelector(".desktop-find .find-trigger") as HTMLButtonElement);
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
