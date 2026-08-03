// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalizer } from "../../../src/presentation/localization/index.ts";
import { APP_VERSION } from "../../../src/webapp/build-version.ts";
import { ChangelogPanel } from "../../../src/webapp/components/changelog-panel.tsx";

const REPOSITORY_URL = "https://github.com/rom-weaver/rom-weaver";
const CHANGELOG_URL = `${REPOSITORY_URL}/blob/main/CHANGELOG.md`;
// The commit view shows raw commits, which never reach CHANGELOG.md.
const COMMIT_LOG_URL = `${REPOSITORY_URL}/commits/main`;

const releaseOf = (version: string, notes: unknown[], truncated = false) => ({
  changelogUrl: CHANGELOG_URL,
  notes,
  repositoryUrl: REPOSITORY_URL,
  truncated,
  version,
});

const noteOf = (version: string, entries: unknown[], title = "Features") => ({
  groups: [{ entries, title }],
  version,
});

const mockChangelog = (entries: unknown[]) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      json: () => Promise.resolve(entries),
      ok: true,
    }),
  );
};

const renderPanel = () => render(<ChangelogPanel active localizer={createLocalizer("en")} />);

afterEach(() => vi.unstubAllGlobals());

describe("ChangelogPanel", () => {
  it("renders a release's notes as text and links its tag", async () => {
    mockChangelog([
      {
        date: "2026-07-29T00:00:00Z",
        hash: "release",
        release: releaseOf("9.9.9", [
          noteOf("9.9.9", [{ pr: "3", scope: "webapp", summary: "Shiny release feature" }]),
        ]),
        subject: "release",
      },
    ]);

    renderPanel();

    expect(await screen.findByText("Shiny release feature")).toBeTruthy();
    expect(screen.getByText("webapp:")).toBeTruthy();
    expect(screen.getByRole("link", { name: "#3" }).getAttribute("href")).toBe(`${REPOSITORY_URL}/pull/3`);
    expect(screen.getByRole("link", { name: "View release ↗" }).getAttribute("href")).toBe(
      `${REPOSITORY_URL}/releases/tag/v9.9.9`,
    );
    expect(screen.getByRole("link", { name: "Full changelog ↗" }).getAttribute("href")).toBe(CHANGELOG_URL);
  });

  it("treats markup in a summary as text, never as HTML", async () => {
    const summary = '<img src=x onerror="alert(1)"> markup';
    mockChangelog([
      {
        date: "2026-07-29T00:00:00Z",
        hash: "release",
        release: releaseOf("9.9.9", [noteOf("9.9.9", [{ pr: "3", summary }])]),
        subject: "release",
      },
    ]);

    renderPanel();

    expect(await screen.findByText(summary)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("links the commit when an entry has no pull request", async () => {
    mockChangelog([
      {
        date: "2026-07-29T00:00:00Z",
        hash: "release",
        release: releaseOf("9.9.9", [noteOf("9.9.9", [{ commit: "abc1234", summary: "No PR here" }])]),
        subject: "release",
      },
    ]);

    renderPanel();

    expect((await screen.findByRole("link", { name: "abc1234" })).getAttribute("href")).toBe(
      `${REPOSITORY_URL}/commit/abc1234`,
    );
  });

  it("gives every release its own section, newest first, with the running one marked", async () => {
    mockChangelog([
      {
        date: "2026-07-29T00:00:00Z",
        hash: "release",
        release: releaseOf("9.9.9", [
          noteOf("9.9.9", [{ summary: "newest" }]),
          noteOf("9.8.0", [{ summary: "older" }]),
          noteOf(APP_VERSION, [{ summary: "already running" }]),
        ]),
        subject: "release",
      },
    ]);

    renderPanel();

    // The tab says what is in this build, so nothing is sliced away against the
    // running version - it is labelled instead.
    expect(await screen.findByText("newest")).toBeTruthy();
    expect(screen.getByText("older")).toBeTruthy();
    expect(screen.getByText("already running")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    const sections = Array.from(document.querySelectorAll(".rel-summary b")).map((node) => node.textContent);
    expect(sections.slice(0, 2)).toEqual(["v9.9.9", "v9.8.0"]);
    // Only the newest section is open, because that is why the tab was opened.
    expect(document.querySelectorAll("details.rel[open]").length).toBe(1);
  });

  it.each([
    ["a release with no notes", releaseOf("9.9.9", [])],
    ["a note with no groups array", releaseOf("9.9.9", [{ version: "9.9.9" }])],
    ["a release missing its repository url", { changelogUrl: CHANGELOG_URL, notes: [noteOf("9.9.9", [])] }],
    ["a non-object release", "release notes"],
  ])("ignores %s and shows commits instead", async (_label, release) => {
    mockChangelog([
      { date: "2026-07-29T00:00:00Z", hash: "a", release, subject: "Some change" },
      { date: "2026-07-28T00:00:00Z", hash: "dev", subject: "Current build" },
    ]);

    renderPanel();

    expect(await screen.findByText("Some change")).toBeTruthy();
    // The commit view, not the release view: commits never reach CHANGELOG.md.
    expect(screen.getByRole("link", { name: "Full changelog ↗" }).getAttribute("href")).toBe(COMMIT_LOG_URL);
  });

  it("renders commits as changelog groups, in release-please's order", async () => {
    mockChangelog([
      { date: "", hash: "a", subject: "fix(webapp): center the swap control (#253)" },
      { date: "", hash: "b", subject: "feat(cli): add a flag" },
      { date: "", hash: "c", subject: "not a conventional commit" },
      { date: "2026-07-28T00:00:00Z", hash: "dev", subject: "Current build" },
    ]);

    renderPanel();

    const headings = await screen.findAllByRole("heading");
    expect(headings.map((heading) => heading.textContent)).toEqual(["Features", "Bug Fixes", "Other Changes"]);
    expect(screen.getByText("center the swap control")).toBeTruthy();
    expect(screen.getByText("webapp:")).toBeTruthy();
    // The squash-merge PR reference becomes the entry link.
    expect(screen.getByRole("link", { name: "#253" }).getAttribute("href")).toBe(`${REPOSITORY_URL}/pull/253`);
    // No PR in the subject, so the commit itself is the link.
    expect(screen.getByRole("link", { name: "b" }).getAttribute("href")).toBe(`${REPOSITORY_URL}/commit/b`);
    expect(screen.getByText("not a conventional commit")).toBeTruthy();
  });

  it("offers a retry when the changelog cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    renderPanel();

    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
