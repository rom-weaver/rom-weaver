// @vitest-environment happy-dom
import { render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider, useUiLocalizer } from "../../../src/public/react/settings-context.tsx";
import { APP_VERSION } from "../../../src/webapp/build-version.ts";
import { ChangelogPanel } from "../../../src/webapp/components/changelog-panel.tsx";

/**
 * The pending-update half of the Changelog tab - what the waiting deploy would
 * bring. Every query is scoped to that section, because the shipped list below
 * it renders the same `changelog.json` asked the other question.
 */

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

const UpdatingPanel = () => <ChangelogPanel active localizer={useUiLocalizer()} onReload={vi.fn()} updateReady />;
const SettledPanel = () => <ChangelogPanel active localizer={useUiLocalizer()} />;

const withSettings = (children: ReactNode) => (
  <RomWeaverSettingsProvider settings={{}}>{children}</RomWeaverSettingsProvider>
);

const mockChangelog = (entries: unknown[]) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      json: () => Promise.resolve(entries),
      ok: true,
    }),
  );
};

// The update section is the scope every assertion below belongs to.
const renderUpdate = async () => {
  const { container } = render(withSettings(<UpdatingPanel />));
  await waitFor(() => expect(container.querySelector(".changelog-update")).toBeTruthy());
  return within(container.querySelector(".changelog-update") as HTMLElement);
};

afterEach(() => vi.unstubAllGlobals());

describe("ChangelogPanel pending update", () => {
  it("renders the release notes as text and links the changelog", async () => {
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

    const update = await renderUpdate();

    // Each side of the header transition links to its release on GitHub.
    expect(
      (await update.findByRole("link", { name: `currently running version ${APP_VERSION}` })).getAttribute("href"),
    ).toBe(`${REPOSITORY_URL}/releases/tag/v${APP_VERSION}`);
    expect(update.getByRole("link", { name: "updating to version 9.9.9" }).getAttribute("href")).toBe(
      `${REPOSITORY_URL}/releases/tag/v9.9.9`,
    );
    expect(update.getByRole("heading", { name: "Features" })).toBeTruthy();
    expect(update.getByText("Shiny release feature")).toBeTruthy();
    expect(update.getByText("webapp:")).toBeTruthy();
    expect(update.getByRole("link", { name: "#3" }).getAttribute("href")).toBe(`${REPOSITORY_URL}/pull/3`);
    expect(update.getByRole("link", { name: "Full changelog" }).getAttribute("href")).toBe(CHANGELOG_URL);
  });

  it("offers the reload the update asks for", async () => {
    mockChangelog([{ date: "", hash: "a", subject: "feat(cli): add a flag" }]);

    const update = await renderUpdate();

    expect(await update.findByRole("button", { name: "Reload now" })).toBeTruthy();
  });

  it("stays out of the way when no update is waiting", async () => {
    mockChangelog([{ date: "", hash: "a", subject: "feat(cli): add a flag" }]);

    const { container } = render(withSettings(<SettledPanel />));

    await screen.findByText("add a flag");
    expect(container.querySelector(".changelog-update")).toBeNull();
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

    const update = await renderUpdate();

    expect(await update.findByText(summary)).toBeTruthy();
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

    const update = await renderUpdate();

    expect((await update.findByRole("link", { name: "abc1234" })).getAttribute("href")).toBe(
      `${REPOSITORY_URL}/commit/abc1234`,
    );
  });

  it("renders every release the running build skipped, newest first", async () => {
    mockChangelog([
      {
        date: "2026-07-29T00:00:00Z",
        hash: "release",
        release: releaseOf("9.9.9", [
          noteOf("9.9.9", [{ summary: "newest" }]),
          noteOf("9.8.0", [{ summary: "skipped" }]),
          noteOf(APP_VERSION, [{ summary: "already running" }]),
        ]),
        subject: "release",
      },
    ]);

    const update = await renderUpdate();

    expect(await update.findByText("newest")).toBeTruthy();
    expect(update.getByText("skipped")).toBeTruthy();
    // The running version's own notes are not "what you're about to get".
    expect(update.queryByText("already running")).toBeNull();
    expect(update.getByRole("link", { name: "v9.8.0" }).getAttribute("href")).toBe(
      `${REPOSITORY_URL}/releases/tag/v9.8.0`,
    );
  });

  it.each([
    ["a release with no notes", releaseOf("9.9.9", [])],
    ["a note whose entries lack a summary", releaseOf("9.9.9", [noteOf("9.9.9", [{ pr: "3" }])])],
    ["a note with no groups array", releaseOf("9.9.9", [{ version: "9.9.9" }])],
    ["a release missing its repository url", { changelogUrl: CHANGELOG_URL, notes: [noteOf("9.9.9", [])] }],
    ["a non-object release", "release notes"],
  ])("ignores %s and shows commits instead", async (_label, release) => {
    mockChangelog([
      { date: "2026-07-29T00:00:00Z", hash: "a", release, subject: "Some change" },
      { date: "2026-07-28T00:00:00Z", hash: "dev", subject: "Current build" },
    ]);

    const update = await renderUpdate();

    expect(await update.findByText("Some change")).toBeTruthy();
    // The commit view, not the release view: no version transition to 9.9.9.
    expect(update.queryByText(`v${APP_VERSION} → v9.9.9`)).toBeNull();
    // It still gets a header, pointing at the commit log.
    expect(update.getByRole("link", { name: "Full changelog" }).getAttribute("href")).toBe(COMMIT_LOG_URL);
  });

  it("keeps showing commits when the incoming build has the same version", async () => {
    mockChangelog([
      {
        date: "2026-07-29T00:00:00Z",
        hash: "nightly",
        release: releaseOf(APP_VERSION, [noteOf(APP_VERSION, [{ summary: "Previous release" }])]),
        subject: "Nightly change",
      },
      { date: "2026-07-28T00:00:00Z", hash: "dev", subject: "Current build" },
    ]);

    const update = await renderUpdate();

    expect(await update.findByText("Nightly change")).toBeTruthy();
    expect(update.queryByText("Previous release")).toBeNull();
    // No version bump, so each side of the header is a build, linking its commit.
    expect(update.getByRole("link", { name: "currently running build dev" }).getAttribute("href")).toBe(
      `${REPOSITORY_URL}/commit/dev`,
    );
    expect(update.getByRole("link", { name: "updating to build nightly" }).getAttribute("href")).toBe(
      `${REPOSITORY_URL}/commit/nightly`,
    );
    expect(update.getByRole("link", { name: "Full changelog" }).getAttribute("href")).toBe(COMMIT_LOG_URL);
  });

  it("repeats the full-changelog link at the end of a truncated release", async () => {
    mockChangelog([
      {
        date: "2026-07-29T00:00:00Z",
        hash: "release",
        release: releaseOf("9.9.9", [noteOf("9.9.9", [{ summary: "newest" }])], true),
        subject: "release",
      },
    ]);

    const update = await renderUpdate();

    // One in the header, one where the entries run out. Both reach CHANGELOG.md.
    const links = await update.findAllByRole("link", { name: "Full changelog" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([CHANGELOG_URL, CHANGELOG_URL]);
  });

  it("repeats the commit-log link at the end of a truncated commit list", async () => {
    // No entry matches the running build, so the window itself is truncated.
    mockChangelog([{ date: "", hash: "a", subject: "feat(cli): add a flag" }]);

    const update = await renderUpdate();

    const links = await update.findAllByRole("link", { name: "Full changelog" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([COMMIT_LOG_URL, COMMIT_LOG_URL]);
  });

  it("renders commits as changelog groups, in release-please's order", async () => {
    mockChangelog([
      { date: "", hash: "a", subject: "fix(webapp): center the swap control (#253)" },
      { date: "", hash: "b", subject: "feat(cli): add a flag" },
      { date: "", hash: "c", subject: "not a conventional commit" },
      { date: "2026-07-28T00:00:00Z", hash: "dev", subject: "Current build" },
    ]);

    const update = await renderUpdate();

    const headings = await update.findAllByRole("heading");
    expect(headings.map((heading) => heading.textContent)).toEqual(["Features", "Bug Fixes", "Other Changes"]);
    expect(update.getByText("center the swap control")).toBeTruthy();
    expect(update.getByText("webapp:")).toBeTruthy();
    // The squash-merge PR reference becomes the entry link.
    expect(update.getByRole("link", { name: "#253" }).getAttribute("href")).toBe(`${REPOSITORY_URL}/pull/253`);
    // No PR in the subject, so the commit itself is the link.
    expect(update.getByRole("link", { name: "b" }).getAttribute("href")).toBe(`${REPOSITORY_URL}/commit/b`);
    expect(update.getByText("not a conventional commit")).toBeTruthy();
  });

  it("skips the subject-less placeholder a git-less build uses to carry the notes", async () => {
    mockChangelog([
      {
        date: "",
        hash: "v9.9.9",
        release: releaseOf("9.9.9", [noteOf("9.9.9", [{ summary: "docker release" }])]),
        subject: "",
      },
    ]);

    const update = await renderUpdate();

    expect(await update.findByText("docker release")).toBeTruthy();
    // The placeholder's hash is not a commit, so nothing links it as one.
    expect(update.queryByRole("link", { name: "v9.9.9" })?.getAttribute("href")).toBe(
      `${REPOSITORY_URL}/releases/tag/v9.9.9`,
    );
    expect(document.querySelector(`a[href="${REPOSITORY_URL}/commit/v9.9.9"]`)).toBeNull();
  });
});
