// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { APP_VERSION } from "../../../src/webapp/build-version.ts";
import { WhatsNewNotice } from "../../../src/webapp/components/whats-new-notice.tsx";

const REPOSITORY_URL = "https://github.com/rom-weaver/rom-weaver";

const highlights = (version: string, summaries: string[]) => ({
  groups: [
    { entries: summaries.map((summary) => ({ summary })), title: "Highlights" },
    { entries: [{ summary: `${version} internal change` }], title: "Internal" },
  ],
  version,
});

const mockReleaseNotes = (notes: unknown[]) =>
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
              version: APP_VERSION,
            },
            subject: "release",
          },
        ]),
      ok: true,
    }),
  );

const renderNotice = (since: { from?: string }, open = true) => {
  const onDismiss = vi.fn();
  const onOpenWhatsNew = vi.fn();
  const { container } = render(
    <RomWeaverSettingsProvider settings={{}}>
      <WhatsNewNotice onDismiss={onDismiss} onOpenWhatsNew={onOpenWhatsNew} open={open} since={since} />
    </RomWeaverSettingsProvider>,
  );
  const openNotice = () => container.querySelector(".reveal.is-open .updated-notice");
  return { container, onDismiss, onOpenWhatsNew, openNotice };
};

afterEach(() => vi.unstubAllGlobals());

describe("WhatsNewNotice", () => {
  it("names both versions and leads with the newest highlight", async () => {
    mockReleaseNotes([
      highlights(APP_VERSION, ["Running release highlight", "Second highlight"]),
      highlights("0.0.2", ["Skipped release highlight"]),
    ]);
    const { openNotice } = renderNotice({ from: "0.0.1" });

    await waitFor(() => expect(openNotice()).not.toBeNull());

    expect(screen.getByText(`Updated from v0.0.1 to v${APP_VERSION}`)).toBeTruthy();
    expect(screen.getByText("Running release highlight")).toBeTruthy();
    expect(screen.queryByText("Second highlight")).toBeNull();
    expect(screen.queryByText("Skipped release highlight")).toBeNull();
  });

  it("passes over a new release without highlights, but never an old one", async () => {
    mockReleaseNotes([
      { groups: [{ entries: [{ summary: "a fix" }], title: "Bug Fixes" }], version: APP_VERSION },
      highlights("0.0.2", ["Skipped release highlight"]),
      highlights("0.0.1", ["Already seen highlight"]),
    ]);
    const { openNotice } = renderNotice({ from: "0.0.1" });

    await waitFor(() => expect(openNotice()).not.toBeNull());

    expect(screen.getByText("Skipped release highlight")).toBeTruthy();
    expect(screen.queryByText("Already seen highlight")).toBeNull();
  });

  it("names only the running version when the earlier one is unknown", async () => {
    mockReleaseNotes([highlights(APP_VERSION, ["Running release highlight"])]);
    const { openNotice } = renderNotice({});

    await waitFor(() => expect(openNotice()).not.toBeNull());

    expect(screen.getByText(`Updated to v${APP_VERSION}`)).toBeTruthy();
  });

  it("still opens, without a highlight, when the changelog is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { container, openNotice } = renderNotice({ from: "0.0.1" });

    await waitFor(() => expect(openNotice()).not.toBeNull());

    expect(container.querySelector(".updated-highlight")).toBeNull();
  });

  it("stays closed until the changelog settles", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const { openNotice } = renderNotice({ from: "0.0.1" });

    expect(openNotice()).toBeNull();
  });

  it("opens What's new and dismisses from its own controls", async () => {
    mockReleaseNotes([highlights(APP_VERSION, ["Running release highlight"])]);
    const { onDismiss, onOpenWhatsNew, openNotice } = renderNotice({ from: "0.0.1" });
    await waitFor(() => expect(openNotice()).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "See what’s new" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onOpenWhatsNew).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
