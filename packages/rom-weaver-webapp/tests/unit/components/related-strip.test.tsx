// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { RelatedStrip } from "../../../src/webapp/components/related-strip.tsx";

/**
 * RelatedStrip contract: up to two tool rows plus one guide row, each kind
 * styled distinctly ("Tool" filled/thread-colored, "Guide" outlined), tool
 * rows resolving through the caller's own `onSelectTab` (never a real link),
 * guide rows as plain `<a href>` links, and a beta tool row always present in
 * the markup, marked `data-beta` for the CSS gate rather than filtered out -
 * the prerendered document cannot branch on a per-user setting.
 */

afterEach(cleanup);

const withSettings = (children: ReactNode, settings: Record<string, unknown> = {}) => (
  <RomWeaverSettingsProvider settings={settings}>{children}</RomWeaverSettingsProvider>
);

describe("RelatedStrip", () => {
  it("renders nothing for an entry key with no related links", () => {
    const { container } = render(withSettings(<RelatedStrip entryKey="unknown-key" onSelectTab={vi.fn()} />));
    expect(container.querySelector("nav.related-strip")).toBeNull();
  });

  it("renders nothing for completed Apply, Create, and Trim tools", () => {
    const { container } = render(withSettings(<RelatedStrip entryKey="patcher" onSelectTab={vi.fn()} />));
    expect(container.querySelector("nav.related-strip")).toBeNull();
    expect(
      render(withSettings(<RelatedStrip entryKey="creator" onSelectTab={vi.fn()} />)).container.querySelector(
        "nav.related-strip",
      ),
    ).toBeNull();
    expect(
      render(withSettings(<RelatedStrip entryKey="trim" onSelectTab={vi.fn()} />)).container.querySelector(
        "nav.related-strip",
      ),
    ).toBeNull();
  });

  it("explains that Identify carries its ROM selection into Apply", () => {
    const onSelectTab = vi.fn();
    const { container } = render(withSettings(<RelatedStrip entryKey="identify" onSelectTab={onSelectTab} />));

    expect(container.querySelector(".related-label")?.textContent).toBe("Use this ROM in Apply");
    expect(container.querySelector(".related-hint")?.textContent).toBe("Keeps this selection");
    expect(container.querySelector(".related-row-guide")).toBeNull();
    fireEvent.click(container.querySelector(".related-row-tool") as HTMLButtonElement);
    expect(onSelectTab).toHaveBeenCalledWith("patcher");
  });

  it("renders a guide row as a plain link to the docs slug", () => {
    const { container } = render(withSettings(<RelatedStrip entryKey="not-found" onSelectTab={vi.fn()} />));
    const guideLink = container.querySelector(".related-row-guide") as HTMLAnchorElement;
    expect(guideLink.tagName).toBe("A");
    expect(guideLink.getAttribute("href")).toBe("/docs");
  });

  it("renders only the docs-page tool row for a docs slug key, with no guide row", () => {
    const { container } = render(withSettings(<RelatedStrip entryKey="docs/cli-trim" onSelectTab={vi.fn()} />, {}));
    expect(container.querySelectorAll(".related-row-guide")).toHaveLength(0);
    const labels = [...container.querySelectorAll(".related-row-tool .related-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Trim tool"]);
  });

  it("keeps a beta-only strip in the markup for the CSS gate to hide", () => {
    const { container } = render(
      withSettings(<RelatedStrip entryKey="docs/cli-trim" onSelectTab={vi.fn()} />, { betaToolsEnabled: false }),
    );
    // The strip stays; `:root[data-beta-tools-enabled="false"]` hides the row
    // and, having no unmarked sibling, the whole nav (see result.css).
    expect(container.querySelector("nav.related-strip")).not.toBeNull();
    expect(container.querySelectorAll("li:not([data-beta])")).toHaveLength(0);
  });
});
