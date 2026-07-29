// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { APP_VERSION } from "../../../src/webapp/build-version.ts";
import { ChangelogDialog } from "../../../src/webapp/components/changelog-dialog.tsx";

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

afterEach(() => vi.unstubAllGlobals());

describe("ChangelogDialog", () => {
  it("shows the full release notes and links the incoming version to its GitHub release", async () => {
    mockChangelog([
      {
        date: "2026-07-29T00:00:00Z",
        hash: "release",
        release: {
          html: "<h3>Features</h3><ul><li>Shiny release feature</li></ul>",
          url: "https://github.com/rom-weaver/rom-weaver/releases/tag/v9.9.9",
          version: "9.9.9",
        },
        subject: "release",
      },
    ]);

    render(withSettings(<ChangelogDialog onClose={vi.fn()} onReload={vi.fn()} open />));

    expect(await screen.findByText(`v${APP_VERSION} → v9.9.9`)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Features" })).toBeTruthy();
    expect(screen.getByText("Shiny release feature")).toBeTruthy();
    expect(screen.getByRole("link", { name: "GitHub release v9.9.9" }).getAttribute("href")).toBe(
      "https://github.com/rom-weaver/rom-weaver/releases/tag/v9.9.9",
    );
  });

  it("keeps showing commits when the incoming build has the same version", async () => {
    mockChangelog([
      {
        date: "2026-07-29T00:00:00Z",
        hash: "nightly",
        release: {
          html: "<h3>Previous release</h3>",
          url: `https://github.com/rom-weaver/rom-weaver/releases/tag/v${APP_VERSION}`,
          version: APP_VERSION,
        },
        subject: "Nightly change",
      },
      { date: "2026-07-28T00:00:00Z", hash: "dev", subject: "Current build" },
    ]);

    render(withSettings(<ChangelogDialog onClose={vi.fn()} onReload={vi.fn()} open />));

    expect(await screen.findByText("Nightly change")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /GitHub release/ })).toBeNull();
  });
});
