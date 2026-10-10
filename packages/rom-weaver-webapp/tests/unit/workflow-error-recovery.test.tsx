// @vitest-environment happy-dom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCodedErrorForDisplay } from "../../src/presentation/errors.ts";
import { createLocalizer } from "../../src/presentation/localization/index.ts";
import { loadCatalog } from "../../src/presentation/localization/catalog.ts";
import { SectionNotice } from "../../src/public/react/apply-section-notice.tsx";
import { buildCreateSourceStep } from "../../src/public/react/create-source-step-view-model.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";

afterEach(cleanup);

const showNotice = (message: string, locale = "en", onDismiss = vi.fn()) =>
  render(
    <RomWeaverSettingsProvider assetBaseUrl="https://example.test/tools/" settings={{ language: locale }}>
      <SectionNotice onDismiss={onDismiss} state={{ message, visible: true, level: "error", dismissible: true }} />
    </RomWeaverSettingsProvider>,
  );

describe("workflow error recovery", () => {
  it.each(["SELECTION_NOT_FOUND", "NO_SELECTABLE_CANDIDATE", "ARCHIVE_DEPTH_EXCEEDED"])(
    "keeps %s diagnostics and offers a non-destructive archive guide",
    (code) => {
      const message = `${code}: Selection candidate was not found: rom-7`;
      const dismiss = vi.fn();
      const view = showNotice(message, "en", dismiss);
      const alert = view.getByRole("alert");
      expect(alert.textContent).toContain(message);
      const link = within(alert).getByRole("link", { name: "Extract files guide (opens in a new tab)" });
      expect(link.getAttribute("href")).toBe("https://example.test/tools/docs/extract-files-browser");
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer");
      expect(dismiss).not.toHaveBeenCalled();
      expect(within(alert).getAllByRole("button")).toHaveLength(1);
      fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
      expect(dismiss).toHaveBeenCalledOnce();
    },
  );

  it.each(["WORKER_FAILED: Wasm OOM", "COMPRESSION_FAILED: Compression failed. Details: out of memory"])(
    "adds CLI recovery to explicit memory exhaustion: %s",
    (message) => {
      const view = showNotice(message);
      expect(view.getByRole("alert").textContent).toContain(message);
      expect(view.getByRole("alert").textContent).toContain("Close other memory-heavy tabs");
      expect(
        view.getByRole("link", { name: "Get started with the CLI (opens in a new tab)" }).getAttribute("href"),
      ).toBe("https://example.test/tools/docs/cli-get-started");
    },
  );

  it.each([
    ["en", "Extract files guide (opens in a new tab)"],
    ["de", "Anleitung zum Entpacken (öffnet in einem neuen Tab)"],
    ["es", "Guía para extraer archivos (se abre en una pestaña nueva)"],
  ])("recognizes the native nested-extraction diagnostic in %s", async (locale, linkName) => {
    await loadCatalog(locale);
    const diagnostic = "validation failed: nested extract exceeded max depth of 8 at `/work/OOM.zip`";
    const message = formatCodedErrorForDisplay(
      Object.assign(new Error(diagnostic), { code: "COMPRESSION_FAILED" }),
      createLocalizer(locale),
    );
    const view = showNotice(message, locale);
    expect(view.getByRole("alert").textContent).toContain(diagnostic);
    expect(view.getByRole("link", { name: linkName }).getAttribute("href")).toBe(
      "https://example.test/tools/docs/extract-files-browser",
    );
  });

  it.each([
    "WORKER_FAILED: Failed to fetch dynamically imported module",
    "COMPRESSION_FAILED: Archive is invalid",
    "CANCELLED: Workflow was cancelled",
    "CHECKSUM_MISMATCH: Checksum validation failed",
    "A file named OOM.zip failed",
    "A file named validation failed: nested extract exceeded max depth of 8",
    "validation failed: archive max depth of 8",
    "INVALID_INPUT: SELECTION_NOT_FOUND: nested detail",
    "INVALID_INPUT: nested extract exceeded max depth of 8",
    "COMPRESSION_FAILED: archive max depth of 8",
  ])("does not guess recovery for unrelated failure %s", (message) => {
    const view = showNotice(message);
    expect(view.queryByRole("link")).toBeNull();
    expect(view.getByRole("alert").textContent).toBe(message);
  });

  it("removes stale recovery when a notice changes or becomes hidden", () => {
    const state = { message: "SELECTION_NOT_FOUND: missing", visible: true, level: "error" as const };
    const view = render(<SectionNotice state={state} />);
    expect(view.getByRole("link")).toBeTruthy();
    view.rerender(<SectionNotice state={{ ...state, message: "CANCELLED: cancelled" }} />);
    expect(view.queryByRole("link")).toBeNull();
    view.rerender(<SectionNotice state={{ ...state, visible: false }} />);
    expect(view.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["en", "Extract files guide (opens in a new tab)", "Remove the affected input"],
    ["de", "Anleitung zum Entpacken (öffnet in einem neuen Tab)", "Entferne die betroffene Eingabe"],
    ["es", "Guía para extraer archivos (se abre en una pestaña nueva)", "Quita la entrada afectada"],
  ])("localizes recovery in %s while retaining diagnostics", async (locale, linkName, advice) => {
    await loadCatalog(locale);
    const message = formatCodedErrorForDisplay(
      Object.assign(new Error("Selection candidate was not found: rom-7"), { code: "SELECTION_NOT_FOUND" }),
      createLocalizer(locale),
    );
    expect(message).toMatch(/^SELECTION_NOT_FOUND: /);
    const view = showNotice(message, locale);
    expect(view.getByRole("alert").textContent).toContain(advice);
    expect(view.getByRole("alert").textContent).toContain(message);
    expect(view.getByRole("alert").textContent).toContain("rom-7");
    expect(view.getByRole("link", { name: linkName })).toBeTruthy();
  });

  it.each([
    ["en", "Extract files guide (opens in a new tab)"],
    ["de", "Anleitung zum Entpacken (öffnet in einem neuen Tab)"],
    ["es", "Guía para extraer archivos (se abre en una pestaña nueva)"],
  ])("renders native Create source warnings in %s", async (locale, linkName) => {
    await loadCatalog(locale);
    const diagnostic = "validation failed: nested extract exceeded max depth of 8 at `/work/OOM.zip`";
    for (const role of ["original", "modified"] as const) {
      const step = buildCreateSourceStep({
        num: "1",
        role,
        title: role,
        file: null,
        fileName: "OOM.zip",
        sourceState: {
          id: role,
          status: "ready",
          candidates: [],
          parentCompressions: [],
          warnings: [{ message: diagnostic }],
        },
        removeLabel: "Remove",
        onClear: vi.fn(),
        runtimeNotice: {
          message: "",
          messagePlacement: null,
          errorCode: "",
          messageDismissible: false,
          clearWorkflowMessage: vi.fn(),
        },
      });
      const view = render(
        <RomWeaverSettingsProvider assetBaseUrl="https://example.test/tools/" settings={{ language: locale }}>
          {step.notice}
        </RomWeaverSettingsProvider>,
      );
      expect(view.container.textContent).toContain(diagnostic);
      expect(view.getByRole("link", { name: linkName }).getAttribute("href")).toBe(
        "https://example.test/tools/docs/extract-files-browser",
      );
      view.unmount();
    }
  });

  it.each(["original", "modified"] as const)("renders recovery beside Create's %s input", (role) => {
    const step = buildCreateSourceStep({
      num: "1",
      role,
      title: role,
      file: null,
      fileName: "",
      sourceState: null,
      removeLabel: "Remove",
      onClear: vi.fn(),
      runtimeNotice: {
        message: "ARCHIVE_DEPTH_EXCEEDED: archive nesting limit",
        messagePlacement: role,
        errorCode: "ARCHIVE_DEPTH_EXCEEDED",
        messageDismissible: false,
        clearWorkflowMessage: vi.fn(),
      },
    });
    const view = render(<>{step.notice}</>);
    expect(view.getByRole("alert").textContent).toContain("Extract the outer archive on your device");
    expect(view.getByRole("link", { name: "Extract files guide (opens in a new tab)" }).getAttribute("href")).toBe(
      "/docs/extract-files-browser",
    );
  });
});
