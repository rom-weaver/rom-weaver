// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { APP_VERSION } from "../../../src/webapp/build-version.ts";
import { ChangelogDialog } from "../../../src/webapp/components/changelog-dialog.tsx";

const REPOSITORY_URL = "https://github.com/rom-weaver/rom-weaver";
const CHANGELOG_URL = `${REPOSITORY_URL}/blob/main/CHANGELOG.md`;

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

const renderDialog = () => render(withSettings(<ChangelogDialog onClose={vi.fn()} onReload={vi.fn()} open />));

afterEach(() => vi.unstubAllGlobals());

describe("ChangelogDialog", () => {
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

    renderDialog();

    expect(await screen.findByText(`v${APP_VERSION} → v9.9.9`)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Features" })).toBeTruthy();
    expect(screen.getByText("Shiny release feature")).toBeTruthy();
    expect(screen.getByText("webapp:")).toBeTruthy();
    expect(screen.getByRole("link", { name: "#3" }).getAttribute("href")).toBe(`${REPOSITORY_URL}/pull/3`);
    expect(screen.getByRole("link", { name: "Full changelog" }).getAttribute("href")).toBe(CHANGELOG_URL);
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

    renderDialog();

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

    renderDialog();

    expect((await screen.findByRole("link", { name: "abc1234" })).getAttribute("href")).toBe(
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

    renderDialog();

    expect(await screen.findByText("newest")).toBeTruthy();
    expect(screen.getByText("skipped")).toBeTruthy();
    // The running version's own notes are not "what you're about to get".
    expect(screen.queryByText("already running")).toBeNull();
    expect(screen.getByRole("link", { name: "v9.8.0" }).getAttribute("href")).toBe(
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

    renderDialog();

    expect(await screen.findByText("Some change")).toBeTruthy();
    // The commit view, not the release view: no version transition to 9.9.9.
    expect(screen.queryByText(`v${APP_VERSION} → v9.9.9`)).toBeNull();
    // It still gets a header, falling back to the built-in changelog url.
    expect(screen.getByRole("link", { name: "Full changelog" }).getAttribute("href")).toBe(CHANGELOG_URL);
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

    renderDialog();

    expect(await screen.findByText("Nightly change")).toBeTruthy();
    expect(screen.queryByText("Previous release")).toBeNull();
    // No version bump, so the header shows the build the commits move to.
    expect(screen.getByText("dev → nightly")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Full changelog" }).getAttribute("href")).toBe(CHANGELOG_URL);
  });

  it("renders commits as changelog groups, in release-please's order", async () => {
    mockChangelog([
      { date: "", hash: "a", subject: "fix(webapp): center the swap control (#253)" },
      { date: "", hash: "b", subject: "feat(cli): add a flag" },
      { date: "", hash: "c", subject: "not a conventional commit" },
      { date: "2026-07-28T00:00:00Z", hash: "dev", subject: "Current build" },
    ]);

    renderDialog();

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

  it("skips the subject-less placeholder a git-less build uses to carry the notes", async () => {
    mockChangelog([
      {
        date: "",
        hash: "v9.9.9",
        release: releaseOf("9.9.9", [noteOf("9.9.9", [{ summary: "docker release" }])]),
        subject: "",
      },
    ]);

    renderDialog();

    expect(await screen.findByText("docker release")).toBeTruthy();
    expect(screen.queryByText("v9.9.9")).toBeNull();
  });
});
