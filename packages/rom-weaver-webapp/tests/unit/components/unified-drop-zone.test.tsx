// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UnifiedDropZone } from "../../../src/public/react/components/ds/unified-drop-zone.tsx";
import { WORKFLOW_GUIDES } from "../../../src/public/react/workflow-guides.ts";
import { DOC_SOURCES } from "../../../src/webapp/docs-routing.mjs";

/**
 * The 0x01 INPUTS step contract: hero vs add-row state classes, the composed
 * hint line, and the stable unified input id every workflow's tests upload
 * through.
 */

describe("UnifiedDropZone", () => {
  it("renders the empty-state hero as the 0x01 Inputs step", () => {
    const { container } = render(
      <UnifiedDropZone
        big
        inputId="rom-weaver-input-file-unified"
        label="Drop a ROM or patches"
        onFiles={() => undefined}
        supported={[
          { extensions: ["sfc", "nes"], label: "ROMs" },
          { extensions: ["ips", "zip"], label: "Patches and archives" },
        ]}
      />,
    );
    const step = container.querySelector("section.step.is-input.is-empty");
    expect(step).toBeTruthy();
    expect(step?.querySelector("h1")?.textContent).toBe("Patch ROMs in your browser.");
    expect(step?.querySelector("h1")?.closest("label, button")).toBeNull();
    expect(step?.querySelector(".step-num")?.textContent).toBe("0x01");
    expect(step?.querySelector(".step-title")?.textContent).toBe("Inputs");
    expect(step?.querySelector(".drop.hero.bare")).toBeTruthy();
    expect(step?.querySelector(".formats")).toBeNull();
    expect(step?.querySelector(".hero-formats-help")?.textContent).toContain("sfc, nes");
    expect(step?.querySelector(".hero-formats-help")?.textContent).toContain("ips, zip");
    expect(step?.querySelector(".hint")).toBeNull();
    expect(step?.querySelector("input[type=file]")?.id).toBe("rom-weaver-input-file-unified");
  });

  it("shrinks to the add-row once content is staged", () => {
    const { container } = render(
      <UnifiedDropZone inputId="rom-weaver-input-file-unified" label="Add more" onFiles={() => undefined} />,
    );
    const step = container.querySelector("section.step.is-input");
    expect(step?.classList.contains("is-empty")).toBe(false);
    expect(step?.querySelector("h1.sr-only")?.textContent).toBe("Patch ROMs in your browser.");
    expect(step?.querySelector(".drop.hero")).toBeNull();
    expect(step?.querySelector(".drop .main.btnish")).toBeTruthy();
    expect(step?.querySelector(".hero-formats-help")).toBeNull();
  });

  it("keeps the full supported list outside the file-picker label", () => {
    const { container } = render(
      <UnifiedDropZone
        big
        addLabel="Add files"
        heroLabel="Drop files"
        heroLabelCoarse="Tap to add files"
        onFiles={() => undefined}
        supported={[{ label: "ROMs", extensions: ["sfc", "nes", "iso", "bin", "gba", "nds"] }]}
      />,
    );
    expect(container.querySelector(".formats")).toBeNull();
    const disclosure = container.querySelector("details.hero-formats-help");
    expect(disclosure?.hasAttribute("open")).toBe(false);
    expect(disclosure?.querySelector("summary")?.textContent).toBe("Supported formats");
    expect(disclosure?.textContent).toContain("sfc, nes, iso, bin, gba, nds");
    expect(disclosure?.closest("label")).toBeNull();
  });

  it("puts onboarding and the workflow guide on one help line above the formats", () => {
    const { container } = render(
      <UnifiedDropZone
        big
        guide={{ path: "docs/apply-rom-patches", label: "ui.hero.applyGuide" }}
        onFiles={() => undefined}
        onboarding={<button className="onboarding-probe" type="button" />}
        supported={[{ label: "ROMs", extensions: ["sfc"] }]}
      />,
    );
    const help = container.querySelector(".hero-help");
    const links = help?.querySelector(":scope > .hero-help-links");
    expect(links?.firstElementChild?.className).toBe("onboarding-probe");
    const guide = links?.querySelector("a.hero-guide");
    expect(guide?.getAttribute("href")).toBe("/docs/apply-rom-patches");
    expect(guide?.textContent).toBe("Read the Apply guide");
    expect(guide?.closest("label")).toBeNull();
    expect(links?.nextElementSibling?.matches("details.hero-formats-help")).toBe(true);
  });

  it("prerenders the guide link relative to the page, like the nav links", () => {
    // Before hydration the app base is unknown; a root-absolute href would
    // leave a sub-path deployment on a missing page.
    const html = renderToString(<UnifiedDropZone big guide={WORKFLOW_GUIDES.apply} onFiles={() => undefined} />);
    expect(html).toContain('href="docs/apply-rom-patches"');
  });

  it.each(Object.entries(WORKFLOW_GUIDES))("links the %s guide to a published doc", (_workflow, guide) => {
    expect(DOC_SOURCES.some((source) => source.slug === guide.path)).toBe(true);
    const { container } = render(<UnifiedDropZone big guide={guide} onFiles={() => undefined} />);
    expect(container.querySelector(".hero-guide")?.textContent).toMatch(/^Read the .+ guide$/u);
  });

  it("drops the help line once content is staged", () => {
    const { container } = render(
      <UnifiedDropZone
        guide={{ path: "docs/apply-rom-patches", label: "ui.hero.applyGuide" }}
        onFiles={() => undefined}
        onboarding={<button className="onboarding-probe" type="button" />}
      />,
    );
    expect(container.querySelector(".hero-help")).toBeNull();
    expect(container.querySelector(".onboarding-probe")).toBeNull();
  });

  it("opens the existing file input from the Inputs heading action", () => {
    const { container } = render(
      <UnifiedDropZone inputId="rom-weaver-input-file-unified" label="Add more" onFiles={() => undefined} />,
    );
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(container.querySelector(".step-head-action") as HTMLButtonElement);
    expect(click).toHaveBeenCalledTimes(1);
  });
});
