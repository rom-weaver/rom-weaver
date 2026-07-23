/**
 * Axe scans components and inert full-page states in both themes and viewports.
 * Custom assertions cover surface contrast and keyboard behavior axe cannot express.
 */

import axeModule from "axe-core";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
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
import { ArchiveDialog } from "../../src/public/react/patcher-react-shared.tsx";
import { createEmptyPatcherUiState, createInitialDialogState } from "../../src/public/react/patcher-ui-state.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { TrimPatchFormView } from "../../src/public/react/trim-form-view.tsx";
import { ACCENTS, applyAccent } from "../../src/webapp/accent.ts";
import { LogDialog } from "../../src/webapp/components/log-dialog.tsx";
import { Masthead, UpdateBanner, WakeLockBanner } from "../../src/webapp/components/shell.tsx";
import {
  getDefaultSettings,
  getSettingsUiState,
  validateSettingsDraft,
} from "../../src/webapp/settings/settings-state.ts";
import { SettingsPanel } from "../../src/webapp/webapp-settings.tsx";
// Load the real design system so axe + getComputedStyle see production colours.
import "../../src/webapp/design-system/index.css";

const axe = axeModule.default ?? axeModule;
const THEMES = ["light", "dark"];

// One viewport inside each layout regime (seams in design-system/responsive.css:
// 720/860/1100px; the rest rides fluid tokens or container queries), plus a
// short-height case for `(max-width: 860px) and (max-height: 520px)`.
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
});

afterEach(async () => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-accent");
  await setViewport(DEFAULT_VIEWPORT);
});

// two RAFs so React's commit + layout settle before reading styles / running axe
const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

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
const scanViolations = async (context, { bestPractice = false, region = false } = {}) => {
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
  if (bestPractice) tags.push("best-practice");
  const results = await axe.run(context, {
    resultTypes: ["violations"],
    rules: region ? {} : { region: { enabled: false } },
    runOnly: { type: "tag", values: tags },
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

    // The opened drawer must keep the solid well fill it has when collapsed -
    // the bug was the open state diluting to a near-transparent tint that read
    // as the card behind it.
    expect(bgString(".cks.is-open")).toBe(bgString(".cks:not(.is-open)"));

    const openBg = parseColor(bgString(".cks.is-open"));
    expect(openBg.a).toBe(1);

    // …and perceptibly separated from the card: the washed-out tint measured
    // ~1.01:1 (≈invisible); the solid well clears a small but real margin.
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
  applyButton: { disabled: true, label: "WEAVE & DOWNLOAD", loading: false, progress: null, title: "" },
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

// A staged ROM row with checksums computed and the checksum drawer EXPANDED.
const stagedRomRow = (fileName) => {
  const base = createEmptyPatcherUiState();
  return {
    ...base.romInput,
    groupId: "",
    id: `rom:${fileName}`,
    info: {
      ...base.romInfo,
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
  { href: "weave", icon: createElement("span", { "aria-hidden": "true" }), id: "patcher", label: "Weave" },
  { href: "create", icon: createElement("span", { "aria-hidden": "true" }), id: "creator", label: "Create" },
  { href: "trim", icon: createElement("span", { "aria-hidden": "true" }), id: "trim", label: "Trim" },
];

// Production page chrome (single <main className="workbench"> + one tabpanel)
// around an arbitrary workflow form node, mirroring webapp-root.tsx.
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
          donateHref: "https://example.invalid/donate",
          githubHref: "https://example.invalid/repo",
          onOpenLog: noop,
          onOpenSettings: noop,
          onReset: noop,
          onSelectTab: noop,
          tabs: PAGE_TABS,
          threads: 8,
          version: "0.1.0",
        }),
        createElement(
          "main",
          { className: "workbench" },
          createElement(
            "section",
            {
              "aria-labelledby": `tab-${panelView}`,
              className: "panel workflow",
              id: `panel-${panelView}`,
              role: "tabpanel",
            },
            createElement("div", { className: "workflow-body" }, formNode),
          ),
        ),
      ),
    ),
  );

const applyControllers = (ui, patches, output) => ({
  dialog: storeOf({ ...createInitialDialogState() }),
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

const stagedApplyPage = () => applyPage(stagedUi(), [stagedPatchItem("rebalance.ips")]);
const emptyApplyPage = () => applyPage(createEmptyPatcherUiState(), []);
const verdictApplyPage = () =>
  applyPage(stagedUi(), [badPatchItem("broken.ips"), stagedPatchItem("ok.ips")], {
    patchEnablement: { disabledIds: new Set(["p1"]), getPatchIds: () => ["p0", "p1"], onToggle: noop },
  });
const doneApplyPage = () => applyPage(stagedUi(), [stagedPatchItem("rebalance.ips")], { output: doneOutput() });

// A single disc ROM row wired to surface EVERY drawer the apply card can render:
// checksums (open) with a headerless variant sub-group + a trim readout + a lead
// blurb, a cue-sheet drawer, and a Files drawer (it came from an archive).
const richRomRow = (fileName) => {
  const base = createEmptyPatcherUiState();
  return {
    ...base.romInput,
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
      ...base.romInfo,
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
    wasDecompressed: true,
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

const densePatchApplyPage = () => applyPage(denseRom(), densePatchItems());

// Same dense page, but with the per-patch On/Off enable toggles present and the
// middle patch toggled OFF. A disabled patch dims to `.card.is-disabled` (dashed
// plate, --ink-3 text), drops its verdict + Checks drawer, and keeps only an
// (editable) Options drawer - a distinct set of surfaces/targets: the switch
// input itself, the dimmed name/meta, and the Options fields on the disabled
// card background. openAllDrawers still expands every remaining drawer.
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

describe("webapp page accessibility", () => {
  const PAGES = [
    { factory: stagedApplyPage, name: "staged apply" },
    { factory: emptyApplyPage, name: "empty apply" },
    { factory: verdictApplyPage, name: "apply (bad + disabled patch verdicts)" },
    { factory: doneApplyPage, name: "apply (completed/download)" },
    { factory: emptyCreatePage, name: "empty create" },
    { factory: stagedCreatePage, name: "staged create" },
    { factory: emptyTrimPage, name: "empty trim" },
    { factory: stagedTrimPage, name: "staged trim" },
  ];
  for (const { factory, name } of PAGES) {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        test(`${name} page passes WCAG 2.1 A/AA + best-practice (${theme} theme, ${viewport.name})`, async () => {
          await setViewport(viewport);
          await renderPage(factory(), theme);
          expect(await scanViolations(host, { bestPractice: true, region: true })).toEqual([]);
        });
      }
    }
  }
});

// ── Dense apply page: multiple patches + every drawer open ───────────────────
// The staged/verdict apply scans leave the patch Options drawers (name,
// description, input/output verification fields, header-strip checkbox) and the
// ROM's cue/variant/extract drawers CLOSED - axe skips visibility:hidden
// content, so those dense, control-heavy states were never audited. This mounts
// the worst case (a disc ROM with every panel + three patches spanning every
// verdict) and clicks every collapsed drawer OPEN before scanning.
const openAllDrawers = async (root) => {
  // nested drawers reveal more toggles once a parent opens, so loop until dry
  for (let pass = 0; pass < 8; pass += 1) {
    const closed = root.querySelectorAll('button.cks-head[aria-expanded="false"]');
    if (closed.length === 0) return;
    for (const toggle of closed) toggle.click();
    await settle();
  }
};

describe("webapp dense apply page accessibility", () => {
  const DENSE_PAGES = [
    { factory: densePatchApplyPage, name: "3 patches, all enabled" },
    { factory: disabledPatchApplyPage, name: "3 patches, middle disabled + On/Off toggles" },
  ];
  for (const { factory, name } of DENSE_PAGES) {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        test(`dense apply (${name}, all drawers open) passes WCAG 2.1 A/AA + best-practice (${theme} theme, ${viewport.name})`, async () => {
          await setViewport(viewport);
          await renderPage(factory(), theme);
          await openAllDrawers(host);
          // sanity: nothing left collapsed (else axe silently skips it) and the
          // page really is dense - many open drawers across the ROM + 3 patches
          expect(host.querySelectorAll('button.cks-head[aria-expanded="false"]').length).toBe(0);
          expect(host.querySelectorAll(".cks.is-open").length).toBeGreaterThanOrEqual(5);
          expect(await scanViolations(host, { bestPractice: true, region: true })).toEqual([]);
        });
      }
    }
  }
});

// ── Banners ──────────────────────────────────────────────────────────────────
const Banners = () =>
  createElement(
    RomWeaverSettingsProvider,
    { settings: {} },
    createElement(
      "div",
      { className: "rw-app" },
      createElement(UpdateBanner, { onDismiss: noop, onReload: noop, open: true, title: "v0.2.0" }),
      createElement(WakeLockBanner, { onDismiss: noop, open: true }, "Keeping the screen awake while this job runs."),
    ),
  );

describe("webapp banner accessibility", () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`update + wake-lock banners pass WCAG 2.1 A/AA + best-practice (${theme} theme, ${viewport.name})`, async () => {
        await setViewport(viewport);
        await renderNode(createElement(Banners), theme);
        expect(await scanViolations(host, { bestPractice: true })).toEqual([]);
      });
    }
  }
});

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
  archive: () =>
    createElement(ArchiveDialog, {
      controller: {
        ...storeOf({
          entries: [
            { id: "r0", label: "Pokemon_Emerald.gba" },
            { id: "r1", label: "Pokemon_Ruby.gba" },
          ],
          open: true,
          selectionType: "rom",
          title: "Select a ROM from archive.zip",
        }),
        selectEntry: noop,
      },
    }),
  candidate: () => candidateDialog(false),
  "candidate (multi-select)": () => candidateDialog(true),
  confirm: () =>
    createElement(ConfirmDialog, {
      body: "This overwrites the existing output file. Continue?",
      cancelLabel: "Cancel",
      confirmLabel: "Overwrite",
      danger: true,
      onCancel: noop,
      onConfirm: noop,
      open: true,
      title: "Overwrite output?",
    }),
  log: () => createElement(LogDialog, { onClose: noop, open: true }),
  settings: () =>
    createElement(
      Modal,
      { onClose: noop, open: true, title: "Settings", variant: "settings-modal" },
      createElement(SettingsPanel, {
        draftSettings: settingsDraft,
        onClose: noop,
        onDraftChange: noop,
        onRestoreDefaults: noop,
        onSaveClose: noop,
        uiState: getSettingsUiState(settingsDraft),
        validation: validateSettingsDraft(settingsDraft),
      }),
    ),
};

const ModalHost = (node) =>
  createElement(RomWeaverSettingsProvider, { settings: {} }, createElement("div", { className: "rw-app" }, node));

describe("webapp modal accessibility", () => {
  for (const [name, factory] of Object.entries(DIALOGS)) {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        test(`${name} dialog passes WCAG 2.1 A/AA + best-practice (${theme} theme, ${viewport.name})`, async () => {
          await setViewport(viewport);
          await renderNode(ModalHost(factory()), theme);
          expect(await scanViolations(host, { bestPractice: true })).toEqual([]);
        });
      }
    }
  }
});

// ── Keyboard navigation ──────────────────────────────────────────────────────
// axe can't verify focus movement / roving tabindex, so this drives the real
// masthead tablist (ModeRail) with arrow / Home / End keys and asserts focus
// lands on the right tab and the select callback fires. (Theme-independent.)
describe("webapp keyboard navigation", () => {
  const renderMasthead = async (onSelectTab) =>
    renderNode(
      createElement(
        RomWeaverSettingsProvider,
        { settings: {} },
        createElement(
          "div",
          { className: "rw-app" },
          createElement(Masthead, {
            currentTab: "patcher",
            onOpenLog: noop,
            onOpenSettings: noop,
            onReset: noop,
            onSelectTab,
            tabs: PAGE_TABS,
          }),
        ),
      ),
      "light",
    );

  test("mode rail: arrow / Home / End move roving focus and select the tab", async () => {
    const selected = [];
    await renderMasthead((id) => selected.push(id));
    const tablist = host.querySelector('[role="tablist"]');
    const tabAt = (id) => host.querySelector(`.mode[data-mode="${id}"]`);

    // roving tabindex: only the current tab is in the tab order
    expect(tabAt("patcher").getAttribute("tabindex")).toBe("0");
    expect(tabAt("creator").getAttribute("tabindex")).toBe("-1");

    tabAt("patcher").focus();
    const press = (key) =>
      tablist.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));

    // currentTab stays "patcher" in isolation, so each key resolves from there
    press("ArrowRight");
    expect(document.activeElement).toBe(tabAt("creator"));
    press("End");
    expect(document.activeElement).toBe(tabAt("trim"));
    press("Home");
    expect(document.activeElement).toBe(tabAt("patcher"));
    press("ArrowLeft"); // wraps to the last tab
    expect(document.activeElement).toBe(tabAt("trim"));

    expect(selected).toEqual(["creator", "trim", "patcher", "trim"]);
  });
});

// ── Accent dye lots ──────────────────────────────────────────────────────────
// The accent axis re-dyes --thread / --thread-ink / --thread-text, which ~114
// declarations across 16 design-system files consume: primary buttons, the
// selected mode thumb, focus rings, meter fills, drawer seams, the channel
// badge. Every accent must therefore clear contrast on every surface, in both
// themes - a hue that only works on the default palette is a real regression.
//
// Accent tokens carry no layout, so contrast does not vary with width the way
// it does across the 8-viewport matrix above; this sweep runs one phone and one
// desktop width (the two that select different thread-bearing CSS, phone-dock
// vs. the default rules) against every accent instead.
const ACCENT_VIEWPORTS = [
  VIEWPORTS[0], // 360w smallest phone -> phone-dock.css thread rules
  VIEWPORTS[6], // 1280w desktop
];

// The masthead is the only place the channel badge renders, and it is the one
// surface where a thread-tinted fill sits behind thread-tinted text. Mounted as
// a full page (not a lone masthead) so the tabs' aria-controls resolve to the
// tabpanel they name, exactly as they do in production.
const badgedMastheadPage = () =>
  Shell(
    "patcher",
    "patcher",
    createElement(ApplyWorkflowFormView, { controllers: applyControllers(createEmptyPatcherUiState(), []) }),
    { channelBadge: "nightly" },
  );

// Curated to cover every design-system file that reads a thread token:
// dropzone/hero, file-cards + drawers + fields + workbench, result + weave-meter,
// dialogs, banners, and masthead (incl. the badge).
const ACCENT_SURFACES = [
  { factory: emptyApplyPage, name: "empty apply (hero + dropzone)", page: true },
  { dense: true, factory: densePatchApplyPage, name: "dense apply (cards, drawers, verdicts)", page: true },
  { factory: doneApplyPage, name: "apply completed (result + meter)", page: true },
  { factory: () => ModalHost(DIALOGS.settings()), name: "settings dialog" },
  { factory: () => ModalHost(DIALOGS.log()), name: "log dialog" },
  { factory: Banners, name: "banners" },
  { badge: true, factory: badgedMastheadPage, name: "masthead + channel badge", page: true },
];

describe("accent dye-lot accessibility", () => {
  for (const accent of ACCENTS) {
    for (const { badge, dense, factory, name, page: isPage } of ACCENT_SURFACES) {
      for (const theme of THEMES) {
        for (const viewport of ACCENT_VIEWPORTS) {
          test(`${name} passes WCAG 2.1 A/AA (${accent.value} accent, ${theme} theme, ${viewport.name})`, async () => {
            await setViewport(viewport);
            // The production application path, so a bug in applyAccent fails here too.
            applyAccent(accent.value);
            const node = isPage ? factory() : createElement(factory);
            if (isPage) await renderPage(node, theme);
            else await renderNode(node, theme);
            if (dense) await openAllDrawers(host);

            // sanity: the accent really is on the element the tokens key off
            const expected = accent.value === "madder" ? null : accent.value;
            expect(document.documentElement.getAttribute("data-accent")).toBe(expected);
            // …and the badge surface really rendered a badge, so it isn't scanning nothing
            if (badge) {
              expect(host.querySelector(".channel-badge")?.textContent).toBe("nightly");
              // The logo is an <img> of an inlined, re-dyed SVG. If the ?raw import ever
              // resolved to a URL or an empty string instead of the file's text, the mark
              // would silently render blank and every scan above would pass on nothing.
              const markSrc = host.querySelector("img.brand-mark")?.getAttribute("src") || "";
              expect(markSrc.startsWith("data:image/svg+xml,")).toBe(true);
              expect(markSrc).toContain(encodeURIComponent("<svg"));
              expect(markSrc).toContain(encodeURIComponent(accent.swatch));
              expect(markSrc).toContain(encodeURIComponent(accent.highlight));
              // No madder left anywhere once a different dye is selected.
              if (accent.value !== "madder") expect(markSrc).not.toContain(encodeURIComponent("#d9690f"));
            }

            expect(await scanViolations(host, { bestPractice: true, region: isPage })).toEqual([]);
          });
        }
      }
    }
  }
});

describe("webapp responsive navigation", () => {
  test("phone keeps the workflow rail in the masthead second row", async () => {
    await setViewport(VIEWPORTS[0]);
    await renderNode(
      createElement(
        RomWeaverSettingsProvider,
        { settings: {} },
        createElement(
          "div",
          { className: "rw-app" },
          createElement(Masthead, {
            currentTab: "patcher",
            onOpenLog: noop,
            onOpenSettings: noop,
            onReset: noop,
            onSelectTab: noop,
            tabs: [
              ...PAGE_TABS,
              { href: "tools", icon: createElement("span", { "aria-hidden": "true" }), id: "tools", label: "Tools" },
            ],
          }),
        ),
      ),
      "light",
    );

    const masthead = host.querySelector(".masthead");
    const brand = host.querySelector(".brand");
    const tools = host.querySelector(".masthead-tools");
    const modes = host.querySelector(".modes");
    const rail = host.querySelector(".mode-rail");
    const firstRowBottom = Math.max(brand.getBoundingClientRect().bottom, tools.getBoundingClientRect().bottom);
    const modesRect = modes.getBoundingClientRect();

    expect(getComputedStyle(modes).position).toBe("static");
    expect(modesRect.top).toBeGreaterThanOrEqual(firstRowBottom);
    expect(modesRect.bottom).toBeLessThanOrEqual(masthead.getBoundingClientRect().bottom);
    expect(rail.scrollWidth).toBeLessThanOrEqual(rail.clientWidth);
  });

  test("phone hero gives back the in-flow navigation height", async () => {
    await setViewport(VIEWPORTS[0]);
    await renderPage(emptyApplyPage(), "light");

    expect(getComputedStyle(host.querySelector(".drop.hero")).minHeight).toBe("485px");
  });
});
