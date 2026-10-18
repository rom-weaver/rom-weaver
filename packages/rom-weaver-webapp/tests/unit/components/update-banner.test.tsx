// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { APP_VERSION } from "../../../src/webapp/build-version.ts";
import { UpdateBanner, type UpdateBannerKind } from "../../../src/webapp/components/update-banner.tsx";

const REPOSITORY_URL = "https://github.com/rom-weaver/rom-weaver";
const LAST_SEEN_KEY = "rom-weaver-last-seen-version";
const RELOADING_INTO_KEY = "rom-weaver-reloading-into-version";
const INCOMING = `${Number.parseInt(APP_VERSION, 10) + 1}.0.0`;

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

const renderBanner = (kind: UpdateBannerKind | null, since: { from?: string } | null = null) => {
  const handlers = { onDismiss: vi.fn(), onOpenWhatsNew: vi.fn(), onReload: vi.fn() };
  const view = render(
    <RomWeaverSettingsProvider settings={{}}>
      <UpdateBanner kind={kind} since={since} {...handlers} />
    </RomWeaverSettingsProvider>,
  );
  const openBanner = () => view.container.querySelector(".reveal.is-open .update-banner");
  const rerender = (next: UpdateBannerKind | null, nextSince = since) =>
    view.rerender(
      <RomWeaverSettingsProvider settings={{}}>
        <UpdateBanner kind={next} since={nextSince} {...handlers} />
      </RomWeaverSettingsProvider>,
    );
  return { ...handlers, container: view.container, openBanner, rerender };
};

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("UpdateBanner after an update", () => {
  it("names both versions and leads with the newest highlight", async () => {
    mockReleaseNotes([
      highlights(APP_VERSION, ["Running release highlight", "Second highlight"]),
      highlights("0.0.2", ["Skipped release highlight"]),
    ]);
    const { container, openBanner } = renderBanner("updated", { from: "0.0.1" });

    await waitFor(() => expect(openBanner()).not.toBeNull());

    expect(screen.getByText(`Updated from v0.0.1 to v${APP_VERSION}`)).toBeTruthy();
    expect(screen.getByText("Running release highlight")).toBeTruthy();
    expect(screen.queryByText("Second highlight")).toBeNull();
    expect(screen.queryByText("Skipped release highlight")).toBeNull();
    expect(container.querySelector(".update-ready")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("passes over a new release without highlights, but never an old one", async () => {
    mockReleaseNotes([
      { groups: [{ entries: [{ summary: "a fix" }], title: "Bug Fixes" }], version: APP_VERSION },
      highlights("0.0.2", ["Skipped release highlight"]),
      highlights("0.0.1", ["Already seen highlight"]),
    ]);
    const { openBanner } = renderBanner("updated", { from: "0.0.1" });

    await waitFor(() => expect(openBanner()).not.toBeNull());

    expect(screen.getByText("Skipped release highlight")).toBeTruthy();
    expect(screen.queryByText("Already seen highlight")).toBeNull();
  });

  it("names only the running version when the earlier one is unknown", async () => {
    mockReleaseNotes([highlights(APP_VERSION, ["Running release highlight"])]);
    const { openBanner } = renderBanner("updated", {});

    await waitFor(() => expect(openBanner()).not.toBeNull());

    expect(screen.getByText(`Updated to v${APP_VERSION}`)).toBeTruthy();
  });

  it("opens What's new and dismisses from its own controls", async () => {
    mockReleaseNotes([highlights(APP_VERSION, ["Running release highlight"])]);
    const { onDismiss, onOpenWhatsNew, openBanner } = renderBanner("updated", { from: "0.0.1" });
    await waitFor(() => expect(openBanner()).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "See what’s new" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onOpenWhatsNew).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps its words while it closes", async () => {
    mockReleaseNotes([highlights(APP_VERSION, ["Running release highlight"])]);
    const { openBanner, rerender } = renderBanner("updated", { from: "0.0.1" });
    await waitFor(() => expect(openBanner()).not.toBeNull());

    rerender(null, null);

    expect(openBanner()).toBeNull();
    expect(screen.getByText(`Updated from v0.0.1 to v${APP_VERSION}`)).toBeTruthy();
  });
});

describe("UpdateBanner with a deploy waiting", () => {
  it("names the incoming release and leads with its highlight", async () => {
    mockReleaseNotes(
      [highlights(INCOMING, ["Incoming highlight"]), highlights(APP_VERSION, ["Running release highlight"])],
      INCOMING,
    );
    const { container, openBanner } = renderBanner("ready");

    await waitFor(() => expect(openBanner()).not.toBeNull());

    expect(screen.getByText(`v${INCOMING} is ready`)).toBeTruthy();
    expect(screen.getByText("Incoming highlight")).toBeTruthy();
    expect(screen.queryByText("Running release highlight")).toBeNull();
    expect(container.querySelector(".update-banner.update-ready")).not.toBeNull();
  });

  it("says only that an update is ready when the version did not change", async () => {
    mockReleaseNotes([highlights(APP_VERSION, ["Running release highlight"])]);
    const { container, openBanner } = renderBanner("ready");

    await waitFor(() => expect(openBanner()).not.toBeNull());

    expect(screen.getByText("Update ready")).toBeTruthy();
    expect(container.querySelector(".update-banner-highlight")).toBeNull();
  });

  it("records the incoming release on reload, for the next load to confirm", async () => {
    mockReleaseNotes([highlights(INCOMING, ["Incoming highlight"])], INCOMING);
    const { onReload, openBanner } = renderBanner("ready");
    await waitFor(() => expect(openBanner()).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(RELOADING_INTO_KEY)).toBe(INCOMING);
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).toBeNull();
  });

  it("leaves an unacknowledged update to announce itself after the reload", async () => {
    window.localStorage.setItem(LAST_SEEN_KEY, "0.0.1");
    mockReleaseNotes([highlights(INCOMING, ["Incoming highlight"])], INCOMING);
    const { onReload, openBanner } = renderBanner("ready", { from: "0.0.1" });
    await waitFor(() => expect(openBanner()).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).toBe("0.0.1");
  });

  it("refetches the changelog when a deploy becomes ready", async () => {
    mockReleaseNotes([highlights(APP_VERSION, ["Running release highlight"])]);
    const { openBanner, rerender } = renderBanner("updated", {});
    await waitFor(() => expect(openBanner()).not.toBeNull());
    mockReleaseNotes([highlights(INCOMING, ["Incoming highlight"])], INCOMING);

    rerender("ready");

    await waitFor(() => expect(screen.queryByText(`v${INCOMING} is ready`)).not.toBeNull());
    expect(openBanner()).not.toBeNull();
  });
});

describe("UpdateBanner loading", () => {
  it("still opens, without a highlight, when the changelog is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { container, openBanner } = renderBanner("ready");

    await waitFor(() => expect(openBanner()).not.toBeNull());

    expect(screen.getByText("Update ready")).toBeTruthy();
    expect(container.querySelector(".update-banner-highlight")).toBeNull();
  });

  it("fetches the changelog from the app base after soft navigation into a nested route", async () => {
    mockReleaseNotes([highlights(APP_VERSION, ["Running release highlight"])]);
    window.history.pushState({}, "", "/docs/about");
    try {
      const { openBanner } = renderBanner("updated", { from: "0.0.1" });
      await waitFor(() => expect(openBanner()).not.toBeNull());

      const [request] = vi.mocked(fetch).mock.calls[0] ?? [];
      expect(new URL(String(request), document.baseURI).pathname).toBe("/changelog.json");
      expect(screen.getByText("Running release highlight")).toBeTruthy();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("stays closed until the changelog settles", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const { openBanner } = renderBanner("updated", { from: "0.0.1" });

    expect(openBanner()).toBeNull();
  });
});
