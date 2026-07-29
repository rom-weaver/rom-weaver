// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { APP_VERSION } from "../../../src/webapp/build-version.ts";
import { ChangelogDialog } from "../../../src/webapp/components/changelog-dialog.tsx";

const CHANGELOG_URL = "https://github.com/rom-weaver/rom-weaver/blob/main/CHANGELOG.md";
const tagUrl = (version: string) => `https://github.com/rom-weaver/rom-weaver/releases/tag/v${version}`;

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
  it("shows the full release notes and links to the changelog", async () => {
    mockChangelog([
      {
        date: "2026-07-29T00:00:00Z",
        hash: "release",
        release: {
          changelogUrl: CHANGELOG_URL,
          notes: [
            {
              html: "<h3>Features</h3><ul><li>Shiny release feature</li></ul>",
              url: tagUrl("9.9.9"),
              version: "9.9.9",
            },
          ],
          truncated: false,
          version: "9.9.9",
        },
        subject: "release",
      },
    ]);

    renderDialog();

    expect(await screen.findByText(`v${APP_VERSION} → v9.9.9`)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Features" })).toBeTruthy();
    expect(screen.getByText("Shiny release feature")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Full changelog" }).getAttribute("href")).toBe(CHANGELOG_URL);
  });

  it("renders every release the running build skipped, newest first", async () => {
    mockChangelog([
      {
        date: "2026-07-29T00:00:00Z",
        hash: "release",
        release: {
          changelogUrl: CHANGELOG_URL,
          notes: [
            { html: "<p>newest</p>", url: tagUrl("9.9.9"), version: "9.9.9" },
            { html: "<p>skipped</p>", url: tagUrl("9.8.0"), version: "9.8.0" },
            { html: "<p>already running</p>", url: tagUrl(APP_VERSION), version: APP_VERSION },
          ],
          truncated: false,
          version: "9.9.9",
        },
        subject: "release",
      },
    ]);

    renderDialog();

    expect(await screen.findByText("newest")).toBeTruthy();
    expect(screen.getByText("skipped")).toBeTruthy();
    // The running version's own notes are not "what you're about to get".
    expect(screen.queryByText("already running")).toBeNull();
    expect(screen.getByRole("link", { name: "v9.8.0" }).getAttribute("href")).toBe(tagUrl("9.8.0"));
  });

  it.each([
    ["a release with no notes", { changelogUrl: CHANGELOG_URL, notes: [], version: "9.9.9" }],
    [
      "a note missing its html",
      { changelogUrl: CHANGELOG_URL, notes: [{ url: "u", version: "9.9.9" }], version: "9.9.9" },
    ],
    ["a non-object release", "release notes"],
  ])("ignores %s and shows commits instead", async (_label, release) => {
    mockChangelog([
      { date: "2026-07-29T00:00:00Z", hash: "a", release, subject: "Some change" },
      { date: "2026-07-28T00:00:00Z", hash: "dev", subject: "Current build" },
    ]);

    renderDialog();

    expect(await screen.findByText("Some change")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Full changelog" })).toBeNull();
  });

  it("keeps showing commits when the incoming build has the same version", async () => {
    mockChangelog([
      {
        date: "2026-07-29T00:00:00Z",
        hash: "nightly",
        release: {
          changelogUrl: CHANGELOG_URL,
          notes: [{ html: "<h3>Previous release</h3>", url: tagUrl(APP_VERSION), version: APP_VERSION }],
          version: APP_VERSION,
        },
        subject: "Nightly change",
      },
      { date: "2026-07-28T00:00:00Z", hash: "dev", subject: "Current build" },
    ]);

    renderDialog();

    expect(await screen.findByText("Nightly change")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Full changelog" })).toBeNull();
  });

  it("skips the subject-less placeholder a git-less build uses to carry the notes", async () => {
    mockChangelog([
      {
        date: "",
        hash: "v9.9.9",
        release: {
          changelogUrl: CHANGELOG_URL,
          notes: [{ html: "<p>docker release</p>", url: tagUrl("9.9.9"), version: "9.9.9" }],
          version: "9.9.9",
        },
        subject: "",
      },
    ]);

    renderDialog();

    expect(await screen.findByText("docker release")).toBeTruthy();
    expect(screen.queryByText("v9.9.9")).toBeNull();
  });
});
