// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { copyToClipboard } from "../../src/lib/clipboard.ts";
import { triggerBrowserDownload } from "../../src/platform/browser/browser-download.ts";
import { listBrowserOpfs } from "../../src/storage/browser/browser-opfs-cleanup.ts";
import { getLastSessionEntries, getLogEntries, type LogStoreEntry } from "../../src/webapp/log-store.ts";
import { queryOfflineCachedFiles } from "../../src/webapp/pwa/offline-warmup-client.ts";
import { cachedFileTotals, LogDialog, sortCachedFiles } from "../../src/webapp/components/log-dialog.tsx";
import type { OfflineCachedFile } from "../../src/webapp/offline-warmup.ts";

vi.mock("../../src/lib/clipboard.ts", () => ({ copyToClipboard: vi.fn(async () => undefined) }));
vi.mock("../../src/platform/browser/browser-download.ts", () => ({ triggerBrowserDownload: vi.fn() }));
vi.mock("../../src/storage/browser/browser-opfs-cleanup.ts", () => ({ listBrowserOpfs: vi.fn(async () => []) }));
vi.mock("../../src/workers/protocol/browser-virtual-files.ts", () => ({ getActiveBrowserVirtualFiles: () => [] }));
vi.mock("../../src/webapp/pwa/offline-warmup-client.ts", () => ({ queryOfflineCachedFiles: vi.fn(async () => []) }));
vi.mock("../../src/webapp/log-store.ts", () => ({
  getLastSessionEntries: vi.fn(() => []),
  getLogEntries: vi.fn(() => []),
  subscribeLogEntries: () => () => undefined,
}));

const entry = (overrides: Partial<LogStoreEntry> = {}): LogStoreEntry => ({
  id: 1,
  level: "info",
  message: "pipeline started",
  namespace: "runner",
  timestamp: "2024-05-04T09:08:07.123Z",
  ...overrides,
});

const cachedFile = (overrides: Partial<OfflineCachedFile> = {}): OfflineCachedFile => ({
  cache: "precache-rom-weaver",
  compressedBytes: 1000,
  sizeBytes: 4000,
  url: "https://example.test/assets/app.js",
  ...overrides,
});

const renderDialog = (props: Partial<Parameters<typeof LogDialog>[0]> = {}) =>
  render(
    <RomWeaverSettingsProvider settings={{}}>
      <LogDialog onClose={() => undefined} onLevelChange={() => undefined} open {...props} />
    </RomWeaverSettingsProvider>,
  );

// The clipboard promise settles in a microtask and the flash then schedules a timer;
// both have to drain inside act() or React reports the state change as unbatched.
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.mocked(listBrowserOpfs).mockClear();
  vi.mocked(queryOfflineCachedFiles).mockClear();
  vi.mocked(copyToClipboard).mockClear();
  vi.mocked(getLogEntries).mockReturnValue([]);
  vi.mocked(getLastSessionEntries).mockReturnValue([]);
  vi.mocked(listBrowserOpfs).mockResolvedValue([]);
  vi.mocked(queryOfflineCachedFiles).mockResolvedValue([]);
  vi.mocked(copyToClipboard).mockResolvedValue(undefined);
  vi.mocked(triggerBrowserDownload).mockReset();
});

describe("sortCachedFiles", () => {
  const app = cachedFile({ compressedBytes: 300, sizeBytes: 900, url: "https://example.test/a.js" });
  const boot = cachedFile({ compressedBytes: 100, sizeBytes: 900, url: "https://example.test/b.js" });
  const unmeasured = cachedFile({ compressedBytes: null, sizeBytes: null, url: "https://example.test/c.js" });

  const paths = (files: OfflineCachedFile[]) => files.map((file) => new URL(file.url).pathname);

  it("orders by path in both directions without mutating the input", () => {
    const files = [boot, app];

    expect(paths(sortCachedFiles(files, { column: "path", direction: "asc" }))).toEqual(["/a.js", "/b.js"]);
    expect(paths(sortCachedFiles(files, { column: "path", direction: "desc" }))).toEqual(["/b.js", "/a.js"]);
    expect(paths(files)).toEqual(["/b.js", "/a.js"]);
  });

  it("orders by transferred size and parks unmeasured files last", () => {
    const sorted = sortCachedFiles([app, unmeasured, boot], { column: "compressed", direction: "desc" });

    expect(paths(sorted)).toEqual(["/a.js", "/b.js", "/c.js"]);
  });

  it("breaks a size tie by path and keeps two unmeasured files in path order", () => {
    const otherUnmeasured = cachedFile({ compressedBytes: null, sizeBytes: null, url: "https://example.test/d.js" });

    expect(paths(sortCachedFiles([boot, app], { column: "stored", direction: "asc" }))).toEqual(["/a.js", "/b.js"]);
    expect(paths(sortCachedFiles([otherUnmeasured, unmeasured], { column: "stored", direction: "asc" }))).toEqual([
      "/c.js",
      "/d.js",
    ]);
  });
});

describe("cachedFileTotals", () => {
  it("counts a file's one known measurement in both totals", () => {
    expect(
      cachedFileTotals([
        cachedFile({ compressedBytes: 100, sizeBytes: 400 }),
        cachedFile({ compressedBytes: null, sizeBytes: 50 }),
        cachedFile({ compressedBytes: 25, sizeBytes: null }),
      ]),
    ).toEqual({ compressedBytes: 175, sizeBytes: 475 });
  });
});

describe("trace listing", () => {
  it("renders each entry with its time, level, namespace and details", () => {
    vi.mocked(getLogEntries).mockReturnValue([
      entry({ details: { attempt: 2 }, id: 1 }),
      entry({ id: 2, level: "error", message: "run failed", namespace: "worker" }),
    ]);
    const { container } = renderDialog({ initialTab: "logs" });

    const lines = Array.from(container.querySelectorAll(".tracelog .ln"));
    expect(lines).toHaveLength(2);
    expect(lines[0]?.querySelector(".ts")?.textContent).toBe("09:08:07.123");
    expect(lines[0]?.querySelector(".msg")?.textContent).toBe('pipeline started {"attempt":2}');
    expect(lines[1]?.querySelector(".lv")?.className).toBe("lv error");
  });

  it("caps an oversized details payload with its full length", () => {
    vi.mocked(getLogEntries).mockReturnValue([entry({ details: { blob: "x".repeat(6000) } })]);
    const { container } = renderDialog({ initialTab: "logs" });

    const message = container.querySelector(".tracelog .ln .msg")?.textContent ?? "";
    expect(message).toContain("… (6011 chars)");
    expect(message.length).toBeLessThan(4200);
  });

  it("drops details that cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    vi.mocked(getLogEntries).mockReturnValue([entry({ details: circular })]);
    const { container } = renderDialog({ initialTab: "logs" });

    expect(container.querySelector(".tracelog .ln .msg")?.textContent).toBe("pipeline started");
  });

  it("filters the listing and reports a query that matches nothing", () => {
    vi.mocked(getLogEntries).mockReturnValue([entry({ id: 1 }), entry({ id: 2, message: "run finished" })]);
    const { container } = renderDialog({ initialTab: "logs" });
    const filter = container.querySelector<HTMLInputElement>(".log-filter");
    if (!filter) throw new Error("The dialog rendered no log filter");

    fireEvent.change(filter, { target: { value: "finished" } });
    expect(container.querySelectorAll(".tracelog .ln")).toHaveLength(1);

    fireEvent.change(filter, { target: { value: "nothing-matches-this" } });
    expect(container.querySelector(".tracelog-empty")?.textContent).toContain("nothing-matches-this");
  });

  it("keeps the scroll position the reader scrolled to", () => {
    vi.mocked(getLogEntries).mockReturnValue(Array.from({ length: 60 }, (_, index) => entry({ id: index })));
    const { container } = renderDialog({ initialTab: "logs" });
    const trace = container.querySelector(".tracelog");
    if (!trace) throw new Error("The dialog rendered no trace list");

    fireEvent.scroll(trace, { target: { scrollTop: 500 } });

    const rendered = Array.from(container.querySelectorAll(".tracelog .ln .caller"));
    expect(rendered.length).toBeGreaterThan(0);
    expect(container.querySelector(".tracelog-virtual-content")?.getAttribute("style")).toContain("height: 1500px");
  });
});

describe("previous session view", () => {
  it("offers the toggle only when a previous session exists and switches to it", () => {
    vi.mocked(getLogEntries).mockReturnValue([entry({ message: "current run" })]);
    vi.mocked(getLastSessionEntries).mockReturnValue([entry({ id: 9, message: "previous run" })]);
    const { container } = renderDialog({ initialTab: "logs" });

    expect(container.querySelector(".logview")).not.toBeNull();
    fireEvent.click(container.querySelectorAll(".logview .seg-btn")[1] as HTMLButtonElement);

    expect(container.querySelector(".tracelog .ln .msg")?.textContent).toBe("previous run");
  });

  it("hides the toggle when there is no previous session", () => {
    const { container } = renderDialog({ initialTab: "logs" });

    expect(container.querySelector(".logview")).toBeNull();
  });
});

describe("copy feedback", () => {
  it("flashes the copied state on a trace line and clears it", async () => {
    vi.useFakeTimers();
    vi.mocked(getLogEntries).mockReturnValue([entry()]);
    const { container } = renderDialog({ initialTab: "logs" });

    fireEvent.click(container.querySelector(".tracelog .ln") as HTMLButtonElement);
    await settle();

    expect(copyToClipboard).toHaveBeenCalledWith("09:08:07.123 INFO  runner: pipeline started");
    expect(container.querySelector(".ln.copied")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(container.querySelector(".ln.copied")).toBeNull();
  });

  it("marks the line failed when the clipboard refuses", async () => {
    vi.useFakeTimers();
    vi.mocked(copyToClipboard).mockRejectedValue(new Error("clipboard is unavailable"));
    vi.mocked(getLogEntries).mockReturnValue([entry()]);
    const { container } = renderDialog({ initialTab: "logs" });

    fireEvent.click(container.querySelector(".tracelog .ln") as HTMLButtonElement);
    await settle();

    expect(container.querySelector(".ln.copy-failed")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.querySelector(".ln.copy-failed")).toBeNull();
  });

  it("copies the whole listing with uncapped details", async () => {
    vi.useFakeTimers();
    vi.mocked(getLogEntries).mockReturnValue([entry({ details: { attempt: 2 } }), entry({ id: 2, message: "done" })]);
    const { container } = renderDialog({ initialTab: "logs" });

    fireEvent.click(container.querySelector(".log-actions .log-icon-btn") as HTMLButtonElement);
    await settle();

    expect(copyToClipboard).toHaveBeenCalledWith(
      '09:08:07.123 INFO  runner: pipeline started {"attempt":2}\n09:08:07.123 INFO  runner: done',
    );
    expect(container.querySelector(".log-icon-btn.copied")).not.toBeNull();
  });
});

describe("log download", () => {
  const downloadButton = (container: HTMLElement) =>
    container.querySelectorAll<HTMLButtonElement>(".log-actions .log-icon-btn")[1];

  it("names the current session's file", () => {
    vi.mocked(getLogEntries).mockReturnValue([entry()]);
    const { container } = renderDialog({ initialTab: "logs" });

    fireEvent.click(downloadButton(container) as HTMLButtonElement);

    expect(triggerBrowserDownload).toHaveBeenCalledWith(
      "09:08:07.123 INFO  runner: pipeline started",
      "rom-weaver-log.txt",
    );
  });

  it("names the previous session's file", () => {
    vi.mocked(getLastSessionEntries).mockReturnValue([entry({ message: "previous run" })]);
    const { container } = renderDialog({ initialTab: "logs" });

    fireEvent.click(container.querySelectorAll(".logview .seg-btn")[1] as HTMLButtonElement);
    fireEvent.click(downloadButton(container) as HTMLButtonElement);

    expect(triggerBrowserDownload).toHaveBeenCalledWith(
      expect.stringContaining("previous run"),
      "rom-weaver-previous-log.txt",
    );
  });

  it("names the OPFS listing's file", async () => {
    vi.mocked(listBrowserOpfs).mockResolvedValue([{ kind: "file", path: "/user-files/game.iso", size: 42 }]);
    const { container } = renderDialog({ initialTab: "storage" });

    await waitFor(() => expect(container.querySelectorAll(".opfs-row")).toHaveLength(1));
    fireEvent.click(downloadButton(container) as HTMLButtonElement);

    expect(triggerBrowserDownload).toHaveBeenCalledWith(
      expect.stringContaining("/user-files/game.iso"),
      "rom-weaver-opfs.txt",
    );
  });
});

describe("OPFS inspector", () => {
  it("re-reads the listing when refresh is pressed", async () => {
    const { container } = renderDialog({ initialTab: "storage" });
    await waitFor(() => expect(listBrowserOpfs).toHaveBeenCalledTimes(1));

    fireEvent.click(container.querySelector(".log-refresh") as HTMLButtonElement);

    await waitFor(() => expect(listBrowserOpfs).toHaveBeenCalledTimes(2));
    expect(container.querySelector(".opfs-empty")?.textContent).toBe("OPFS has no entries");
  });

  it("reports a listing failure", async () => {
    vi.mocked(listBrowserOpfs).mockRejectedValue(new Error("OPFS is not available"));
    const { container } = renderDialog({ initialTab: "storage" });

    await waitFor(() => expect(container.querySelector(".opfs-error")?.textContent).toBe("OPFS is not available"));
  });

  it("reports a filter that matches no entry", async () => {
    vi.mocked(listBrowserOpfs).mockResolvedValue([{ kind: "file", path: "/user-files/game.iso", size: 42 }]);
    const { container } = renderDialog({ initialTab: "storage" });
    await waitFor(() => expect(container.querySelectorAll(".opfs-row")).toHaveLength(1));

    fireEvent.change(container.querySelector(".log-filter") as HTMLInputElement, { target: { value: "no-such-file" } });

    expect(container.querySelector(".opfs-empty")?.textContent).toBe("No matching entries");
  });
});

describe("cached file inventory", () => {
  const openDrawer = (container: HTMLElement) => {
    fireEvent.click(container.querySelector(".sw-cache-drawer > .cks-head") as HTMLButtonElement);
  };

  it("re-sorts on a column header and reverses on a second click", async () => {
    vi.mocked(queryOfflineCachedFiles).mockResolvedValue([
      cachedFile({ compressedBytes: 100, sizeBytes: 900, url: "https://example.test/a.js" }),
      cachedFile({ compressedBytes: 800, sizeBytes: 100, url: "https://example.test/b.js" }),
    ]);
    const { container } = renderDialog();
    await waitFor(() => expect(container.querySelectorAll(".sw-cache-list tbody tr")).toHaveLength(2));
    openDrawer(container);

    const paths = () =>
      Array.from(container.querySelectorAll(".sw-cache-list tbody tr code"), (cell) => cell.textContent);
    expect(paths()).toEqual(["/a.js", "/b.js"]);

    const transferred = container.querySelectorAll<HTMLButtonElement>(".sw-cache-sort")[1];
    fireEvent.click(transferred as HTMLButtonElement);
    expect(paths()).toEqual(["/b.js", "/a.js"]);
    expect(container.querySelectorAll(".sw-cache-col")[1]?.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(transferred as HTMLButtonElement);
    expect(paths()).toEqual(["/a.js", "/b.js"]);
    expect(container.querySelectorAll(".sw-cache-col")[1]?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("reports a failed first read of the inventory", async () => {
    vi.mocked(queryOfflineCachedFiles).mockRejectedValue(new Error("the worker did not answer"));
    const { container } = renderDialog();

    openDrawer(container);
    await waitFor(() =>
      expect(container.querySelector(".sw-cache-error")?.textContent).toBe("the worker did not answer"),
    );
  });

  it("shows an em dash for a file with no transferred size", async () => {
    vi.mocked(queryOfflineCachedFiles).mockResolvedValue([cachedFile({ compressedBytes: null })]);
    const { container } = renderDialog();
    await waitFor(() => expect(container.querySelectorAll(".sw-cache-list tbody tr")).toHaveLength(1));
    openDrawer(container);

    expect(container.querySelectorAll(".sw-cache-size")[0]?.textContent).toBe("—");
  });
});

describe("status offline row", () => {
  it("shows the install detail line with file counts, bytes and the current unit", () => {
    const { container } = renderDialog({
      offlineProgress: {
        cachedBytes: 400,
        cachedFiles: 2,
        detail: { kind: "identify-group", name: "Computers" },
        ready: false,
        totalBytes: 1000,
        totalFiles: 5,
        unitLoadedBytes: 100,
        unitTotalBytes: 200,
      },
      serviceWorkerStatus: "active",
    });

    const details = Array.from(container.querySelectorAll(".sw-progress-detail"), (node) => node.textContent);
    expect(details).toHaveLength(2);
    expect(details[0]).toContain("2");
    expect(details[1]).toContain("Computers");
    expect(details[1]).toContain("(");
  });

  it("omits the unit line when the progress names no unit", () => {
    const { container } = renderDialog({
      offlineProgress: { cachedBytes: 0, cachedFiles: 0, ready: false, totalBytes: 0, totalFiles: 4 },
      serviceWorkerStatus: "active",
    });

    expect(container.querySelectorAll(".sw-progress-detail")).toHaveLength(1);
  });

  it("lists every offline state in the legend and marks the current one", () => {
    const { container } = renderDialog({ serviceWorkerStatus: "off" });

    const rows = container.querySelectorAll(".sw-legend-row");
    expect(rows).toHaveLength(5);
    expect(container.querySelectorAll(".sw-legend-row[data-current]")).toHaveLength(1);
    expect(container.querySelector(".sw-legend-row[data-current] .sw-chip")?.getAttribute("data-sw")).toBe("disabled");
  });
});

describe("tab rail keyboard movement", () => {
  it("walks to the first and last tab with Home and End", () => {
    const onTabChange = vi.fn();
    const { container } = renderDialog({ onTabChange });
    const rail = container.querySelector(".dialog-subrail") as HTMLElement;

    fireEvent.keyDown(rail, { key: "End" });
    expect(onTabChange).toHaveBeenLastCalledWith("storage");

    fireEvent.keyDown(rail, { key: "Home" });
    expect(onTabChange).toHaveBeenLastCalledWith("settings");
  });

  it("ignores a key that moves nothing", () => {
    const onTabChange = vi.fn();
    const { container } = renderDialog({ onTabChange });

    fireEvent.keyDown(container.querySelector(".dialog-subrail") as HTMLElement, { key: "a" });

    expect(onTabChange).not.toHaveBeenCalled();
  });
});

describe("settings deep link", () => {
  it("focuses the field a deep link names", async () => {
    const { container } = renderDialog({
      initialTab: "settings",
      settingsFocusHint: { fieldId: "setting-thread-count", token: 1 },
      settingsPanel: (
        <div className="setrow">
          <input id="setting-thread-count" />
        </div>
      ),
    });

    await waitFor(() => expect(document.activeElement?.id).toBe("setting-thread-count"));
    expect(container.querySelector("#setting-thread-count")).not.toBeNull();
  });
});
