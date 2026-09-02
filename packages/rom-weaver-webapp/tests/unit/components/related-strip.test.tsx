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

  it("renders the Apply result's tool and guide rows with the right kinds", () => {
    const { container } = render(withSettings(<RelatedStrip entryKey="patcher" onSelectTab={vi.fn()} />));
    const rows = container.querySelectorAll(".related-row");
    // Test this ROM (tool), Identify this file (beta tool, enabled by default), guide.
    expect(rows).toHaveLength(3);
    const kinds = [...rows].map((row) => row.querySelector(".related-kind")?.textContent);
    expect(kinds).toEqual(["Tool", "Tool", "Guide"]);
    expect(container.querySelectorAll(".related-row-tool")).toHaveLength(2);
    expect(container.querySelectorAll(".related-row-guide")).toHaveLength(1);
  });

  it("renders the same rows whatever the beta-tools setting says", () => {
    const readLabels = (settings: Record<string, unknown>) => {
      const { container } = render(withSettings(<RelatedStrip entryKey="patcher" onSelectTab={vi.fn()} />, settings));
      return [...container.querySelectorAll(".related-row-tool .related-label")].map((el) => el.textContent);
    };
    expect(readLabels({ betaToolsEnabled: false })).toEqual(["Test this ROM", "Identify this file"]);
    cleanup();
    expect(readLabels({})).toEqual(["Test this ROM", "Identify this file"]);
  });

  it("marks only the beta tool row for the CSS gate", () => {
    const { container } = render(withSettings(<RelatedStrip entryKey="patcher" onSelectTab={vi.fn()} />));
    const betaLabels = [...container.querySelectorAll('li[data-beta="true"] .related-label')].map(
      (el) => el.textContent,
    );
    expect(betaLabels).toEqual(["Identify this file"]);
  });

  it("resolves a tool row through onSelectTab with the target view id, not a link", () => {
    const onSelectTab = vi.fn();
    const { container } = render(withSettings(<RelatedStrip entryKey="patcher" onSelectTab={onSelectTab} />));
    const toolButton = container.querySelector(".related-row-tool") as HTMLButtonElement;
    expect(toolButton.tagName).toBe("BUTTON");
    fireEvent.click(toolButton);
    expect(onSelectTab).toHaveBeenCalledWith("test");
  });

  it("renders a guide row as a plain link to the docs slug", () => {
    const { container } = render(withSettings(<RelatedStrip entryKey="patcher" onSelectTab={vi.fn()} />));
    const guideLink = container.querySelector(".related-row-guide") as HTMLAnchorElement;
    expect(guideLink.tagName).toBe("A");
    expect(guideLink.getAttribute("href")).toBe("/docs/fix-checksum-errors");
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
