/**
 * Axe scans components and inert full-page states in both themes and viewports.
 * Custom assertions cover surface contrast and keyboard behavior axe cannot express.
 */

import axeModule from "axe-core";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { CandidateSelectionDialog } from "../../src/public/react/candidate-selection.tsx";
import { ChecksumList, ChecksumRow } from "../../src/public/react/components/ds/checksum-list.tsx";
import { FileProgress, InlineProgress, Notice, RunButton } from "../../src/public/react/components/ds/feedback.tsx";
import { FileCard } from "../../src/public/react/components/ds/file-card.tsx";
import { ConfirmDialog, Modal } from "../../src/public/react/components/ds/modal.tsx";
import { DiscTracksPanel, SourceInfoList } from "../../src/public/react/components/ds/source-info-list.tsx";
import { CreatePatchFormView } from "../../src/public/react/create-patch-form-view.tsx";
import { CreatePatchForm, TrimPatchForm } from "../../src/public/react/index.tsx";
import { createEmptyPatcherUiState } from "../../src/public/react/patcher-ui-state.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { TrimPatchFormView } from "../../src/public/react/trim-form-view.tsx";
import { ACCENTS, applyAccent } from "../../src/webapp/accent.ts";
import { LogDialog } from "../../src/webapp/components/log-dialog.tsx";
import { WhatsNewPage } from "../../src/webapp/whats-new-page.tsx";
import { Masthead, UpdateBanner } from "../../src/webapp/components/shell.tsx";
import {
  getDefaultSettings,
  getSettingsUiState,
  validateSettingsDraft,
} from "../../src/webapp/settings/settings-state.ts";
import { SettingsPanel } from "../../src/webapp/webapp-settings.tsx";
// Load the real design system so axe + getComputedStyle see production colours.
// deferred.css ships lazily in production (webapp.ts loads it at boot) but the dialog
// and drawer surfaces under test here live in it, so the test loads it directly.
import "../../src/webapp/design-system/index.css";
import "../../src/webapp/design-system/deferred.css";

const axe = axeModule.default ?? axeModule;
const THEMES = ["light", "dark"];

// Cover phone, tablet, desktop, and short landscape layouts; restore the default viewport after each test.
const VIEWPORTS = [
  { height: 740, name: "360w smallest phone", width: 360 },
  { height: 860, name: "400w phone", width: 400 },
  { height: 900, name: "680w phablet gap", width: 680 },
  { height: 1024, name: "768w portrait tablet", width: 768 },
  { height: 1112, name: "834w tablet gap", width: 834 },
  { height: 768, name: "1024w small laptop", width: 1024 },
  { height: 900, name: "1280w desktop", width: 1280 },
  { height: 430, name: "740w landscape phone", width: 740 },
];
// vitest browser config default (vitest.browser.config.mjs); afterEach restores
// it so viewport-agnostic tests run at a stable width.
const DEFAULT_VIEWPORT = { height: 900, width: 1280 };
const setViewport = (viewport) => page.viewport(viewport.width, viewport.height);

let mountedRoot = null;
let host = null;
let noMotion = null;
let fetchSpy = null;

// Kill entrance/expand animation + transition timing so colours are sampled at
// their settled values, never a mid-fade frame (matching the live-app audit).
beforeAll(() => {
  noMotion = document.createElement("style");
  noMotion.textContent =
    "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;}";
  document.head.appendChild(noMotion);
});

beforeEach(() => {
  mountedRoot?.unmount?.();
  host = document.createElement("div");
  document.body.replaceChildren(host);
  mountedRoot = createRoot(host);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify([{ date: "2026-07-28T00:00:00Z", hash: "incoming", subject: "New release" }]), {
        headers: { "Content-Type": "application/json" },
      }),
  );
});

afterEach(async () => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  mountedRoot?.unmount?.();
  mountedRoot = null;
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-accent");
  document.documentElement.removeAttribute("data-beta-tools-enabled");
  await setViewport(DEFAULT_VIEWPORT);
});

// two RAFs so React's commit + layout settle before reading styles / running axe
const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
/** Wait for a React state update that a raw `.click()` scheduled. */
const settleUntil = async (ready) => {
  for (let attempt = 0; attempt < 50 && !ready(); attempt += 1) await settle();
};

/** A representative input card: name + meta, an OPEN checksum drawer, a CLOSED one. */
const Sample = () =>
  createElement(
    "div",
    { className: "rw-app", style: { background: "var(--chassis)", maxWidth: "560px", padding: "24px", width: "100%" } },
    createElement(
      FileCard,
      { meta: "8.00 MiB · GBA ROM", name: "Pokemon Emerald.gba" },
      createElement(
        ChecksumList,
        { defaultOpen: true, label: "Checksums", timing: "12 ms" },
        createElement(ChecksumRow, { copyValue: "1F1E33A0", label: "CRC32", value: "1F1E33A0" }),
        createElement(ChecksumRow, {
          copyValue: "0123abcd0123abcd0123abcd0123abcd",
          label: "MD5",
          value: "0123ABCD0123ABCD0123ABCD0123ABCD",
        }),
        createElement(ChecksumRow, {
          copyValue: "0123abcd0123abcd0123abcd0123abcd0123abcd",
          label: "SHA-1",
          value: "0123ABCD0123ABCD0123ABCD0123ABCD0123ABCD",
        }),
      ),
      createElement(
        ChecksumList,
        { defaultOpen: false, label: "Verification" },
        createElement(ChecksumRow, { copyValue: "1F1E33A0", label: "CRC32", value: "1F1E33A0" }),
      ),
    ),
  );

const renderSample = async (theme) => {
  document.documentElement.dataset.theme = theme;
  mountedRoot.render(createElement(Sample));
  await settle();
};

const parseColor = (value) => {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) throw new Error(`Cannot parse colour "${value}"`);
  const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
  return { a: parts[3] ?? 1, b: parts[2] ?? 0, g: parts[1] ?? 0, r: parts[0] ?? 0 };
};

const hexToRgbString = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
};

const relativeLuminance = ({ r, g, b }) => {
  const channel = (raw) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (a, b) => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

const bgString = (selector) => getComputedStyle(host.querySelector(selector)).backgroundColor;

// Returns readable violation strings (contrast diagnostic inlined) to assert
// against [] so failures show exactly what broke. `region` is only meaningful
// for a full page - an isolated mount or lone modal has no landmarks.
const scanViolations = async (context, { bestPractice = false, onlyRules = null, region = false } = {}) => {
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
  if (bestPractice) tags.push("best-practice");
  const results = await axe.run(context, {
    resultTypes: ["violations"],
    rules: region ? {} : { region: { enabled: false } },
    runOnly: onlyRules ? { type: "rule", values: onlyRules } : { type: "tag", values: tags },
  });
  return results.violations.map((v) => {
    const sample = v.nodes[0]?.any?.[0]?.data ?? v.nodes[0]?.all?.[0]?.data;
    const detail =
      sample && sample.contrastRatio !== undefined
        ? ` [ratio ${sample.contrastRatio} need ${sample.expectedContrastRatio}, fg ${sample.fgColor} on ${sample.bgColor}]`
        : "";
    return `${v.id} (${v.impact}): ${v.help}${detail} - ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`;
  });
};

describe("design-system accessibility", () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`checksum card passes WCAG 2.1 A/AA (${theme} theme, ${viewport.name})`, async () => {
        await setViewport(viewport);
        await renderSample(theme);
        expect(await scanViolations(host)).toEqual([]);
      });
    }
  }

  test("light: opened checksum drawer stays a distinct recessed well", async () => {
    await renderSample("light");

    // An open drawer needs a solid fill that stays distinct from its containing card.
    expect(bgString(".cks.is-open")).toBe(bgString(".cks:not(.is-open)"));

    const openBg = parseColor(bgString(".cks.is-open"));
    expect(openBg.a).toBe(1);

    // Require a measurable contrast margin between the drawer and the card.
    const ratio = contrastRatio(openBg, parseColor(bgString(".card")));
    expect(ratio).toBeGreaterThan(1.05);
  });

  for (const theme of THEMES) {
    test(`opened checksum drawer is separable from its card (${theme} theme)`, async () => {
      await renderSample(theme);
      // Compare raw computed strings - dark fills serialize as oklab(), which
      // need no parsing for a distinctness check. Either the fill differs from
      // the card, or a visible seam does the separation work.
      const open = getComputedStyle(host.querySelector(".cks.is-open"));
      const cardBg = getComputedStyle(host.querySelector(".card")).backgroundColor;
      const transparent = (color) => color === "rgba(0, 0, 0, 0)" || color === "transparent";
      const fillDiffers = open.backgroundColor !== cardBg;
      const borderVisible =
        !transparent(open.borderTopColor) &&
        open.borderTopColor !== cardBg &&
        Number.parseFloat(open.borderTopWidth) > 0;
      expect(fillDiffers || borderVisible).toBe(true);
    });
  }
});

const noop = () => undefined;

// Inert controller: a store with the live shape but no subscriptions/mutations.
const storeOf = (state) => ({ getState: () => state, subscribe: () => () => undefined });

const renderNode = async (node, theme) => {
  document.documentElement.dataset.theme = theme;
  mountedRoot.render(node);
  await settle();
};

const renderPage = async (node, theme) => {
  document.documentElement.lang = "en";
  await renderNode(node, theme);
};

// Every collapsible section rendered OPEN, plus the progress / error / fault
// primitives - a collapsed drawer is visibility:hidden and axe skips it.

const ROM_CHECKSUMS = {
  crc32: "C6FB1252",
  md5: "D7E7F3D6A4B2C9E1F8A0B1C2D3E4F5A6",
  sha1: "E7D6C5B4A3F2E1D0C9B8A7F6E5D4C3B2A1F0E9D8",
};

const SectionsGallery = () =>
  createElement(
    "div",
    { className: "rw-app", style: { background: "var(--chassis)", maxWidth: "640px", padding: "24px", width: "100%" } },
    createElement(
      Notice,
      { level: "error", onDismiss: noop },
      "Patch checksum mismatch: expected C6FB1252, got 00000000.",
    ),
    createElement(Notice, { level: "warn", onDismiss: noop }, "Header looks unusual - double-check the source ROM."),
    createElement(RunButton, {
      download: {
        format: "ZIP",
        name: "Pokemon Emerald (patched).gba",
        ratio: "62%",
        savedSize: "3.1 MiB",
        size: "5.0 MiB",
        total: "1.2 s",
      },
      onClick: noop,
    }),
    createElement(InlineProgress, {
      cancelLabel: "Cancel operation",
      label: "Compressing",
      onCancel: noop,
      percent: 42,
      value: "42%",
    }),
    createElement(FileProgress, {
      cancelLabel: "Cancel operation",
      indeterminate: true,
      label: "Extracting",
      onCancel: noop,
      value: "working",
    }),
    createElement(
      FileCard,
      { meta: "8.00 MiB · GBA ROM", name: "Pokemon Emerald.gba", state: "ok" },
      createElement(
        ChecksumList,
        { defaultOpen: true, label: "Checksums", timing: "12 ms" },
        createElement(ChecksumRow, { copyValue: ROM_CHECKSUMS.crc32, label: "CRC32", value: ROM_CHECKSUMS.crc32 }),
        createElement(ChecksumRow, { bad: true, copyValue: "00000000", label: "MD5", value: "MISMATCH" }),
        createElement(ChecksumRow, { copyValue: ROM_CHECKSUMS.sha1, label: "SHA-1", value: ROM_CHECKSUMS.sha1 }),
      ),
      createElement(SourceInfoList, {
        bytes: 8_388_608,
        checksums: ROM_CHECKSUMS,
        defaultOpen: true,
        label: "Source",
        timing: "8 ms",
        trim: { detected: true, mode: "auto", trimmedInputBytes: 1_048_576 },
      }),
      createElement(DiscTracksPanel, {
        open: true,
        tracks: [
          {
            bytes: 12_345_678,
            checksums: { crc32: "AAAA1111", md5: ROM_CHECKSUMS.md5, sha1: ROM_CHECKSUMS.sha1 },
            id: "t1",
            label: "Track 01",
            timing: "3 ms",
          },
          { bytes: 2_345_678, checksums: { crc32: "BBBB2222" }, id: "t2", label: "Track 02" },
        ],
      }),
    ),
  );

describe("design-system sections + states (expanded)", () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`every section open + progress/error primitives pass WCAG 2.1 A/AA (${theme} theme, ${viewport.name})`, async () => {
        await setViewport(viewport);
        await renderNode(createElement(SectionsGallery), theme);
        // sanity: the sections really are open (axe skips visibility:hidden content)
        expect(host.querySelectorAll(".cks.is-open").length).toBeGreaterThanOrEqual(3);
        expect(await scanViolations(host)).toEqual([]);
      });
    }
  }
});

// ── Full-page scans ──────────────────────────────────────────────────────────
// Mounts the production page shell - Masthead + <main> - around each
// workflow. Apply uses the inert ApplyWorkflowFormView (controllers-as-stores,
// no wasm) with a staged ROM card. Make Patch/Trim are stateful forms with no inert
// view, but render fine EMPTY (wasm only boots on a file action), so we scan
// their empty bench. All page scans add best-practice + landmark rules.

const outputState = () => ({
  applyButton: { disabled: true, label: "APPLY & DOWNLOAD", loading: false, progress: null, title: "" },
  applyTiming: "",
  compress: null,
  compressionFormat: "zip",
  compressTiming: "",
  disabled: true,
  displayFileName: "",
  downloadSummary: null,
  options: [{ label: ".zip", value: "zip" }],
  pendingDownloadFileName: null,
  resolvedOutputName: "",
  sizeSummary: {},
  totalTiming: "",
});

const emptyRomRowState = () => ({
  info: {
    archiveName: "",
    checksumsExpanded: true,
    checksumTiming: "",
    crc32: "",
    fileName: "",
    md5: "",
    romInfo: "",
    sha1: "",
    validationPhase: "idle",
  },
  loading: false,
  progress: null,
});

// A staged ROM row with checksums computed and the checksum drawer EXPANDED.
const stagedRomRow = (fileName) => {
  const base = emptyRomRowState();
  return {
    ...base,
    groupId: "",
    id: `rom:${fileName}`,
    info: {
      ...base.info,
      checksumsExpanded: true,
      crc32: "C6FB1252",
      fileName,
      md5: "D7E7F3D6A4B2C9E1F8A0B1C2D3E4F5A6",
      sha1: "E7D6C5B4A3F2E1D0C9B8A7F6E5D4C3B2A1F0E9D8",
    },
    kind: "rom",
    order: 0,
    size: 8_388_608,
  };
};

const stagedPatchItem = (fileName) => ({
  archiveFileName: "",
  fileName,
  fileSize: 1024,
  format: "IPS",
  index: 0,
  sourceChecksumState: "valid",
  validationActualValue: "",
  validationLabel: "Expected",
  validationMessage: "",
  validationState: "valid",
  validationValues: [],
});

const PAGE_TABS = [
  {
    dock: true,
    group: "patches",
    href: "apply",
    icon: createElement("span", { "aria-hidden": "true" }),
    id: "patcher",
    label: "Apply",
  },
  {
    dock: true,
    group: "patches",
    href: "create",
    icon: createElement("span", { "aria-hidden": "true" }),
    id: "creator",
    label: "Create",
  },
  {
    dock: true,
    group: "roms",
    href: "test",
    icon: createElement("span", { "aria-hidden": "true" }),
    id: "test",
    label: "Test",
  },
  {
    beta: true,
    group: "roms",
    href: "trim",
    icon: createElement("span", { "aria-hidden": "true" }),
    id: "trim",
    label: "Trim",
  },
];

// Production page chrome (single <main className="workbench"> + one named
// section) around an arbitrary workflow form node, mirroring webapp-root.tsx.
const Shell = (currentTab, panelView, formNode, mastheadProps = {}) =>
  createElement(
    RomWeaverSettingsProvider,
    { settings: {} },
    createElement(
      "div",
      { className: "rw-app", id: "column" },
      createElement(
        "div",
        { className: "app" },
        createElement(Masthead, {
          ...mastheadProps,
          currentTab,
          homeHref: "/apply-patch",
          onOpenWhatsNew: noop,
          onOpenLog: noop,
          onOpenSettings: noop,
          onOpenStatus: noop,
          onSelectTab: noop,
          tabs: PAGE_TABS,
          threads: 8,
          version: "0.1.0",
        }),
        createElement(
          "main",
          { className: "workbench", id: "main-content", tabIndex: -1 },
          createElement(
            "section",
            {
              "aria-labelledby": `tab-${panelView}`,
              className: "panel workflow",
              id: `panel-${panelView}`,
            },
            createElement("div", { className: "workflow-body" }, formNode),
          ),
        ),
      ),
    ),
  );

const applyControllers = (ui, patches, output) => ({
  output: storeOf(output ?? outputState()),
  patchStack: { ...storeOf({ items: patches }), removeItem: noop, reorder: noop },
  ui: storeOf(ui),
});

const applyPage = (ui, patches, { output, patchEnablement } = {}) =>
  Shell(
    "patcher",
    "patcher",
    createElement(ApplyWorkflowFormView, { controllers: applyControllers(ui, patches, output), patchEnablement }),
  );

const stagedUi = () => ({ ...createEmptyPatcherUiState(), romInputs: [stagedRomRow("Pokemon Emerald.gba")] });

const badPatchItem = (fileName) => ({
  ...stagedPatchItem(fileName),
  sourceChecksumState: "invalid",
  validationMessage: "Source ROM not found in this patch.",
  validationState: "invalid",
});

// Completed run: enabled download button + a from→to size summary.
const doneOutput = () => ({
  ...outputState(),
  applyButton: {
    disabled: false,
    label: "DOWNLOAD",
    loading: false,
    progress: null,
    title: "Pokemon Emerald (patched).gba",
  },
  applyTiming: "0.8 s",
  compressTiming: "0.4 s",
  disabled: false,
  displayFileName: "Pokemon Emerald (patched).gba",
  downloadSummary: { format: "ZIP", fromSize: "8.0 MiB", ratio: "62%", size: "5.0 MiB" },
  resolvedOutputName: "Pokemon Emerald (patched).gba",
  totalTiming: "1.2 s",
});

const emptyApplyPage = () => applyPage(createEmptyPatcherUiState(), []);
const doneApplyPage = () => applyPage(stagedUi(), [stagedPatchItem("rebalance.ips")], { output: doneOutput() });

// A single disc ROM row wired to surface EVERY drawer the apply card can render:
// checksums (open) with a headerless variant sub-group + a trim readout + a lead
// blurb, a cue-sheet drawer, and a Files drawer (it came from an archive).
const richRomRow = (fileName) => {
  const base = emptyRomRowState();
  return {
    ...base,
    archivePathEntries: [
      {
        decompressionTimeMs: 120,
        fileName: "games.7z",
        kind: "archive",
        outputSize: 700_000_000,
        sourceSize: 350_000_000,
      },
    ],
    cueText: 'FILE "Final Fantasy VII (Disc 1).bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00',
    decompressionTimeMs: 120,
    groupId: "",
    id: `rom:${fileName}`,
    info: {
      ...base.info,
      archiveName: "games.7z",
      checksumsExpanded: true,
      checksumTiming: "12 ms",
      checksumVariants: [
        {
          checksums: {
            crc32: "1234ABCD",
            md5: "D7E7F3D6A4B2C9E1F8A0B1C2D3E4F5A6",
            sha1: "E7D6C5B4A3F2E1D0C9B8A7F6E5D4C3B2A1F0E9D8",
          },
          id: "remove-header",
          label: "Headerless",
          transforms: { removeHeader: { strippedBytes: 512 } },
        },
      ],
      crc32: "C6FB1252",
      fileName,
      md5: "D7E7F3D6A4B2C9E1F8A0B1C2D3E4F5A6",
      romInfo: "Final Fantasy VII (USA) - PlayStation disc image.",
      romProbe: { trim: { detected: true, mode: "auto", trimmedInputBytes: 1_048_576 } },
      romType: { discFormat: "CD", platform: "psx" },
      sha1: "E7D6C5B4A3F2E1D0C9B8A7F6E5D4C3B2A1F0E9D8",
    },
    kind: "rom",
    order: 0,
    size: 700_000_000,
  };
};

// Three patches spanning every drawer/verdict the patch card can show: one from
// an archive with input+output requirements (Extract + Checks + Options), one
// with a strippable-header option, one that fails source verification. Each also
// carries the reorder/remove affordances (move-up/down, remove) so those touch
// targets ride along.
const densePatchItems = () => [
  {
    ...stagedPatchItem("intro-skip.ips"),
    archiveFileName: "patchpack.zip",
    archivePathEntries: [
      { decompressionTimeMs: 20, fileName: "patchpack.zip", kind: "archive", outputSize: 2048, sourceSize: 900 },
    ],
    canMoveDown: true,
    canMoveUp: false,
    canRemove: true,
    checksumTiming: "4 ms",
    format: "IPS",
    index: 0,
    key: "p0",
    validationValues: ["in crc32=C6FB1252", "out crc32=AABBCCDD"],
  },
  {
    ...stagedPatchItem("rebalance.bps"),
    canMoveDown: true,
    canMoveUp: true,
    canRemove: true,
    format: "BPS",
    headerStrippedBytes: 512,
    index: 1,
    key: "p1",
    showHeaderOption: true,
    validationValues: ["in crc32=C6FB1252"],
  },
  {
    ...badPatchItem("broken.ppf"),
    canMoveDown: false,
    canMoveUp: true,
    canRemove: true,
    format: "PPF",
    index: 2,
    key: "p2",
    validationValues: ["in crc32=DEADBEEF"],
  },
];

const denseRom = () => ({ ...createEmptyPatcherUiState(), romInputs: [richRomRow("Final Fantasy VII (Disc 1).bin")] });

// This fixture covers staged, enabled, disabled, and invalid patch cards on the same page.
const disabledPatchApplyPage = () =>
  applyPage(denseRom(), densePatchItems(), {
    patchEnablement: { disabledIds: new Set(["p1"]), getPatchIds: () => ["p0", "p1", "p2"], onToggle: noop },
  });

const emptyCreatePage = () =>
  Shell(
    "creator",
    "creator",
    createElement(CreatePatchForm, {
      onModifiedChange: noop,
      onOriginalChange: noop,
      onPatchTypeChange: noop,
      onSettingsChange: noop,
    }),
  );

const emptyTrimPage = () =>
  Shell(
    "trim",
    "trim",
    createElement(TrimPatchForm, { onOutputFormatChange: noop, onSettingsChange: noop, onSourceChange: noop }),
  );

// Make Patch/Trim are stateful forms with no inert controller, but their markup is
// owned by presentational views (CreatePatchFormView/TrimPatchFormView) that the controllers
// feed prop bundles. Mounting those views directly with a staged model exercises
// the loaded source cards (Extract + Info open, incl. the trim group) + swap row
// + output step without booting wasm - the coverage gap empty benches can't reach.
const stagedSourceStep = ({ id, num, title, trim }) => ({
  id,
  items: [
    {
      card: {
        extract: { fileName: "Pokemon Emerald.gba", fileSize: 8_388_608, timing: "8 ms" },
        onRemove: noop,
        panels: {
          info: { bytes: 8_388_608, checksums: ROM_CHECKSUMS, defaultOpen: true, timing: "Checksum 12 ms", trim },
        },
        removeLabel: `Clear ${title} ROM`,
        state: "ok",
      },
      id: `${id}:card`,
    },
  ],
  num,
  title,
});

const stagedOutputStep = ({ fileNameId, format, formatId, formatOptions, label, num, title }) => ({
  action: createElement(RunButton, { onClick: noop }, label),
  disabled: false,
  fileName: "Pokemon Emerald (patched)",
  fileNameId,
  fileNamePlaceholder: "Output filename",
  format,
  formatId,
  formatOptions,
  num,
  onFileNameChange: noop,
  onFormatChange: noop,
  title,
});

const stagedCreatePage = () =>
  Shell(
    "creator",
    "creator",
    createElement(CreatePatchFormView, {
      dropZone: { label: "Add or replace a ROM", onFiles: noop },
      modifiedStep: stagedSourceStep({ id: "patch-builder-row-modified", num: "0x03", title: "Modified" }),
      originalStep: stagedSourceStep({ id: "patch-builder-row-original", num: "0x02", title: "Original" }),
      output: stagedOutputStep({
        fileNameId: "patch-builder-output-file",
        format: "bps",
        formatId: "patch-builder-select-patch-type",
        formatOptions: [
          { label: "BPS", value: "bps" },
          { label: "UPS", value: "ups" },
        ],
        label: "CREATE & DOWNLOAD PATCH",
        num: "0x04",
        title: "Patch",
      }),
      sourcesEmpty: false,
      swap: { disabled: false, onSwap: noop },
    }),
  );

const stagedTrimPage = () =>
  Shell(
    "trim",
    "trim",
    createElement(TrimPatchFormView, {
      confirm: {
        body: "The trimmed copy is saved as a new download - your original file is not changed.",
        cancelLabel: "Cancel",
        confirmLabel: "Trim ROM",
        onCancel: noop,
        onConfirm: noop,
        open: false,
        title: "Trim this ROM?",
      },
      dropZone: { label: "Replace the ROM", onFiles: noop },
      output: stagedOutputStep({
        fileNameId: "trim-builder-output-file",
        format: "none",
        formatId: "trim-builder-select-output-format",
        formatOptions: [
          { label: ".gba", value: "none" },
          { label: ".zip", value: "zip" },
        ],
        label: "TRIM & DOWNLOAD",
        num: "0x03",
        title: "Trim",
      }),
      sourceEmpty: false,
      sourceStep: stagedSourceStep({
        id: "trim-builder-row-source",
        num: "0x02",
        title: "ROM",
        trim: { detected: true, mode: "auto", trimmedInputBytes: 1_048_576 },
      }),
    }),
  );

// ── Dense apply page: multiple patches + every drawer open ───────────────────
// Axe skips visibility:hidden content, so open every nested drawer before
// scanning the dense fixture.
const openAllDrawers = async (root) => {
  // nested drawers reveal more toggles once a parent opens, so loop until dry
  for (let pass = 0; pass < 8; pass += 1) {
    const closed = root.querySelectorAll('button.cks-head[aria-expanded="false"]');
    if (closed.length === 0) return;
    for (const toggle of closed) toggle.click();
    await settle();
  }
};

// ── Banners ──────────────────────────────────────────────────────────────────
const Banners = () =>
  createElement(
    RomWeaverSettingsProvider,
    { settings: {} },
    createElement("div", { className: "rw-app" }, createElement(UpdateBanner, { onOpenWhatsNew: noop, open: true })),
  );

// ── Modals / dialogs ─────────────────────────────────────────────────────────
// Modals portal into the first `.rw-app` (modal.tsx getModalPortalTarget), so a
// wrapping .rw-app host keeps them inside `host` for the scan. region stays off
// (a lone dialog has no page landmarks); best-practice is on for dialog-name.
const settingsDraft = getDefaultSettings();
const candidateRequest = (multiSelect) => ({
  candidates: [
    {
      breadcrumbs: ["games.zip"],
      fileName: "Pokemon Emerald.gba",
      id: "c0",
      selectable: true,
      size: 8_388_608,
      type: "file",
    },
    {
      breadcrumbs: ["games.zip"],
      fileName: "Pokemon Ruby.gba",
      id: "c1",
      selectable: true,
      size: 8_388_608,
      type: "file",
    },
  ],
  multiSelect,
  role: "rom",
  sourceName: "games.zip",
  warnings: [],
});
const candidateDialog = (multiSelect) =>
  createElement(CandidateSelectionDialog, {
    onCancel: noop,
    onSelect: noop,
    onSelectMany: noop,
    state: { reject: noop, request: candidateRequest(multiSelect), resolve: noop },
  });
const DIALOGS = {
  candidate: () => candidateDialog(false),
  "candidate (multi-select)": () => candidateDialog(true),
  confirm: () =>
    createElement(ConfirmDialog, {
      body: "Reloading will clear staged files and finished output.",
      cancelLabel: "Stay here",
      confirmLabel: "Reload now",
      onCancel: noop,
      onConfirm: noop,
      open: true,
      title: "Reload and lose changes?",
    }),
  // The changelog route uses the same full-page accessibility checks.
  "whats new": () => createElement(WhatsNewPage, { active: true, onReload: noop, updateReady: true }),
  log: () => createElement(LogDialog, { onClose: noop, onLevelChange: noop, open: true }),
  // Check Settings within the shared dialog.
  settings: () =>
    createElement(LogDialog, {
      initialTab: "settings",
      onClose: noop,
      onLevelChange: noop,
      onRestoreDefaults: noop,
      onSaveSettings: noop,
      open: true,
      settingsPanel: createElement(SettingsPanel, {
        draftSettings: settingsDraft,
        onDraftChange: noop,
        uiState: getSettingsUiState(settingsDraft),
        validation: validateSettingsDraft(settingsDraft),
      }),
    }),
};

const ModalHost = (node) =>
  createElement(RomWeaverSettingsProvider, { settings: {} }, createElement("div", { className: "rw-app" }, node));

// Reuse one React root and viewport for all production surfaces at a given
// theme/width. This keeps every matrix point while avoiding a fresh browser-test
// setup for each page. The dense apply fixture replaces three overlapping apply
// states without losing their enabled, disabled, invalid, or staged controls.
const WEBAPP_SURFACES = [
  { factory: emptyApplyPage, name: "empty apply", page: true },
  { factory: doneApplyPage, name: "apply completed/download", page: true },
  { factory: emptyCreatePage, name: "empty create", page: true },
  { factory: stagedCreatePage, name: "staged create", page: true },
  { factory: emptyTrimPage, name: "empty trim", page: true },
  { factory: stagedTrimPage, name: "staged trim", page: true },
  {
    dense: true,
    factory: disabledPatchApplyPage,
    name: "dense apply with enabled, disabled, and invalid patches",
    page: true,
  },
  { factory: () => createElement(Banners), name: "update banner" },
  ...Object.entries(DIALOGS).map(([name, factory]) => ({
    factory: () => ModalHost(factory()),
    name: `${name} dialog`,
  })),
];

describe("webapp surface accessibility", () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`pages and dialogs pass WCAG 2.1 A/AA + best-practice (${theme} theme, ${viewport.name})`, async () => {
        await setViewport(viewport);
        const violations = [];

        for (const { dense, factory, name, page: isPage } of WEBAPP_SURFACES) {
          if (isPage) await renderPage(factory(), theme);
          else await renderNode(factory(), theme);

          if (dense) {
            await openAllDrawers(host);
            // Sanity: nothing remains hidden and the fixture still contains
            // drawers spanning the ROM and all three patch cards.
            expect(host.querySelectorAll('button.cks-head[aria-expanded="false"]').length, name).toBe(0);
            expect(host.querySelectorAll(".cks.is-open").length, name).toBeGreaterThanOrEqual(5);
          }

          const surfaceViolations = await scanViolations(host, { bestPractice: true, region: isPage });
          violations.push(...surfaceViolations.map((violation) => `${name}: ${violation}`));
        }

        expect(violations).toEqual([]);
      });
    }
  }
});

// ── Keyboard navigation ──────────────────────────────────────────────────────
// axe can't verify focus movement, so this drives the real chrome by keyboard
// and asserts the skip link, the nav's tab order, and the Menu sheet's own
// Escape contract. (Theme-independent.)
describe("webapp keyboard navigation", () => {
  const renderMasthead = async (onSelectTab) => {
    document.documentElement.dataset.betaToolsEnabled = "true";
    await renderNode(
      createElement(
        RomWeaverSettingsProvider,
        { settings: { betaToolsEnabled: true } },
        createElement(
          "div",
          { className: "rw-app" },
          createElement(Masthead, {
            currentTab: "patcher",
            homeHref: "/apply-patch",
            onOpenWhatsNew: noop,
            onOpenLog: noop,
            onOpenSettings: noop,
            onOpenStatus: noop,
            onSelectTab,
            tabs: PAGE_TABS,
          }),
          createElement("main", { id: "main-content" }),
        ),
      ),
      "light",
    );
  };

  test("skip link targets the main workflow", async () => {
    await renderMasthead(noop);
    const skipLink = host.querySelector(".skip-link");
    expect(skipLink?.getAttribute("href")).toBe("#main-content");
    expect(host.querySelector(".skip-link + .shell-banner")).toBeTruthy();
    skipLink.focus();
    expect(document.activeElement).toBe(skipLink);
  });

  test("the nav is a plain list of links, so Tab reaches every destination", async () => {
    const selected = [];
    await renderMasthead((id) => selected.push(id));
    const rows = [...host.querySelectorAll(".side-nav .nav-row")];

    // No roving tabindex to trap the keyboard: this is a nav, not a tablist,
    // so every row is reachable with Tab and none is removed from the order.
    expect(rows.length).toBeGreaterThan(4);
    expect(rows.some((row) => row.getAttribute("tabindex") === "-1")).toBe(false);
    expect(host.querySelector('.side-nav [role="tab"]')).toBeNull();

    const current = host.querySelector('.side-nav [aria-current="page"]');
    expect(current.dataset.mode ?? current.getAttribute("href")).toBe("apply");
    host.querySelector("#tab-creator").click();
    expect(selected).toEqual(["creator"]);
  });

  test("Escape from Find returns focus to the trigger the layout shows", async () => {
    // `.topbar-find` is display:none below the threshold, and focusing a hidden
    // button silently drops focus to the body.
    await setViewport(VIEWPORTS[0]);
    await renderMasthead(noop);
    if (host.querySelector(".menu-sheet").hidden) host.querySelector(".dock-menu").click();
    await settleUntil(() => !host.querySelector(".menu-sheet").hidden);
    host.querySelector(".menu-find").click();
    await settleUntil(() => !!host.querySelector(".find-input"));

    host
      .querySelector(".find-input")
      .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    await settleUntil(() => !host.querySelector(".find-input"));

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement.closest(".menu-find, .dock-menu")).toBeTruthy();
  });

  test("the Menu sheet makes what it covers inert, so the keyboard agrees with the scrim", async () => {
    await setViewport(VIEWPORTS[0]);
    await renderMasthead(noop);
    const banner = host.querySelector(".shell-banner");
    const covered = host.querySelector('.shell-head-tools .tool[aria-label="Docs"]');
    expect(banner.hasAttribute("inert")).toBe(false);

    if (host.querySelector(".menu-sheet").hidden) host.querySelector(".dock-menu").click();
    await settleUntil(() => !host.querySelector(".menu-sheet").hidden);

    // The scrim blocks the pointer here, so the keyboard must not get through.
    expect(banner.hasAttribute("inert")).toBe(true);
    covered.focus();
    expect(document.activeElement).not.toBe(covered);
    // The dock stays reachable: Menu is what closes the sheet again.
    const menu = host.querySelector(".dock-menu");
    expect(host.querySelector(".dock").hasAttribute("inert")).toBe(false);
    menu.focus();
    expect(document.activeElement).toBe(menu);

    menu.click();
    await settleUntil(() => host.querySelector(".menu-sheet").hidden);
    expect(banner.hasAttribute("inert")).toBe(false);
    covered.focus();
    expect(document.activeElement).toBe(covered);
  });

  test("Menu closes on Escape and hands focus back to its trigger", async () => {
    // The dock only exists below the layout threshold, and focus cannot return
    // to a control the current layout does not show.
    await setViewport(VIEWPORTS[0]);
    await renderMasthead(noop);
    const trigger = host.querySelector(".dock-menu");
    const sheet = host.querySelector(".menu-sheet");

    trigger.click();
    await settleUntil(() => !sheet.hidden);
    expect(sheet.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    await settleUntil(() => sheet.hidden);

    expect(sheet.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  test("modal wraps Tab focus, restores the opener, and isolates the page", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open settings";
    document.body.append(opener);
    opener.focus();

    await renderNode(
      ModalHost(
        createElement(
          "div",
          null,
          createElement("button", { id: "background-action", type: "button" }, "Background action"),
          createElement(
            Modal,
            { onClose: noop, open: true, title: "Settings" },
            createElement("button", { type: "button" }, "First action"),
            createElement("button", { type: "button" }, "Last action"),
          ),
        ),
      ),
      "light",
    );
    await settle();

    const dialog = document.body.querySelector('[role="dialog"]');
    const first = dialog?.querySelector("button.dlg-x");
    const last = Array.from(document.body.querySelectorAll(".rw-modal button")).at(-1);
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(host.querySelector("#background-action")?.closest("[inert]")).toBeTruthy();

    last.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" }));
    expect(document.activeElement).toBe(first);
    first.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab", shiftKey: true }),
    );
    expect(document.activeElement).toBe(last);

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(dialog);

    mountedRoot.unmount();
    expect(document.activeElement).toBe(opener);
    outside.remove();
    opener.remove();
  });
});

// Every accent needs readable text and controls on each tested surface in both themes.
// Phone and desktop widths cover the two sets of accent-bearing navigation styles.
const ACCENT_VIEWPORTS = [
  VIEWPORTS[0], // 360w smallest phone -> phone-dock.css thread rules
  VIEWPORTS[6], // 1280w desktop
];

// The identity block is the only place the channel badge renders, and it is the
// one surface where a thread-tinted fill sits behind thread-tinted text.
// Mounted as a full page so the nav rows resolve against the panels they name,
// exactly as they do in production.
const badgedMastheadPage = () =>
  Shell(
    "patcher",
    "patcher",
    createElement(ApplyWorkflowFormView, { controllers: applyControllers(createEmptyPatcherUiState(), []) }),
    { channelBadge: "nightly" },
  );

// Curated to cover every design-system file that reads a thread token:
// dropzone/hero, file-cards + drawers + fields + workbench, result + weave-meter,
// dialogs, banners, and the shell chrome (incl. the badge).
const ACCENT_SURFACES = [
  { factory: emptyApplyPage, name: "empty apply (hero + dropzone)", page: true },
  { dense: true, factory: disabledPatchApplyPage, name: "dense apply (cards, drawers, verdicts)", page: true },
  { factory: doneApplyPage, name: "apply completed (result + meter)", page: true },
  { factory: () => ModalHost(DIALOGS.settings()), name: "settings dialog" },
  { factory: () => ModalHost(DIALOGS.log()), name: "log dialog" },
  { factory: () => createElement(Banners), name: "banners" },
  { badge: true, factory: badgedMastheadPage, name: "shell chrome + channel badge", page: true },
];

describe("accent dye-lot accessibility", () => {
  for (const accent of ACCENTS) {
    for (const theme of THEMES) {
      for (const viewport of ACCENT_VIEWPORTS) {
        test(`accent surfaces pass WCAG 2.1 contrast (${accent.value}, ${theme} theme, ${viewport.name})`, async () => {
          await setViewport(viewport);
          // The production application path, so a bug in applyAccent fails here too.
          applyAccent(accent.value);
          const expected = accent.value === "madder" ? null : accent.value;
          expect(document.documentElement.getAttribute("data-accent")).toBe(expected);
          const violations = [];

          for (const { badge, dense, factory, name, page: isPage } of ACCENT_SURFACES) {
            // Madder is the base palette already scanned above. Its badge is the
            // only unique surface; the other accents re-dye every surface.
            if (accent.value === "madder" && !badge) continue;

            const node = factory();
            if (isPage) await renderPage(node, theme);
            else await renderNode(node, theme);
            if (dense) await openAllDrawers(host);

            if (badge) {
              expect(host.querySelector(".channel-badge")?.getAttribute("data-channel")).toBe("nightly");
              const accentTab = host.querySelector(".brand-mark-accent");
              expect(accentTab).toBeTruthy();
              expect(getComputedStyle(accentTab).fill).toBe(hexToRgbString(accent.swatch));
            }

            const surfaceViolations = await scanViolations(host, { onlyRules: ["color-contrast"], region: isPage });
            violations.push(...surfaceViolations.map((violation) => `${name}: ${violation}`));
          }

          expect(violations).toEqual([]);
        });
      }
    }
  }
});

describe("webapp responsive navigation", () => {
  // One threshold and nothing else: sidebar + top bar at 1000px and up, page
  // header + bottom dock + Menu sheet below it. No measurement, no layout flag.
  const ALL_TABS = [
    ...PAGE_TABS,
    {
      group: "project",
      href: "docs",
      icon: createElement("span", { "aria-hidden": "true" }),
      id: "docs",
      label: "Docs",
    },
    {
      beta: true,
      group: "patches",
      href: "ppf-undo",
      icon: createElement("span", { "aria-hidden": "true" }),
      id: "ppf-undo",
      label: "PPF undo",
    },
  ];

  const renderMastheadOnly = async (tabs) =>
    renderNode(
      createElement(
        RomWeaverSettingsProvider,
        { settings: {} },
        createElement(
          "div",
          { className: "rw-app" },
          createElement(
            "div",
            { className: "app" },
            createElement(Masthead, {
              currentTab: "patcher",
              donateHref: "https://example.com/donate",
              githubHref: "https://example.com/repo",
              homeHref: "/apply-patch",
              onOpenWhatsNew: noop,
              onOpenLog: noop,
              onOpenSettings: noop,
              onOpenStatus: noop,
              onSelectTab: noop,
              tabs,
              threads: 8,
              version: "0.1.0",
            }),
          ),
        ),
      ),
      "light",
    );

  test("Find keeps keyboard selections visible on desktop and phone", async () => {
    for (const width of [1280, 390]) {
      await setViewport({ height: 430, width });
      await renderMastheadOnly(ALL_TABS);
      if (width > 999) host.querySelector(".topbar-find").click();
      else {
        host.querySelector(".dock-menu").click();
        await settle();
        host.querySelector(".menu-find").click();
      }
      await settle();
      const input = host.querySelector(".find-input");
      const options = host.querySelectorAll(".find-option");
      for (let index = 1; index < options.length; index += 1) {
        input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
        await settle();
        const selected = host.querySelector(".find-option.is-active").getBoundingClientRect();
        const list = host.querySelector(".find-results").getBoundingClientRect();
        expect(selected.top).toBeGreaterThanOrEqual(list.top - 1);
        expect(selected.bottom).toBeLessThanOrEqual(list.bottom + 1);
      }
    }
  });

  test("the sidebar is a column beside the content, with the top bar above it", async () => {
    for (const width of [1000, 1100, 1280, 1600]) {
      await setViewport({ height: 900, width });
      for (const tabs of [PAGE_TABS, ALL_TABS]) {
        await renderMastheadOnly(tabs);

        const head = host.querySelector(".shell-head").getBoundingClientRect();
        const nav = host.querySelector(".side-nav").getBoundingClientRect();
        const topbar = host.querySelector(".topbar").getBoundingClientRect();

        // The identity block heads the column and the nav runs below it.
        expect(head.bottom).toBeLessThanOrEqual(nav.top + 1);
        // The top bar sits beside the column, never over it.
        expect(nav.right).toBeLessThanOrEqual(topbar.left + 1);
        // The dock never shares the screen with the sidebar.
        expect(getComputedStyle(host.querySelector(".dock")).display).toBe("none");
        expect(getComputedStyle(host.querySelector(".menu-sheet")).display).toBe("none");
      }
    }
  });

  test("every nav row keeps its full label at every sidebar width", async () => {
    for (const width of [1000, 1100, 1200, 1280, 1600]) {
      await setViewport({ height: 900, width });
      await renderMastheadOnly(ALL_TABS);
      for (const label of host.querySelectorAll(".side-nav .nav-row-label")) {
        // painted in full: never clipped to a glyph, never ellipsized. A locale
        // with longer words wraps the row instead of truncating the name.
        expect(label.getBoundingClientRect().width).toBeGreaterThan(20);
        expect(label.scrollWidth).toBeLessThanOrEqual(label.getBoundingClientRect().width + 1);
        expect(getComputedStyle(label).textOverflow).not.toBe("ellipsis");
        expect(getComputedStyle(label).maxWidth).toBe("none");
      }
    }
  });

  test("no destination is listed twice in one layout", async () => {
    await setViewport({ height: 900, width: 1280 });
    await renderMastheadOnly(ALL_TABS);
    const hrefs = [...host.querySelectorAll(".side-nav .nav-row[href]")].map((row) => row.getAttribute("href"));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    // The top bar carries controls and outbound links, never an app destination.
    expect(host.querySelector(".topbar .nav-row")).toBeNull();
  });

  test("below the threshold the primary nav is the dock, and Menu holds the rest", async () => {
    for (const viewport of [VIEWPORTS[0], { height: 900, width: 999 }]) {
      await setViewport(viewport);
      await renderMastheadOnly(ALL_TABS);

      expect(getComputedStyle(host.querySelector(".side-rail")).display).toBe("none");
      expect(getComputedStyle(host.querySelector(".topbar")).display).toBe("none");
      const dock = host.querySelector(".dock");
      expect(getComputedStyle(dock).display).toBe("grid");
      expect(getComputedStyle(dock).position).toBe("fixed");
      // Three workflows plus Menu, each with a word under its glyph.
      const slots = [...dock.querySelectorAll(".dock-tab")];
      expect(slots.length).toBe(4);
      for (const slot of slots) {
        const label = slot.lastElementChild;
        expect(label.textContent.trim().length).toBeGreaterThan(0);
        expect(label.scrollWidth).toBeLessThanOrEqual(label.getBoundingClientRect().width + 1);
      }

      // Menu toggles, and re-rendering the same tree keeps its open state.
      if (host.querySelector(".menu-sheet").hidden) host.querySelector(".dock-menu").click();
      await settleUntil(() => !host.querySelector(".menu-sheet").hidden);
      const sheet = host.querySelector(".menu-sheet").getBoundingClientRect();
      expect(sheet.height).toBeGreaterThan(0);
      expect(Math.abs(sheet.bottom - dock.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
      expect(sheet.top).toBeGreaterThanOrEqual(0);
      expect(host.querySelector(".menu-sheet .nav-group").getBoundingClientRect().top - sheet.top).toBeLessThan(24);
      expect(host.querySelector(".menu-sheet .sub-status")).toBeNull();
      expect(host.querySelector(".phone-runtime .sub-status")?.getAttribute("aria-label")).toBe(
        host.querySelector(".desktop-runtime .sub-status")?.getAttribute("aria-label"),
      );

      // The brand and tools share one row without overlap.
      const brand = host.querySelector(".brand").getBoundingClientRect();
      const tools = host.querySelector(".shell-head-tools").getBoundingClientRect();
      expect(brand.right).toBeLessThanOrEqual(tools.left + 1);
      expect(host.querySelector(".brand-copy .build-facts")).toBeTruthy();

      host.querySelector(".dock-menu").click();
      await settleUntil(() => host.querySelector(".menu-sheet").hidden);
    }
  });

  test("the dock keeps Status and Menu lists the other sidebar rows", async () => {
    await setViewport(VIEWPORTS[0]);
    await renderMastheadOnly(ALL_TABS);
    const labels = (scope) => [...host.querySelectorAll(`${scope} .nav-row-label`)].map((label) => label.textContent);

    // Menu toggles, and re-rendering the same tree keeps its open state.
    if (host.querySelector(".menu-sheet").hidden) host.querySelector(".dock-menu").click();
    await settleUntil(() => !host.querySelector(".menu-sheet").hidden);

    const sortLabels = (items) => items.sort((left, right) => left.localeCompare(right));
    expect(sortLabels(labels(".menu-sheet"))).toEqual(sortLabels(labels(".side-nav")));
    expect(host.querySelector(".phone-runtime .sub-status")?.getAttribute("aria-label")).toBe(
      host.querySelector(".desktop-runtime .sub-status")?.getAttribute("aria-label"),
    );
  });

  test("the wordmark is never truncated by the brand's min-content floor", async () => {
    for (const width of [320, 360, 500, 999, 1000, 1280]) {
      await setViewport({ height: 900, width });
      await renderMastheadOnly(ALL_TABS);
      const word = host.querySelector(".brand-word");
      expect(word.scrollWidth).toBeLessThanOrEqual(word.getBoundingClientRect().width + 1);
    }
  });

  test("phone hero gives back the in-flow navigation height", async () => {
    await setViewport(VIEWPORTS[0]);
    await renderPage(emptyApplyPage(), "light");

    // 485px of navigation chrome, less the 116px the joined checksum footer
    // takes (--hero-search-h), so the page footer still clears the dock.
    expect(getComputedStyle(host.querySelector(".drop.hero")).minHeight).toBe("369px");
  });

  test("keeps the workflow gutter fluid without a narrow desktop cap", async () => {
    let previousGutter = 0;
    for (const width of [904, 1024, 1096, 1175]) {
      await setViewport({ height: 900, width });
      await renderPage(emptyApplyPage(), "dark");

      const app = host.querySelector(".app");
      const hero = host.querySelector(".drop.hero");
      const appRect = app.getBoundingClientRect();
      const heroRect = hero.getBoundingClientRect();
      // Measured from the content column, which the sidebar column precedes on
      // desktop; the app box itself starts at the rail.
      const column = host.querySelector(".workbench").getBoundingClientRect();
      const gutter = heroRect.left - column.left;

      // The scrollbar may consume a narrow strip, but the app should not fall
      // back to the old 880px cap while the 1220px wide layout still fits.
      expect(appRect.width).toBeGreaterThanOrEqual(width - 16);
      expect(gutter).toBeGreaterThanOrEqual(previousGutter);
      expect(gutter).toBeLessThanOrEqual(28);
      previousGutter = gutter;
    }
  });
});
