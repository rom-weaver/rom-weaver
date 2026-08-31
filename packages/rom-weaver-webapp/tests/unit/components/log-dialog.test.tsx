// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { listBrowserOpfs } from "../../../src/storage/browser/browser-opfs-cleanup.ts";
import { getActiveBrowserVirtualFiles } from "../../../src/workers/protocol/browser-virtual-files.ts";
import { LogDialog } from "../../../src/webapp/components/log-dialog.tsx";
import { queryOfflineCachedFiles } from "../../../src/webapp/pwa/offline-warmup-client.ts";

vi.mock("../../../src/storage/browser/browser-opfs-cleanup.ts", () => ({
  listBrowserOpfs: vi.fn(),
}));

vi.mock("../../../src/workers/protocol/browser-virtual-files.ts", () => ({
  getActiveBrowserVirtualFiles: vi.fn(() => []),
}));

vi.mock("../../../src/webapp/pwa/offline-warmup-client.ts", () => ({
  queryOfflineCachedFiles: vi.fn(() => Promise.resolve([])),
}));

// The suite runs without vitest globals, so RTL cannot auto-clean between tests.
afterEach(() => {
  cleanup();
  vi.mocked(getActiveBrowserVirtualFiles).mockReturnValue([]);
  vi.mocked(queryOfflineCachedFiles).mockResolvedValue([]);
});

describe("LogDialog", () => {
  it("lists every cached offline file with its sizes on Status", async () => {
    vi.mocked(queryOfflineCachedFiles).mockResolvedValue([
      {
        cache: "emulatorjs-4.2.3",
        compressedBytes: 1024,
        sizeBytes: 4096,
        url: "https://example.test/emulatorjs/data/loader.js",
      },
      {
        cache: "identify-optional",
        compressedBytes: 2048,
        sizeBytes: 2048,
        url: "https://example.test/assets/identify-consoles.pack?sha256=abc",
      },
    ]);
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog onClose={() => undefined} onLevelChange={() => undefined} open />
      </RomWeaverSettingsProvider>,
    );

    await waitFor(() => expect(container.querySelectorAll(".sw-cache-list tbody tr")).toHaveLength(2));
    const drawer = container.querySelector<HTMLButtonElement>(".sw-cache-drawer > .cks-head");
    expect(drawer?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(drawer as HTMLButtonElement);
    expect(drawer?.getAttribute("aria-expanded")).toBe("true");
    // Sorted by path by default, and transferred/stored are separate cells:
    // no cache name and no revision query string in the visible text.
    expect(Array.from(container.querySelectorAll(".sw-cache-list tbody tr"), (row) => row.textContent)).toEqual([
      "/assets/identify-consoles.pack2.05 KB2.05 KB",
      "/emulatorjs/data/loader.js1.02 KB4.1 KB",
    ]);
  });

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
    const branchLink = container.querySelector<HTMLAnchorElement>('.status-row a[href$="/tree/dev"]');
    expect(branchLink?.textContent).toBe("dev");
    expect(branchLink?.target).toBe("_blank");
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

  it("shows emulator save controls in Storage", () => {
    vi.mocked(listBrowserOpfs).mockResolvedValue([]);
    const { container: storageContainer } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog initialTab="storage" onClose={() => undefined} onLevelChange={() => undefined} open />
      </RomWeaverSettingsProvider>,
    );
    expect(storageContainer.querySelector("#storage-opfs-title")?.textContent).toBe("OPFS");
    expect(storageContainer.querySelector(".emulator-saves-panel")).not.toBeNull();
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
