// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { SystemPage, type SystemPageProps } from "../../../src/webapp/system-page.tsx";
import type { SystemTab } from "../../../src/webapp/system-tabs.ts";

// The suite runs without vitest globals, so RTL cannot auto-clean between tests.
afterEach(cleanup);

const tabHref = (tab: SystemTab) => (tab === "settings" ? "/system" : `/system/${tab}`);

const renderPage = (props: Partial<SystemPageProps> = {}) =>
  render(
    <RomWeaverSettingsProvider settings={{}}>
      <SystemPage
        active
        draftSettings={{}}
        onDraftChange={() => undefined}
        onLevelChange={() => undefined}
        tab="status"
        tabHref={tabHref}
        validation={{ invalidFields: [], messages: [] }}
        {...props}
      />
    </RomWeaverSettingsProvider>,
  );

describe("SystemPage", () => {
  it("wears the weft sub-rail as its header, with a real URL per tab", () => {
    const { container } = renderPage();

    // A page, not a dialog: nothing to close, and every tab is addressable.
    expect(container.querySelector("dialog")).toBeNull();
    expect(container.querySelector(".dlg-x")).toBeNull();
    const tabs = Array.from(container.querySelectorAll<HTMLAnchorElement>('.system-subrail [role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Settings", "Status", "Logs", "Storage", "Changelog"]);
    expect(tabs.map((tab) => tab.getAttribute("href"))).toEqual([
      "/system",
      "/system/status",
      "/system/logs",
      "/system/storage",
      "/system/changelog",
    ]);
    expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0").length).toBe(1);
    expect(container.querySelector("#systempanel-status")).not.toBeNull();
    expect(container.querySelector(".status-rows")).not.toBeNull();
    // the trace log belongs to the Logs tab, so it is not mounted on Status
    expect(container.querySelector(".tracelog")).toBeNull();
    // licence, attribution and privacy are written out on the About guide; the
    // tab is a readout of the build, so it carries one line out to that page
    const aboutLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>(".status-about a"));
    expect(aboutLinks.map((link) => link.getAttribute("href"))).toEqual(["/docs/about"]);
    // every offline state is named, so the badge above reads against the rest
    expect(container.querySelectorAll(".sw-legend-row").length).toBe(5);
    // the settings panel belongs to its own tab, so it is not mounted on Status
    expect(container.querySelector(".settings-panel")).toBeNull();
  });

  it("mounts the settings panel on its own tab and offers Defaults and Save", () => {
    const onRestoreDefaults = vi.fn();
    const onSaveSettings = vi.fn();
    const { container, getByRole } = renderPage({ onRestoreDefaults, onSaveSettings, tab: "settings" });

    const panel = container.querySelector("#systempanel-settings");
    expect(panel?.getAttribute("aria-labelledby")).toBe("systemtab-settings");
    expect(panel?.querySelector(".settings-panel")).not.toBeNull();
    expect(container.querySelector('[data-systemtab="settings"]')?.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(getByRole("button", { name: "Defaults" }));
    expect(onRestoreDefaults).toHaveBeenCalledTimes(1);
    fireEvent.click(getByRole("button", { name: "Save" }));
    expect(onSaveSettings).toHaveBeenCalledTimes(1);
  });

  it("walks the rail with the arrow keys by following the next tab's link", () => {
    const { container } = renderPage({ tab: "settings" });
    const followed: string[] = [];
    for (const tab of container.querySelectorAll<HTMLAnchorElement>('.system-subrail [role="tab"]')) {
      tab.addEventListener("click", (event) => {
        event.preventDefault();
        followed.push(tab.getAttribute("href") ?? "");
      });
    }

    const rail = container.querySelector(".system-subrail") as HTMLElement;
    fireEvent.keyDown(rail, { key: "ArrowRight" });
    // The rail wraps rather than dead-ending at either edge.
    fireEvent.keyDown(rail, { key: "ArrowLeft" });
    expect(followed).toEqual(["/system/status", "/system/changelog"]);
  });

  it("defaults the capture level to warn and reports level changes", () => {
    const onLevelChange = vi.fn();
    const { container } = renderPage({ onLevelChange, tab: "logs" });

    expect(container.querySelector(".tracelog")).not.toBeNull();
    const select = container.querySelector<HTMLSelectElement>(".loglevel select");
    expect(select?.value).toBe("warn");

    if (!select) throw new Error("log-level select not found");
    select.value = "trace";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onLevelChange).toHaveBeenCalledWith("trace");
  });

  it("spends the deep-link hash instead of re-focusing on every later visit", async () => {
    window.history.replaceState({}, "", "/system#set-threads");
    const { rerender } = renderPage({ tab: "settings" });
    await waitFor(() => expect(window.location.hash).toBe(""));

    // Coming back to the tab later must not drag the reader to the field a
    // deep link pointed at once.
    rerender(
      <RomWeaverSettingsProvider settings={{}}>
        <SystemPage
          active
          draftSettings={{}}
          onDraftChange={() => undefined}
          onLevelChange={() => undefined}
          tab="settings"
          tabHref={tabHref}
          validation={{ invalidFields: [], messages: [] }}
        />
      </RomWeaverSettingsProvider>,
    );
    expect(window.location.hash).toBe("");
  });

  it("shows no log lines while another route is on screen", () => {
    // The route stays mounted behind the workflow tabs, so a hidden Logs tab
    // that kept its store subscription would re-render on every trace line of a
    // run. The empty rail is what that no-op subscription looks like.
    const { container } = renderPage({ active: false, tab: "logs" });

    expect(container.querySelector(".tracelog-virtual-window")).toBeNull();
  });
});
