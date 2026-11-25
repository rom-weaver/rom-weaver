// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { APP_VERSION } from "../../../src/webapp/build-version.ts";
import { UpdateBanner } from "../../../src/webapp/components/update-banner.tsx";

const REPOSITORY_URL = "https://github.com/rom-weaver/rom-weaver";
const LAST_SEEN_KEY = "rom-weaver-last-seen-version";
const RELOADING_INTO_KEY = "rom-weaver-reloading-into-version";
const INCOMING = `${Number.parseInt(APP_VERSION, 10) + 1}.0.0`;
const NEXT_INCOMING = `${Number.parseInt(INCOMING, 10) + 1}.0.0`;

const highlights = (version: string, summaries: string[]) => ({
  groups: [
    { entries: summaries.map((summary) => ({ summary })), title: "Highlights" },
    { entries: [{ summary: `${version} internal change` }], title: "Internal" },
  ],
  version,
});

const mockReleaseNotes = (notes: unknown[], version = APP_VERSION) =>
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve([
          {
            date: "2026-07-29T00:00:00Z",
            hash: "release",
            release: {
              changelogUrl: `${REPOSITORY_URL}/blob/main/CHANGELOG.md`,
              notes,
              repositoryUrl: REPOSITORY_URL,
              truncated: false,
              version,
            },
            subject: "release",
          },
        ]),
      ok: true,
    }),
  );

const renderBanner = (open = true, hasUnreadUpdate = false) => {
  const handlers = { onDismiss: vi.fn(), onOpenWhatsNew: vi.fn(), onReload: vi.fn() };
  const view = render(
    <RomWeaverSettingsProvider settings={{}}>
      <UpdateBanner hasUnreadUpdate={hasUnreadUpdate} open={open} {...handlers} />
    </RomWeaverSettingsProvider>,
  );
  const openBanner = () => view.container.querySelector(".reveal.is-open .update-banner");
  const rerender = (next: boolean) =>
    view.rerender(
      <RomWeaverSettingsProvider settings={{}}>
        <UpdateBanner hasUnreadUpdate={hasUnreadUpdate} open={next} {...handlers} />
      </RomWeaverSettingsProvider>,
    );
  return { ...handlers, container: view.container, openBanner, rerender, unmount: view.unmount };
};

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("UpdateBanner with a deploy waiting", () => {
  it("names the incoming release and leads with its highlight", async () => {
    mockReleaseNotes(
      [highlights(INCOMING, ["Incoming highlight"]), highlights(APP_VERSION, ["Running release highlight"])],
      INCOMING,
    );
    const { container, openBanner } = renderBanner();

    await waitFor(() => expect(openBanner()).not.toBeNull());

    expect(screen.getByText(`v${INCOMING} is ready`)).toBeTruthy();
    expect(screen.getByText("Incoming highlight")).toBeTruthy();
    expect(screen.queryByText("Running release highlight")).toBeNull();
    expect(container.querySelector(".update-banner.update-ready")).not.toBeNull();
  });

  it("says only that an update is ready when the version did not change", async () => {
    mockReleaseNotes([highlights(APP_VERSION, ["Running release highlight"])]);
    const { container, openBanner } = renderBanner();

    await waitFor(() => expect(openBanner()).not.toBeNull());

    expect(screen.getByText("Update ready")).toBeTruthy();
    expect(container.querySelector(".update-banner-highlight")).toBeNull();
  });

  it("records the incoming release on reload, for the next load to confirm", async () => {
    mockReleaseNotes([highlights(INCOMING, ["Incoming highlight"])], INCOMING);
    const { onReload, openBanner } = renderBanner();
    await waitFor(() => expect(openBanner()).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(RELOADING_INTO_KEY)).toBe(INCOMING);
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).toBeNull();
  });

  it("leaves an unacknowledged update to announce itself after the reload", async () => {
    window.localStorage.setItem(LAST_SEEN_KEY, "0.0.1");
    mockReleaseNotes([highlights(INCOMING, ["Incoming highlight"])], INCOMING);
    const { onReload, openBanner } = renderBanner(true, true);
    await waitFor(() => expect(openBanner()).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).toBe("0.0.1");
  });

  it("stays closed without fetching until a deploy is waiting", async () => {
    mockReleaseNotes([highlights(INCOMING, ["Incoming highlight"])], INCOMING);
    const { openBanner, rerender } = renderBanner(false);
    expect(fetch).not.toHaveBeenCalled();

    rerender(true);

    await waitFor(() => expect(screen.queryByText(`v${INCOMING} is ready`)).not.toBeNull());
    expect(openBanner()).not.toBeNull();
  });

  it("opens What's new and dismisses from its own controls", async () => {
    mockReleaseNotes([highlights(INCOMING, ["Incoming highlight"])], INCOMING);
    const { onDismiss, onOpenWhatsNew, openBanner } = renderBanner();
    await waitFor(() => expect(openBanner()).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "See what’s new" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onOpenWhatsNew).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps its words while it closes", async () => {
    mockReleaseNotes([highlights(INCOMING, ["Incoming highlight"])], INCOMING);
    const { openBanner, rerender } = renderBanner();
    await waitFor(() => expect(openBanner()).not.toBeNull());

    rerender(false);

    expect(openBanner()).toBeNull();
    expect(screen.getByText(`v${INCOMING} is ready`)).toBeTruthy();
  });

  it("refreshes the incoming version when another deploy arrives while one waits", async () => {
    vi.useFakeTimers();
    mockReleaseNotes([highlights(INCOMING, ["First incoming highlight"])], INCOMING);
    const { onReload, openBanner, unmount } = renderBanner();

    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(openBanner()).not.toBeNull();
      expect(screen.getByText(`v${INCOMING} is ready`)).toBeTruthy();
      expect(screen.getByText("First incoming highlight")).toBeTruthy();

      mockReleaseNotes([highlights(NEXT_INCOMING, ["Next incoming highlight"])], NEXT_INCOMING);
      await act(() => vi.advanceTimersByTimeAsync(60_000));

      expect(screen.getByText(`v${NEXT_INCOMING} is ready`)).toBeTruthy();
      expect(screen.getByText("Next incoming highlight")).toBeTruthy();
      expect(screen.queryByText("First incoming highlight")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      expect(onReload).toHaveBeenCalledTimes(1);
      expect(window.localStorage.getItem(RELOADING_INTO_KEY)).toBe(NEXT_INCOMING);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });
});

describe("UpdateBanner slow ready refreshes", () => {
  const releaseResponse = (version: string, summary: string) =>
    ({
      json: () =>
        Promise.resolve([
          {
            date: "2026-07-29T00:00:00Z",
            hash: "release",
            release: {
              changelogUrl: `${REPOSITORY_URL}/blob/main/CHANGELOG.md`,
              notes: [highlights(version, [summary])],
              repositoryUrl: REPOSITORY_URL,
              truncated: false,
              version,
            },
            subject: "release",
          },
        ]),
      ok: true,
    }) as Response;
  const settle = () =>
    act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

  it("opens when a ready changelog request takes longer than the refresh interval", async () => {
    vi.useFakeTimers();
    const pending: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
    );
    const { openBanner, unmount } = renderBanner();

    try {
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(pending).toHaveLength(2);

      pending[0]?.(releaseResponse(INCOMING, "Incoming highlight"));
      await settle();

      expect(openBanner()).not.toBeNull();
      expect(screen.getByText(`v${INCOMING} is ready`)).toBeTruthy();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("keeps a newer changelog when an older request settles after it", async () => {
    vi.useFakeTimers();
    const pending: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
    );
    const { openBanner, unmount } = renderBanner();

    try {
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      pending[1]?.(releaseResponse(NEXT_INCOMING, "Next incoming highlight"));
      await settle();
      pending[0]?.(releaseResponse(INCOMING, "First incoming highlight"));
      await settle();

      expect(openBanner()).not.toBeNull();
      expect(screen.getByText(`v${NEXT_INCOMING} is ready`)).toBeTruthy();
      expect(screen.queryByText("First incoming highlight")).toBeNull();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });
});

describe("UpdateBanner loading", () => {
  it("still opens, without a highlight, when the changelog is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { container, openBanner } = renderBanner();

    await waitFor(() => expect(openBanner()).not.toBeNull());

    expect(screen.getByText("Update ready")).toBeTruthy();
    expect(container.querySelector(".update-banner-highlight")).toBeNull();
  });

  it("fetches the changelog from the app base after soft navigation into a nested route", async () => {
    mockReleaseNotes([highlights(APP_VERSION, ["Running release highlight"])]);
    window.history.pushState({}, "", "/docs/about");
    try {
      const { openBanner } = renderBanner();
      await waitFor(() => expect(openBanner()).not.toBeNull());

      const [request] = vi.mocked(fetch).mock.calls[0] ?? [];
      expect(new URL(String(request), document.baseURI).pathname).toBe("/changelog.json");
      expect(screen.getByText("Update ready")).toBeTruthy();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("stays closed until the changelog settles", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const { openBanner } = renderBanner();

    expect(openBanner()).toBeNull();
  });
});
