// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { listBrowserOpfs } from "../../../src/storage/browser/browser-opfs-cleanup.ts";
import { getActiveBrowserVirtualFiles } from "../../../src/workers/protocol/browser-virtual-files.ts";
import { LogDialog } from "../../../src/webapp/components/log-dialog.tsx";

vi.mock("../../../src/storage/browser/browser-opfs-cleanup.ts", () => ({
  listBrowserOpfs: vi.fn(),
}));

vi.mock("../../../src/workers/protocol/browser-virtual-files.ts", () => ({
  getActiveBrowserVirtualFiles: vi.fn(() => []),
}));

// The suite runs without vitest globals, so RTL cannot auto-clean between tests.
afterEach(() => {
  cleanup();
  vi.mocked(getActiveBrowserVirtualFiles).mockReturnValue([]);
});

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
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Settings", "Status", "Logs", "Storage", "Test", "Changelog"]);
    expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0").length).toBe(1);
    expect(container.querySelector("#logpanel-status")).not.toBeNull();
    expect(container.querySelector(".status-rows")).not.toBeNull();
    // the trace log belongs to the Logs tab, so it is not mounted on Status
    expect(container.querySelector(".tracelog")).toBeNull();
    // licence, attribution and privacy are written out on the About guide; the
    // tab is a readout of the build, so it carries one line out to that page
    const aboutLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>(".status-about a"));
    expect(aboutLinks.map((link) => link.getAttribute("href"))).toEqual(["/docs/about"]);
    const branchLink = container.querySelector<HTMLAnchorElement>('.status-row a[href$="/tree/dev"]');
    expect(branchLink?.textContent).toBe("dev");
    expect(branchLink?.target).toBe("_blank");
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

  it("keeps update reload in the banner instead of duplicating it on Status", () => {
    const onReload = vi.fn();
    const { container, queryByRole } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog
          onClose={() => undefined}
          onLevelChange={() => undefined}
          onReload={onReload}
          open
          serviceWorkerStatus="active"
          updateReady
        />
      </RomWeaverSettingsProvider>,
    );

    expect(container.querySelector(".sw-summary")).toBeNull();
    expect(queryByRole("button", { name: "Reload now" })).toBeNull();
    expect(onReload).not.toHaveBeenCalled();
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

  it("shows bottom-most OPFS entries with their full parent paths", async () => {
    vi.mocked(listBrowserOpfs).mockResolvedValue([
      { kind: "directory", path: "/operations" },
      { kind: "directory", path: "/operations/run" },
      { kind: "directory", path: "/operations/run/nested" },
      { kind: "file", path: "/operations/run/nested/input.iso", size: 123 },
      { kind: "directory", path: "/rom-weaver-out" },
      { kind: "directory", path: "/rom-weaver-out/run" },
    ]);
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog initialTab="storage" onClose={() => undefined} onLevelChange={() => undefined} open />
      </RomWeaverSettingsProvider>,
    );

    await waitFor(() => expect(container.querySelectorAll(".opfs-row")).toHaveLength(2));
    expect(container.querySelector(".opfs-summary")?.textContent).toBe("2 entries");
    const rows = Array.from(container.querySelectorAll(".opfs-row"), (row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining("/operations/run/nested/input.iso"),
      expect.stringContaining("/rom-weaver-out/run"),
    ]);
    expect(rows.join("\n")).toContain("/operations/run/nested/");
    expect(rows.join("\n")).not.toContain("directory /operations");
  });

  it("hides empty internal OPFS containers", async () => {
    vi.mocked(listBrowserOpfs).mockResolvedValue([
      { kind: "directory", path: "/operations" },
      { kind: "directory", path: "/rom-weaver-out" },
      { kind: "directory", path: "/user-files" },
    ]);
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog initialTab="storage" onClose={() => undefined} onLevelChange={() => undefined} open />
      </RomWeaverSettingsProvider>,
    );

    await waitFor(() => expect(container.querySelectorAll(".opfs-row")).toHaveLength(1));
    expect(container.querySelector(".opfs-row")?.textContent).toContain("/user-files");
  });

  it("hosts the EmulatorJS panels and field on Test, not Storage", () => {
    vi.mocked(listBrowserOpfs).mockResolvedValue([]);
    const { container: storageContainer } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog initialTab="storage" onClose={() => undefined} onLevelChange={() => undefined} open />
      </RomWeaverSettingsProvider>,
    );
    // the EmulatorJS sections moved to the Test tab; Storage keeps only OPFS
    expect(storageContainer.querySelector(".emulator-prefetch-panel")).toBeNull();
    expect(storageContainer.querySelector(".emulator-saves-panel")).toBeNull();
    cleanup();

    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog
          emulatorSettingsField={<div className="post-apply-field-stub" />}
          initialTab="test"
          onClose={() => undefined}
          onLevelChange={() => undefined}
          open
        />
      </RomWeaverSettingsProvider>,
    );

    const panel = container.querySelector("#logpanel-test");
    expect(panel?.getAttribute("aria-labelledby")).toBe("logtab-test");
    expect(panel?.querySelector(".emulator-prefetch-panel")).not.toBeNull();
    expect(panel?.querySelector(".emulator-saves-panel")).not.toBeNull();
    expect(panel?.querySelector(".post-apply-field-stub")).not.toBeNull();
    expect(container.querySelector('[data-logtab="test"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("shows active virtual input files with their size", async () => {
    vi.mocked(listBrowserOpfs).mockResolvedValue([]);
    vi.mocked(getActiveBrowserVirtualFiles).mockReturnValue([
      { path: "/work/input/game.iso", source: new Uint8Array(123) },
    ]);
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog initialTab="storage" onClose={() => undefined} onLevelChange={() => undefined} open />
      </RomWeaverSettingsProvider>,
    );

    await waitFor(() => expect(container.querySelectorAll(".opfs-row")).toHaveLength(1));
    expect(container.querySelector(".opfs-row")?.textContent).toEqual(expect.stringContaining("virtual"));
    expect(container.querySelector(".opfs-row")?.textContent).toEqual(expect.stringContaining("123 B"));
    expect(container.querySelector(".opfs-row")?.textContent).toEqual(expect.stringContaining("/work/input/game.iso"));
  });
});
