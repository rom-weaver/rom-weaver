// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { LogDialog } from "../../../src/webapp/components/log-dialog.tsx";

// The suite runs without vitest globals, so RTL cannot auto-clean between tests.
afterEach(cleanup);

describe("LogDialog", () => {
  it("wears the weft sub-rail as its header, opening on the tab it was asked for", () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog onClose={() => undefined} onLevelChange={() => undefined} open={false} />
      </RomWeaverSettingsProvider>,
    );

    const dialog = container.querySelector<HTMLDialogElement>("dialog.log-dlg");
    expect(dialog).not.toBeNull();
    // the tabs are the header - there is no title competing with them
    expect(container.querySelector(".dlg-title")).toBeNull();
    const tabs = Array.from(container.querySelectorAll('.dialog-subrail [role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Settings", "Status", "Logs", "Storage", "Changelog"]);
    expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0").length).toBe(1);
    expect(container.querySelector("#logpanel-status")).not.toBeNull();
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
    expect(container.querySelector(".settings-panel-stub")).toBeNull();
  });

  it("opens on Settings, mounts the panel there, and offers Defaults and Save", () => {
    const onRestoreDefaults = vi.fn();
    const onSaveSettings = vi.fn();
    const { container, getByRole } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog
          initialTab="settings"
          onClose={() => undefined}
          onLevelChange={() => undefined}
          onRestoreDefaults={onRestoreDefaults}
          onSaveSettings={onSaveSettings}
          open
          settingsPanel={<div className="settings-panel-stub" />}
        />
      </RomWeaverSettingsProvider>,
    );

    const panel = container.querySelector("#logpanel-settings");
    expect(panel?.getAttribute("aria-labelledby")).toBe("logtab-settings");
    expect(panel?.querySelector(".settings-panel-stub")).not.toBeNull();
    expect(container.querySelector('[data-logtab="settings"]')?.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(getByRole("button", { name: "Defaults" }));
    expect(onRestoreDefaults).toHaveBeenCalledTimes(1);
    fireEvent.click(getByRole("button", { name: "Save" }));
    expect(onSaveSettings).toHaveBeenCalledTimes(1);
  });

  it("reports every tab change so the host can stage a settings draft", () => {
    const onTabChange = vi.fn();
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog onClose={() => undefined} onLevelChange={() => undefined} onTabChange={onTabChange} open />
      </RomWeaverSettingsProvider>,
    );

    fireEvent.click(container.querySelector('[data-logtab="settings"]') as HTMLButtonElement);
    expect(onTabChange).toHaveBeenCalledWith("settings");
    // arrow keys walk the rail and report the same way
    fireEvent.keyDown(container.querySelector(".dialog-subrail") as HTMLElement, { key: "ArrowRight" });
    expect(onTabChange).toHaveBeenCalledWith("status");
  });

  it("defaults the capture level to warn and reports level changes", () => {
    const onLevelChange = vi.fn();
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog initialTab="logs" onClose={() => undefined} onLevelChange={onLevelChange} open={false} />
      </RomWeaverSettingsProvider>,
    );

    expect(container.querySelector(".tracelog")).not.toBeNull();
    const select = container.querySelector<HTMLSelectElement>(".loglevel select");
    expect(select?.value).toBe("warn");

    if (!select) throw new Error("log-level select not found");
    select.value = "trace";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onLevelChange).toHaveBeenCalledWith("trace");
  });
});
