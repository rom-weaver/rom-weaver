// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../../src/presentation/localization/catalog.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { HomeLoom } from "../../src/webapp/components/home-loom.tsx";
import { HomePage } from "../../src/webapp/components/home-page.tsx";
import { navigatorWith } from "./navigator-test-utils.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  await Promise.all([loadCatalog("de"), loadCatalog("es")]);
});

describe("HomeLoom", () => {
  it("labels the original, each patch in order, and the checked result", () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{ language: "en" }}>
        <HomeLoom />
      </RomWeaverSettingsProvider>,
    );
    expect(container.querySelector(".home-loom-beam.home-loom-top")?.textContent).toBe("game.chd");
    expect(Array.from(container.querySelectorAll(".home-loom-label"), (label) => label.textContent)).toEqual([
      "1translation.bps.rar",
      "2bugfix.ips.zip",
      "3undub.xdelta.7z",
    ]);
    expect(container.querySelector(".home-loom-beam.home-loom-bottom")?.textContent).toBe(
      "patched-game.chdSHA-1 checked",
    );
    expect(container.querySelector("figcaption")?.textContent).toContain("Patches apply in the order shown");
    // The drawing is decoration; the labels carry its meaning for assistive technology.
    const drawing = Array.from(container.querySelectorAll(".home-loom-bed, .home-loom-band"));
    expect(drawing).toHaveLength(4);
    expect(drawing.every((node) => node.getAttribute("aria-hidden") === "true")).toBe(true);
  });
});

describe("HomePage", () => {
  it("offers separate disc conversion and extraction with offline preparation", () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{ language: "en" }}>
        <HomePage baseUrl="https://example.com/tools/" />
      </RomWeaverSettingsProvider>,
    );
    const disc = Array.from(container.querySelectorAll(".home-route")).find((row) =>
      row.textContent?.includes("game.chd"),
    );
    expect(disc?.querySelector("a[href='/tools/compress']")?.textContent).toBe("Compress");
    expect(disc?.querySelector("a[href='/tools/extract']")?.textContent).toBe("Extract files");
    expect(disc?.textContent).toContain("ISO or BIN/CUE");
    const offline = container.querySelector("a[href='/tools/docs/browser-settings#prepare-for-offline-use']");
    expect(offline?.textContent).toBe("Prepare for offline use");
    expect(offline?.parentElement?.textContent).toContain("separate downloads");
  });

  it("builds sub-path-safe workflow links and includes the public workflow copy", async () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{ language: "en" }}>
        <HomePage baseUrl="https://example.com/tools/" />
      </RomWeaverSettingsProvider>,
    );
    expect(container.querySelector(".home-practice a")?.getAttribute("href")).toMatch(/^\/tools\//);
    expect(Array.from(container.querySelectorAll(".home-route-go"), (link) => link.getAttribute("href"))).toEqual([
      "/tools/apply-patches",
      "/tools/compress",
      "/tools/extract",
      "/tools/identify-rom",
      "/tools/create-rom-patch",
      "/tools/apply-patches",
      "/tools/test-rom",
      "/tools/checksum",
      "/tools/weave-patches",
    ]);
    expect(container.querySelector("#home-title")?.textContent).toContain("Online ROM patcher.");
    expect(container.textContent).toContain("Keep your files on your device.");
    expect(container.querySelector(".home-main-actions .home-practice")?.textContent).toBe(
      "No files yet? Patch a practice ROM, step by step",
    );
    expect(container.querySelector(".home-main-actions .home-pick")?.textContent).toBe("Choose files");
    expect(container.querySelector(".home-pick #home-file-input")).not.toBeNull();
    expect(container.querySelector("a[href='/tools/docs/supported-formats']")?.textContent).toContain(
      "See every format",
    );
    expect(container.querySelector("a[href='/tools/docs/features']")?.textContent).toContain("See what");
    expect(container.querySelector("a[href='/tools/docs/faq']")).not.toBeNull();
    const formatHeadings = Array.from(container.querySelectorAll(".home-format-group h3"), (item) => item.textContent);
    expect(formatHeadings).toEqual(["20 patch formats", "23 archive and disc formats", "8 checksum types"]);
    expect(container.querySelector(".home-format-group p")?.textContent).toContain(".bps");
    expect(container.querySelectorAll(".home-faq details")).toHaveLength(4);
    expect(container.querySelector(".home-loom-caption")?.textContent).toContain("Patches apply in the order shown");
    expect(Array.from(container.querySelectorAll(".home-trust-list h3"), (item) => item.textContent)).toEqual([
      "Works offline",
      "Originals stay as they were",
      "Open source",
    ]);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", navigatorWith({ clipboard: { writeText } }));
    fireEvent.click(container.querySelector(".home-install-copy") as HTMLButtonElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("install.sh")));
  });

  it.each([
    ["Windows NT 10.0", "Windows (PowerShell)", "Windows", "install.ps1"],
    ["Macintosh; Intel Mac OS X", "macOS / Linux", "macOS / Linux", "install.sh"],
    ["Linux x86_64", "macOS / Linux", "macOS / Linux", "install.sh"],
    ["iPhone; CPU iPhone OS 17_0 like Mac OS X", "macOS / Linux", "macOS / Linux", "install.sh"],
  ])("shows the installer for %s after hydration", (userAgent, label, tab, command) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    const page = (
      <RomWeaverSettingsProvider settings={{ language: "en" }}>
        <HomePage baseUrl="https://example.com/tools/" />
      </RomWeaverSettingsProvider>
    );
    expect(renderToString(page)).toContain("install.sh");
    const { container } = render(page);
    const commands = container.querySelectorAll(".home-install-code");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.textContent).toContain(command);
    expect(container.querySelector(".home-install-copy")?.getAttribute("aria-label")).toBe(`Copy ${label}`);
    expect(container.querySelector(".home-install-methods [aria-pressed='true']")?.textContent).toBe(tab);
    expect(container.querySelector(".home-install-doc")?.textContent).toBe(label);
    expect(container.querySelector(".home-install-doc")?.getAttribute("href")).toContain("/tools/docs/install#");
  });

  it("switches the install command when another method is picked", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Linux x86_64");
    const { container } = render(
      <RomWeaverSettingsProvider settings={{ language: "en" }}>
        <HomePage baseUrl="https://example.com/tools/" />
      </RomWeaverSettingsProvider>,
    );
    const npm = Array.from(container.querySelectorAll(".home-install-methods button")).find(
      (button) => button.textContent === "npm",
    ) as HTMLButtonElement;
    fireEvent.click(npm);
    expect(npm.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".home-install-code")?.textContent).toBe("npm install --global rom-weaver");
    expect(container.querySelector(".home-install-doc")?.getAttribute("href")).toBe("/tools/docs/install#npm");
  });

  it("prerenders the Apply action and drop zone that verify-seo-build.mjs checks", () => {
    const html = renderToString(
      <RomWeaverSettingsProvider settings={{ language: "en" }}>
        <HomePage baseUrl="https://rom-weaver.com/" />
      </RomWeaverSettingsProvider>,
    );
    expect(html).toContain('class="btn ghost slim home-route-go" href="/apply-patches"');
    expect(html).toContain('id="home-file-input"');
  });

  it("hands picked files to the shell's router", () => {
    const picked: File[][] = [];
    const { container } = render(
      <RomWeaverSettingsProvider settings={{ language: "en" }}>
        <HomePage baseUrl="https://example.com/" onFiles={(files) => picked.push(files)} />
      </RomWeaverSettingsProvider>,
    );
    const input = container.querySelector<HTMLInputElement>("#home-file-input");
    expect(input?.multiple).toBe(true);
    const files = [new File(["rom"], "game.sfc"), new File(["patch"], "hack.ips")];
    fireEvent.change(input as HTMLInputElement, { target: { files } });
    expect(picked.map((batch) => batch.map((file) => file.name))).toEqual([["game.sfc", "hack.ips"]]);
  });

  it("falls back to root-relative routes when the base URL is invalid", () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{ language: "en" }}>
        <HomePage baseUrl="not a URL" />
      </RomWeaverSettingsProvider>,
    );
    expect(container.querySelector(".home-route-go")?.getAttribute("href")).toBe("/apply-patches");
    expect(container.querySelector("a[href='/create-rom-patch']")).toBeTruthy();
  });

  it("updates homepage copy and workflow names when the language changes", () => {
    const { container, rerender } = render(
      <RomWeaverSettingsProvider settings={{ language: "de" }}>
        <HomePage baseUrl="https://example.com/tools/" />
      </RomWeaverSettingsProvider>,
    );
    expect(container.querySelector("#home-title")?.textContent).toContain("Patche ROMs in deinem Browser.");
    expect(container.querySelector(".home-route-go")?.textContent).toBe("Anwenden");
    expect(container.querySelector(".home-practice")?.textContent).toContain("Noch keine Dateien?");
    expect(container.textContent).toContain("Befehlszeile");

    rerender(
      <RomWeaverSettingsProvider settings={{ language: "es" }}>
        <HomePage baseUrl="https://example.com/tools/" />
      </RomWeaverSettingsProvider>,
    );
    expect(container.querySelector("#home-title")?.textContent).toContain("Aplica parches a ROMs en tu navegador.");
    expect(container.querySelector(".home-route-go")?.textContent).toBe("Aplicar");
    expect(container.querySelector(".home-practice")?.textContent).toContain("¿Aún no tienes archivos?");
    expect(container.textContent).toContain("Línea de comandos");
  });
});
