import { Archive, Disc3, Download, ListChecks, Package, TriangleAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import type { BundleRomExpectation } from "../../lib/bundle/bundle-session-model.ts";
import { formatByteSize, type ProgressViewModel } from "../../presentation/workflow-presentation.ts";
import { createTiming, formatTiming } from "../../storage/shared/timing.ts";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import { ApplyPatchListStep, type RomCheckActuals } from "./apply-patch-list-step.tsx";
import { ChecksumList, ChecksumRow } from "./components/ds/checksum-list.tsx";
import {
  buildOutputCompressionPanel,
  FieldInfoToggle,
  getOutputCompressionFormatLabel,
} from "./components/ds/compress-panel.tsx";
import { Drawer, DrawerReadout } from "./components/ds/drawer.tsx";
import { ExtractName } from "./components/ds/extraction-tree.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { useFlatTransitionFlag } from "./components/ds/flat-transition.ts";
import { GhostSteps } from "./components/ds/ghost-steps.tsx";
import { InfoPopover, NeedsInput } from "./components/ds/layout.tsx";
import { OutputField } from "./components/ds/output-card.tsx";
import { StageStatus, stageBarValue, stagePercent, stageStatusLabel } from "./components/ds/staging-meta.tsx";
import { UnifiedDropZone } from "./components/ds/unified-drop-zone.tsx";
import { WorkflowOutputStep } from "./components/ds/workflow-output-step.tsx";
import { WorkflowRomInputStep, type WorkflowRomInputStepItem } from "./components/ds/workflow-rom-input-step.tsx";
import { PatcherPrimaryAction } from "./components/patcher-output-controls.tsx";
import { ProgressActionButton } from "./components/progress-action-button.tsx";
import { ARCHIVE_FILE_EXTENSIONS, PATCH_FILE_EXTENSIONS, ROM_FILE_EXTENSIONS } from "./file-classification.ts";
import { getFileInputAcceptAttributes } from "./file-input-accept";
import { createCompressionTypeOptions } from "./output-view-model.ts";
import type {
  DialogController,
  NoticeController,
  PatcherOutputController,
  PatcherStackController,
  PatcherUiController,
  StartupState,
} from "./patcher-form.ts";
import { inertUiController } from "./patcher-form-session.ts";
import type { PatcherOutputState, PatchStackItemState } from "./patcher-presentation.ts";
import { ArchiveDialog as SharedArchiveDialog } from "./patcher-react-shared.tsx";
import type { NoticeState, PatcherSectionNoticeKey, RomInputRowState } from "./patcher-ui-state.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";
import type { PendingDrop } from "./use-unified-apply-drop.ts";
import { toWorkflowChecksumProgressProps, toWorkflowFileProgressProps } from "./workflow-run-hooks.ts";

const usePendingCardMorph = (pendingCount: number, _resolvedCount: number) => {
  const knownCards = useRef(new WeakSet<Element>());
  const sourceRects = useRef<DOMRect[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The count controls the intentional DOM animation lifecycle.
  useLayoutEffect(() => {
    const panel = document.getElementById("rom-weaver-container");
    if (!panel) return;
    const cards = Array.from(panel.querySelectorAll<HTMLElement>(".workflow-file-list > .card.file"));
    if (pendingCount > 0) {
      sourceRects.current = Array.from(panel.querySelectorAll<HTMLElement>(".rw-pending"), (row) =>
        row.getBoundingClientRect(),
      );
      return;
    }

    const sources = sourceRects.current;
    if (sources.length && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cards
        .filter((card) => !knownCards.current.has(card))
        .forEach((card, index) => {
          const source = sources[Math.min(index, sources.length - 1)];
          if (!source) return;
          const target = card.getBoundingClientRect();
          card.animate(
            [
              {
                opacity: 0.35,
                transform: `translate(${source.left - target.left}px, ${source.top - target.top}px) scale(${source.width / target.width}, ${source.height / target.height})`,
                transformOrigin: "top left",
              },
              { offset: 0.78, opacity: 1, transform: "scale(1.012)", transformOrigin: "top left" },
              { opacity: 1, transform: "none", transformOrigin: "top left" },
            ],
            {
              delay: Math.min(index, 3) * 25,
              duration: 280,
              easing: "cubic-bezier(.2,.8,.2,1)",
              fill: "backwards",
            },
          );
        });
    }
    sourceRects.current = [];
    for (const card of cards) knownCards.current.add(card);
  }, [pendingCount]);
};

const PendingDropCard = ({ drop }: { drop: PendingDrop }) => (
  <FileCard
    className="pending-card"
    meta={
      <StageStatus
        id={`rom-weaver-progress-identify-${drop.id}`}
        label={drop.bundle ? "Reading bundle" : drop.entryCount === undefined ? "Identifying" : "Identified"}
        percent={null}
      />
    }
    name={<ExtractName fileName={drop.name} />}
    stageBar="indeterminate"
  >
    {drop.extracting ? (
      <Drawer
        bodyClassName="taskbody"
        className="extract-d"
        label="Files"
        labelIcon={<Archive aria-hidden="true" />}
        readouts={
          drop.entryCount === undefined ? undefined : (
            <DrawerReadout>
              {drop.entryCount} {drop.entryCount === 1 ? "item" : "items"}
            </DrawerReadout>
          )
        }
      >
        <span />
      </Drawer>
    ) : null}
    {drop.kind === "rom" && drop.sheet ? (
      <Drawer className="cue rw-cue-section" label={drop.sheet} labelIcon={<Disc3 aria-hidden="true" />}>
        <span />
      </Drawer>
    ) : null}
    {drop.kind === "rom" ? (
      <Drawer bodyClassName="ckrows" label="Checks" labelIcon={<ListChecks aria-hidden="true" />}>
        <span />
      </Drawer>
    ) : null}
  </FileCard>
);

const ApplyDropAfter = ({
  onLoadSample,
  pendingDrops,
  sampleError,
  sampleLoading,
  workflowEmpty,
}: {
  onLoadSample: () => void;
  pendingDrops: PendingDrop[];
  sampleError: string;
  sampleLoading: boolean;
  workflowEmpty: boolean;
}) => {
  if (pendingDrops.length) {
    return (
      <div className="cards workflow-file-list" id="rom-weaver-pending-drops">
        {pendingDrops.map((drop) => (
          <div className="rw-pending" key={drop.id}>
            <PendingDropCard drop={drop} />
          </div>
        ))}
      </div>
    );
  }
  if (!workflowEmpty) return null;
  return (
    <div className="first-weave-demo">
      <span>New here?</span>
      <button
        aria-busy={sampleLoading}
        className="btn ghost slim"
        disabled={sampleLoading}
        onClick={onLoadSample}
        type="button"
      >
        {sampleLoading ? "Loading sample…" : "Try a sample apply"}
      </button>
      {sampleError ? <span role="status">{sampleError}</span> : null}
    </div>
  );
};

/**
 * Purely presentational apply-workflow view: renders the step layout from the
 * ui/patchStack/output/notice/dialog controllers ApplyPatchForm wires up.
 */

/** Full registry support, listed in the 0x01 info popover. */
const APPLY_SUPPORTED_FILES = [
  { extensions: ROM_FILE_EXTENSIONS, label: "ROMs" },
  { extensions: PATCH_FILE_EXTENSIONS, label: "Patches" },
  { extensions: ARCHIVE_FILE_EXTENSIONS, label: "Archives & containers" },
] as const;

const TIMING_LABEL = (ms?: number) =>
  typeof ms === "number" && Number.isFinite(ms) ? formatTiming(createTiming(ms)) : "";
const CHECKSUM_TIMING_LABEL = (timing?: string, prefix = "Checksum") => (timing ? `${prefix} ${timing}` : undefined);

/** Compact platform abbreviations for the ROM type tag (e.g. "Sony PlayStation" → "PSX"). */
const PLATFORM_ABBREVIATIONS: Record<string, string> = {
  "Atari 7800": "A7800",
  "Atari Lynx": "LYNX",
  "NEC PC-Engine CD & TurboGrafx-16 CD": "PCE-CD",
  "Neo Geo Pocket": "NGP",
  "Nintendo 3DS": "3DS",
  "Nintendo 64": "N64",
  "Nintendo DS": "NDS",
  "Nintendo Entertainment System": "NES",
  "Nintendo Famicom Disk System": "FDS",
  "Nintendo Game Boy": "GB",
  "Nintendo Game Boy Advance": "GBA",
  "Nintendo GameCube": "GC",
  "Nintendo Super Nintendo Entertainment System": "SNES",
  "Nintendo Wii": "WII",
  "Sega Dreamcast": "DC",
  "Sega Master System": "SMS",
  "Sega Mega CD _ Sega CD": "SCD",
  "Sega Mega Drive _ Genesis": "GEN",
  "Sega Saturn": "SAT",
  "Sony PlayStation": "PSX",
  "Sony PlayStation 2": "PS2",
  "Sony Playstation Portable": "PSP",
  "TurboGrafx-16_PC Engine": "PCE",
};

/** Render a backend ROM type tag as "PLATFORM · DISC" (e.g. "PSX · CD"); empty when unknown. */
const formatRomTypeTag = (romType: { platform?: string; discFormat?: string } | undefined): string => {
  if (!romType) return "";
  const platform = romType.platform ? (PLATFORM_ABBREVIATIONS[romType.platform] ?? romType.platform) : "";
  return [platform, romType.discFormat].filter(Boolean).join(" · ");
};

const EXPECTED_ROM_CHECK_LABELS: Record<string, string> = { crc32: "CRC32", md5: "MD5", sha1: "SHA-1" };

/**
 * "Provide this ROM" card for a patches-only bundle, styled like the ROM card
 * it becomes once the input lands - only the meta note marks it expected.
 */
const BundleRomExpectationCard = ({ expectation }: { expectation: BundleRomExpectation }) => (
  <div className="cards bundle-rom-expectation" id="rom-weaver-bundle-rom-expectation">
    <FileCard
      meta={<span>ROM not included - provide it yourself</span>}
      name={<ExtractName fileName={expectation.name || "Expected ROM"} />}
    >
      <ChecksumList defaultOpen label="Checks" sublabel="expected">
        {/* CRC32 then BYTES first: the two short ck-half rows must sit adjacent
            so the ckrows grid can pair them, matching the resolved ROM card */}
        {expectation.checks?.checksums?.crc32 ? (
          <ChecksumRow label="CRC32" value={expectation.checks.checksums.crc32} />
        ) : null}
        {typeof expectation.checks?.size === "number" ? (
          <ChecksumRow
            copyValue={String(expectation.checks.size)}
            label="BYTES"
            value={String(expectation.checks.size)}
          />
        ) : null}
        {Object.entries(expectation.checks?.checksums || {}).map(([algorithm, value]) =>
          value && algorithm !== "crc32" ? (
            <ChecksumRow
              key={algorithm}
              label={EXPECTED_ROM_CHECK_LABELS[algorithm] || algorithm.toUpperCase()}
              value={value}
            />
          ) : null,
        )}
      </ChecksumList>
    </FileCard>
  </div>
);

/** Bundle-related notices and export reveal state, threaded from the form. */
type BundleToolsState = {
  /** True when a bundle package is selected (drives the export/create action). */
  exportVisible: boolean;
  /** Persist the bundle package choice ("" hides it), synced to user settings. */
  setBundlePackage: (value: string) => void;
  /** The run has optional entries (or patches toggled off): output checks only
   * describe the full chain. */
  hasOptionalEntries: boolean;
  /** Why the woven final result won't be verified against an expected output;
   * null when it will be, or when nothing declares an output. */
  outputVerification: { level: "warn"; message: string } | null;
};

type BundleExportState = {
  bundleRom: boolean;
  busy: boolean;
  cancelExport: () => void;
  downloadable: boolean;
  error: string;
  format: string;
  progress: ProgressViewModel | null;
  ready: boolean;
  runExport: () => Promise<void>;
  setBundleRom: (value: boolean) => void;
  setFormat: (value: string) => void;
};

const SectionNotice = ({ id, onDismiss, state }: { id?: string; onDismiss?: () => void; state: NoticeState }) => {
  if (!state.visible) return null;
  return (
    <Notice
      id={id}
      level={state.level === "warning" ? "warn" : "error"}
      onDismiss={state.dismissible ? onDismiss : undefined}
    >
      {state.message}
    </Notice>
  );
};

const ROM_CHECKSUM_HEX_LENGTHS: Record<number, "crc32" | "md5" | "sha1"> = { 8: "crc32", 32: "md5", 40: "sha1" };

/**
 * Compare a user-pasted checksum against a ROM's computed checksums, mirroring
 * the apply-time hex auto-detection (crc32/md5/sha1 by length). Undefined when
 * there is nothing to compare yet.
 */
const matchPastedInputChecksum = (pasted: string, info: RomInputRowState["info"]): "bad" | "ok" | undefined => {
  const hex = pasted.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(hex)) return undefined;
  const algorithm = ROM_CHECKSUM_HEX_LENGTHS[hex.length];
  if (!algorithm) return undefined;
  const actual = (info[algorithm] || "").trim().toLowerCase();
  if (!actual) return undefined;
  return actual === hex ? "ok" : "bad";
};

/**
 * ROM verification color: green once a patch verifies it (embedded preflight
 * or user-pasted checksum), red on mismatch, none when nothing verifies it.
 * A mismatch from any signal wins over a match.
 */
/* A patch's embedded/manifest ROM requirements describe its input like bundle
   rom.checks - parse them from the card's "in ..." rows so they fold into the
   same Expected marks on the ROM card. */
const parsePatchInputExpectation = (patch: PatchStackItemState): ParsedBundleChecks | undefined => {
  const checksums: Record<string, string> = {};
  let size: number | undefined;
  for (const entry of patch.validationValues || []) {
    // "in min size" (xdelta) is a lower bound, not an identity - skip it.
    const match = /^in (crc32|md5|sha-?1|size)=(.+)$/i.exec(entry);
    if (!match) continue;
    const key = (match[1] || "").toLowerCase().replace("sha-1", "sha1");
    const value = (match[2] || "").trim();
    if (!value) continue;
    if (key === "size") {
      const bytes = Number(value);
      if (Number.isFinite(bytes)) size = bytes;
      continue;
    }
    checksums[key] = value;
  }
  if (!(Object.keys(checksums).length || size !== undefined)) return undefined;
  return { checksums, ...(size === undefined ? {} : { size }) };
};

/* Pre-plan fallback: the chain-input patch (first enabled) is the one whose
   input describes the base ROM under sequential semantics. */
const parseChainInputExpectation = (
  patches: PatchStackItemState[],
  disabledFlags?: readonly boolean[],
): ParsedBundleChecks | undefined => {
  const chainInput = patches.find((_, index) => !disabledFlags?.[index]);
  return chainInput ? parsePatchInputExpectation(chainInput) : undefined;
};

const collectPlanBaseContributions = (
  patches: PatchStackItemState[],
  disabledFlags: readonly boolean[],
  bundleMeta: ReadonlyArray<BundlePatchMeta | undefined>,
  bundleRomChecks: ParsedBundleChecks | undefined,
) => {
  const contributions: ParsedBundleChecks[] = bundleRomChecks ? [bundleRomChecks] : [];
  let sawBaseVerdict = false;
  for (const [index, patch] of patches.entries()) {
    if (disabledFlags[index] || patch.chainVerdict?.basis !== "base") continue;
    sawBaseVerdict = true;
    const expectation = bundleMeta[index]?.inputChecks ?? parsePatchInputExpectation(patch);
    if (expectation) contributions.push(expectation);
  }
  return { contributions, sawBaseVerdict };
};

const mergePlanBaseContributions = (
  contributions: ParsedBundleChecks[],
  romInfo: RomInputRowState["info"] | undefined,
) => {
  const checksums: Record<string, string> = {};
  let size: number | undefined;
  let conflict = false;
  for (const contribution of contributions) {
    for (const [algorithm, rawValue] of Object.entries(contribution.checksums || {})) {
      const key = algorithm.toLowerCase().replace("sha-1", "sha1");
      const value = rawValue.trim().toLowerCase();
      if (!value) continue;
      const existing = checksums[key];
      if (existing === undefined || existing === value) {
        checksums[key] = value;
        continue;
      }
      conflict = true;
      const actual =
        key === "crc32" || key === "md5" || key === "sha1" ? (romInfo?.[key] || "").trim().toLowerCase() : "";
      if (actual && value === actual) checksums[key] = value;
    }
    if (contribution.size !== undefined) {
      if (size === undefined) size = contribution.size;
      else if (size !== contribution.size) conflict = true;
    }
  }
  return { checksums, conflict, size };
};

/**
 * Plan-fed base expectation for a single-ROM bench: union the checks of every
 * base-basis patch with the bundle's rom.checks. On disagreement the value
 * matching the staged ROM wins and a base conflict is flagged (the losing
 * patch's own card shows the mismatch). Null when the plan offered no
 * base-basis verdicts - callers fall back to the chain-input parse.
 */
const buildPlanBaseExpectation = (
  patches: PatchStackItemState[],
  disabledFlags: readonly boolean[],
  bundleMeta: ReadonlyArray<BundlePatchMeta | undefined>,
  bundleRomChecks: ParsedBundleChecks | undefined,
  romInfo: RomInputRowState["info"] | undefined,
): { conflict: boolean; expected: ParsedBundleChecks } | null => {
  const { contributions, sawBaseVerdict } = collectPlanBaseContributions(
    patches,
    disabledFlags,
    bundleMeta,
    bundleRomChecks,
  );
  if (!(sawBaseVerdict && contributions.length)) return null;
  const { checksums, conflict, size } = mergePlanBaseContributions(contributions, romInfo);
  if (!(Object.keys(checksums).length || size !== undefined)) return null;
  return { conflict, expected: { checksums, ...(size === undefined ? {} : { size }) } };
};

const buildRomVerificationStates = (
  patches: PatchStackItemState[],
  romInputs: RomInputRowState[],
  disabledFlags: boolean[],
) => {
  const infoById = new Map(romInputs.map((rom) => [rom.id, rom.info]));
  const states = new Map<string, "bad" | "ok">();
  const apply = (romId: string, verdict: "bad" | "ok" | undefined) => {
    if (!verdict) return;
    if (verdict === "bad" || !states.has(romId)) states.set(romId, verdict);
  };
  for (const [patchIndex, patch] of patches.entries()) {
    // A toggled-off patch will not apply, so its expectations say nothing
    // about the ROM being used.
    if (disabledFlags[patchIndex]) continue;
    const romId = patch.targetValue;
    if (!romId) continue;
    apply(
      romId,
      patch.sourceChecksumState === "invalid" ? "bad" : patch.sourceChecksumState === "valid" ? "ok" : undefined,
    );
    const info = infoById.get(romId);
    if (info && patch.validateInputChecksum) apply(romId, matchPastedInputChecksum(patch.validateInputChecksum, info));
  }
  return states;
};

/** Dependencies threaded into the ROM-row renderers. */
type RomRowDeps = {
  romInputs: RomInputRowState[];
  verificationStates: Map<string, "bad" | "ok">;
  ui: PatcherUiController;
  /** The bundle's expected base-ROM checks - an "Expected" group with match
   * marks inside the staged ROM's Checks drawer (single-ROM sessions only). */
  expectedChecks?: ParsedBundleChecks;
};

/**
 * Multi-track CD/GD discs arrive as several rows (the cue/gdi sheet plus one
 * row per .bin track) sharing a `groupId`. Collapse each such group into one
 * "disc" entry; rows without a groupId (and lone groups) render individually.
 */
type RomInputGroup =
  | { kind: "single"; row: RomInputRowState; index: number }
  | { kind: "disc"; rows: Array<{ row: RomInputRowState; index: number }> };

const groupRomInputs = (rows: RomInputRowState[]): RomInputGroup[] => {
  const groups: RomInputGroup[] = [];
  const discPositions = new Map<string, number>();
  rows.forEach((row, index) => {
    const groupId = row.groupId;
    if (!groupId) {
      groups.push({ index, kind: "single", row });
      return;
    }
    const position = discPositions.get(groupId);
    const existing = position === undefined ? undefined : groups[position];
    if (existing && existing.kind === "disc") {
      existing.rows.push({ index, row });
      return;
    }
    discPositions.set(groupId, groups.length);
    groups.push({ kind: "disc", rows: [{ index, row }] });
  });
  // A "disc" of a single row is not a disc - render it as a normal row.
  return groups.map((group) => {
    if (group.kind === "disc" && group.rows.length === 1) {
      const only = group.rows[0];
      if (only) return { index: only.index, kind: "single", row: only.row };
    }
    return group;
  });
};

const renderRomInputRow = (romInput: RomInputRowState, index: number, deps: RomRowDeps): WorkflowRomInputStepItem => {
  const { romInputs, verificationStates, ui } = deps;
  const state = verificationStates.get(romInput.id);
  // CLS: the resolved card stays mounted through staging - a slim top-edge bar +
  // meta status carry progress, and the Checks drawer reserves shimmer rows sized
  // to the eventual hash lengths, so nothing below the card moves when checksums
  // land (the bare-panel → full-card swap was the dominant layout shift).
  const staging = !!romInput.progress;
  const stagingPhase = romInput.info.validationPhase === "checksum" ? "checksum" : "rom";
  let stagingProps: ReturnType<typeof toWorkflowFileProgressProps> = null;
  if (staging) {
    stagingProps =
      stagingPhase === "checksum"
        ? toWorkflowChecksumProgressProps(romInput.progress)
        : toWorkflowFileProgressProps(romInput.progress);
  }
  const percent = stagePercent(stagingProps);
  // A container ROM extracts and checksums in one pass (Rust hashes inline), so it
  // sits in the "extract" phase throughout - show both verbs. Phase comes from the
  // runtime stage, not the label text, so the verb survives stageless ticks.
  const stageLabel = stageStatusLabel("Checksumming", romInput.info.validationPhase === "extract");
  const romBytes = romInput.size ?? romInput.sourceSize;
  const romTypeTag = formatRomTypeTag(romInput.info.romType);
  const hasDiscSheet = romInput.kind === "track";
  const fileEntries =
    hasDiscSheet && (romInput.cueText || romInput.gdiText)
      ? [
          ...(romInput.cueText
            ? [
                {
                  decompressionTimeMs: romInput.decompressionTimeMs,
                  fileName: romInput.info.fileName.replace(/\.[^.]+$/, ".cue"),
                  fileSize: new TextEncoder().encode(romInput.cueText).byteLength,
                },
              ]
            : []),
          ...(romInput.gdiText
            ? [
                {
                  fileName: romInput.info.fileName.replace(/\.[^.]+$/, ".gdi"),
                  fileSize: new TextEncoder().encode(romInput.gdiText).byteLength,
                },
              ]
            : []),
          { fileName: romInput.info.fileName, fileSize: romBytes },
        ]
      : undefined;
  const romByteCount = typeof romBytes === "number" && Number.isFinite(romBytes) ? Math.floor(romBytes) : undefined;
  const baseRows = [
    { label: "CRC32", length: 8 },
    { label: "BYTES", length: romByteCount === undefined ? 8 : String(romByteCount).length },
    { label: "MD5", length: 32 },
    { label: "SHA-1", length: 40 },
  ];
  // Phase A reserves the base group as bare rows (matching the no-variant
  // layout). A 512-byte copier header (SNES et al., size % 1024 === 512) makes
  // the resolved card add a labeled "Unchanged" + "Remove header" pair, so when
  // one is present reserve both groups here - otherwise that second group lands
  // on hash completion and shoves the Weave button below it down the page.
  const pendingGroups =
    romByteCount !== undefined && romByteCount % 1024 === 512
      ? [
          { id: "raw", label: "Unchanged", rows: baseRows },
          {
            id: "remove-header",
            label: "Remove header",
            rows: [
              { label: "CRC32", length: 8 },
              { label: "BYTES", length: String(romByteCount - 512).length },
              { label: "MD5", length: 32 },
              { label: "SHA-1", length: 40 },
            ],
          },
        ]
      : [{ id: "raw", rows: baseRows }];
  return {
    card: {
      extract: {
        always: true,
        fileEntries,
        fileName: romInput.info.fileName,
        fileSize: romBytes,
        legacyFileClassName: "rom-weaver-input-stack-file",
        parentCompressions: romInput.archivePathEntries,
        timing: TIMING_LABEL(romInput.decompressionTimeMs),
      },
      meta:
        typeof romBytes === "number" || romTypeTag || staging ? (
          <>
            {typeof romBytes === "number" ? <span className="fsize mono">{formatByteSize(romBytes)}</span> : null}
            {romTypeTag ? <span className="meta-fmt mono">{romTypeTag}</span> : null}
            {staging ? (
              <StageStatus id={`rom-weaver-progress-${stagingPhase}-${index}`} label={stageLabel} percent={percent} />
            ) : null}
          </>
        ) : undefined,
      onRemove: () => {
        if (romInputs.length === 1 && ui.clearRomInput) ui.clearRomInput();
        else ui.removeRomInput?.(romInput.id);
      },
      panels: {
        info: {
          bytes: romBytes,
          checksums: staging
            ? undefined
            : { crc32: romInput.info.crc32, md5: romInput.info.md5, sha1: romInput.info.sha1 },
          checksumVariants: staging ? undefined : romInput.info.checksumVariants,
          ...(deps.expectedChecks && !staging ? { expected: deps.expectedChecks } : {}),
          lead: !staging && romInput.info.romInfo ? <p className="pdesc">{romInput.info.romInfo}</p> : undefined,
          onToggle: () => ui.toggleRomInputChecksums?.(romInput.id),
          open: staging ? true : romInput.info.checksumsExpanded,
          pending: staging ? pendingGroups : undefined,
          timing: staging ? undefined : CHECKSUM_TIMING_LABEL(romInput.info.checksumTiming),
          trim: staging ? undefined : romInput.info.romProbe?.trim,
        },
        ...(hasDiscSheet && romInput.cueText ? { cue: { cueText: romInput.cueText } } : {}),
      },
      removeLabel: romInputs.length > 1 ? "Remove ROM input" : "Clear ROM input",
      stageBar: stageBarValue(staging, percent),
      state,
    },
    id: romInput.id,
  };
};

/** Drop the extension and a trailing "(Track N)" suffix - "Game (Track 1).bin" → "Game". */
const discDisplayName = (fileName: string): string => {
  const base = fileName.replace(/^.*[/\\]/, "");
  const withoutExt = base.replace(/\.[^.]+$/, "");
  return withoutExt.replace(/\s*\(track\s*\d+\)\s*$/i, "") || withoutExt || base;
};

/**
 * Disc display name: a track filename like "track01.bin" is a poor title, so
 * prefer the dropped archive's base name, then a `.cue`/`.gdi` sheet row, and
 * only fall back to a track-derived name.
 */
const discGroupDisplayName = (
  groupRows: RomInputRowState[],
  cueRow: RomInputRowState | undefined,
  firstTrackName: string | undefined,
): string => {
  const archiveFileName = groupRows.find((row) => row.archivePathEntries?.length)?.archivePathEntries?.[0]?.fileName;
  return (
    (archiveFileName && discDisplayName(archiveFileName)) ||
    (cueRow?.info.fileName && discDisplayName(cueRow.info.fileName)) ||
    (firstTrackName ? discDisplayName(firstTrackName) : "Disc")
  );
};

const getDiscOverallPercent = (
  staging: boolean,
  totalBytes: number,
  trackRows: RomInputRowState[],
  tracks: Array<{ progress: ReturnType<typeof toWorkflowChecksumProgressProps> }>,
): number | null => {
  if (!staging || totalBytes <= 0) return null;
  let completedBytes = 0;
  for (const [index, row] of trackRows.entries()) {
    const bytes = row.size ?? row.sourceSize;
    if (!(typeof bytes === "number" && Number.isFinite(bytes))) return null;
    const progress = tracks[index]?.progress;
    if (!row.progress && (row.info.crc32 || row.info.md5 || row.info.sha1)) completedBytes += bytes;
    else if (row.progress?.value === "waiting") continue;
    else if (typeof progress?.percent === "number") completedBytes += bytes * (progress.percent / 100);
    else return null;
  }
  return (completedBytes / totalBytes) * 100;
};

/** Render a multi-track disc as one card with per-track checksums + cue view. */
const renderDiscGroup = (
  rows: Array<{ row: RomInputRowState; index: number }>,
  deps: RomRowDeps,
): WorkflowRomInputStepItem => {
  const { romInputs, verificationStates, ui } = deps;
  const groupRows = rows.map((entry) => entry.row);
  const cueRow = groupRows.find((row) => row.kind === "cue");
  const gdiRow = groupRows.find((row) => row.kind === "gdi");
  const trackRows = groupRows.filter((row) => row.kind !== "cue" && row.kind !== "gdi");
  const groupId = groupRows[0]?.groupId || cueRow?.id || "disc";
  const cueText = groupRows.find((row) => Boolean(row.cueText))?.cueText;
  const gdiText = groupRows.find((row) => Boolean(row.gdiText))?.gdiText;
  const totalBytes = trackRows.reduce((sum, row) => sum + (row.size ?? row.sourceSize ?? 0), 0);
  const discRomType = groupRows.find((row) => row.info.romType?.platform || row.info.romType?.discFormat)?.info.romType;
  const discRomTypeTag = formatRomTypeTag(discRomType);
  const firstTrackName = trackRows[0]?.info.fileName;
  const discName = discGroupDisplayName(groupRows, cueRow, firstTrackName);
  const sheetEntries: Array<{ fileName: string; fileSize?: number; decompressionTimeMs?: number }> = [
    ...(cueText && !cueRow
      ? [
          {
            decompressionTimeMs: trackRows[0]?.decompressionTimeMs,
            fileName: firstTrackName?.replace(/\.[^.]+$/, ".cue") || `${discName}.cue`,
            fileSize: new TextEncoder().encode(cueText).byteLength,
          },
        ]
      : []),
    ...(gdiText && !gdiRow
      ? [
          {
            fileName: firstTrackName?.replace(/\.[^.]+$/, ".gdi") || `${discName}.gdi`,
            fileSize: new TextEncoder().encode(gdiText).byteLength,
          },
        ]
      : []),
  ];
  const fileEntries = [
    ...sheetEntries,
    ...groupRows.map((row) => ({
      decompressionTimeMs: row.decompressionTimeMs,
      fileName: row.info.fileName,
      fileSize: row.size ?? row.sourceSize,
    })),
  ];
  const totalFileBytes = fileEntries.reduce((sum, entry) => sum + (entry.fileSize ?? 0), 0);
  // Any verified-bad track marks the disc bad; otherwise ok once any track verifies.
  let state: "bad" | "ok" | undefined;
  for (const row of groupRows) {
    const verdict = verificationStates.get(row.id);
    if (verdict === "bad") {
      state = "bad";
      break;
    }
    if (verdict === "ok") state = "ok";
  }
  const removeDisc = () => {
    if (romInputs.length === rows.length && ui.clearRomInput) ui.clearRomInput();
    else for (const row of groupRows) ui.removeRomInput?.(row.id);
  };
  const tracks = trackRows.map((row) => {
    const checksumProgress = row.progress && row.info.validationPhase === "checksum" ? row.progress : null;
    return {
      bytes: row.size ?? row.sourceSize,
      checksums: { crc32: row.info.crc32, md5: row.info.md5, sha1: row.info.sha1 },
      id: row.id,
      label: row.info.fileName,
      progress: toWorkflowChecksumProgressProps(checksumProgress),
    };
  });
  const staging = trackRows.some((row) => !!row.progress);
  const overallPercent = getDiscOverallPercent(staging, totalBytes, trackRows, tracks);
  return {
    card: {
      extract: {
        fileName: discName,
        fileEntries,
        fileSize: totalFileBytes || totalBytes || undefined,
        legacyFileClassName: "rom-weaver-input-stack-file",
        parentCompressions: groupRows.find((row) => row.archivePathEntries?.length)?.archivePathEntries,
        always: true,
      },
      meta:
        totalBytes || discRomTypeTag || staging ? (
          <>
            {totalBytes ? <span className="fsize mono">{formatByteSize(totalBytes)}</span> : null}
            {discRomTypeTag ? <span className="meta-fmt mono">{discRomTypeTag}</span> : null}
            {staging ? (
              <StageStatus id={`rom-weaver-progress-disc-${groupId}`} label="Checksumming…" percent={overallPercent} />
            ) : null}
          </>
        ) : undefined,
      onRemove: removeDisc,
      panels: {
        info: { timing: CHECKSUM_TIMING_LABEL(trackRows[0]?.info.checksumTiming) },
        tracks,
        ...(cueText ? { cue: { cueText } } : {}),
        ...(gdiText ? { gdi: { gdiText } } : {}),
      },
      removeLabel: "Remove disc",
      stageBar: stageBarValue(staging, overallPercent),
      state,
    },
    id: groupId,
  };
};

/** Patch On/Off plumbing from the form: stable-id toggle set + index toggle. */
type PatchEnablement = {
  disabledIds: ReadonlySet<string>;
  getPatchIds: () => string[];
  onToggle: (index: number) => void;
};

// The apply view is a singleton in the webapp; a stable per-workflow key keeps
// its activity slot separate from the create/trim forms in the shared store.
const APPLY_ACTIVITY_KEY = "react-apply-view";
const FIRST_WEAVE_URL = "/first-weave.zip";

const getBundleVerificationError = (bundleMeta: Array<BundlePatchMeta | undefined>, patches: PatchStackItemState[]) => {
  const lengths: Record<string, number> = { crc32: 8, md5: 32, sha1: 40 };
  for (const [index, meta] of bundleMeta.entries()) {
    for (const [side, checks] of [
      ["input", meta?.inputChecks?.checksums],
      ["output", meta?.outputChecks?.checksums],
    ] as const) {
      for (const [algorithm, rawValue] of Object.entries(checks || {})) {
        const normalizedAlgorithm = algorithm.toLowerCase().replace("sha-1", "sha1");
        const value = rawValue.trim().toLowerCase();
        if (!value) continue;
        const length = lengths[normalizedAlgorithm];
        if (!(length && new RegExp(`^[0-9a-f]{${length}}$`).test(value))) {
          return `Patch ${index + 1} ${side} ${algorithm.toUpperCase()} is malformed`;
        }
        const prefix = side === "input" ? "in " : "out ";
        const embedded = patches[index]?.validationValues
          .map((entry) => entry.split("=", 2))
          .find(
            ([label]) => label?.trim().toLowerCase().replace("sha-1", "sha1") === `${prefix}${normalizedAlgorithm}`,
          )?.[1]
          ?.trim()
          .toLowerCase();
        if (embedded && embedded !== value) {
          return `Patch ${index + 1} ${side} ${algorithm.toUpperCase()} conflicts with the checksum built into the patch`;
        }
      }
    }
  }
  return "";
};

const OutputHeaderField = ({
  disabled,
  headeredExtension,
  headerlessExtension,
  onChange,
  retained,
  value,
  visible,
}: {
  disabled: boolean;
  headeredExtension?: string;
  headerlessExtension?: string;
  onChange: (value: "auto" | "keep" | "strip") => void;
  retained: boolean;
  value?: "auto" | "keep" | "strip";
  visible: boolean;
}) => {
  if (!visible) return null;
  const extensionsDiffer = !!headeredExtension && !!headerlessExtension && headeredExtension !== headerlessExtension;
  const info = {
    items: [
      `Auto keeps headers emulators require (iNES/FDS/LNX/A78) and drops junk copier headers (SNES/PCE/Game Doctor)${retained ? "" : " - this ROM's header is copier junk, so auto drops it"}.`,
      "Keep header: the patched output carries the ROM header (re-added if it was stripped for patching).",
      "Headerless: the patched output has no ROM header (stripped from the output if the patch ran on the headered bytes).",
      ...(extensionsDiffer
        ? [
            `The output extension follows the choice: ${headeredExtension} with the header, ${headerlessExtension} without.`,
          ]
        : []),
    ],
    summary:
      "Whether the patched output carries the ROM's copier header. Separate from the per-patch strip choice, which only controls what bytes the patch applies against.",
    title: "Output Header",
  };
  return (
    <OutputField label="Output Header" labelInfo={<FieldInfoToggle info={info} label="Output Header" />}>
      <select
        aria-label="Output Header"
        className="select"
        disabled={disabled}
        id="rom-weaver-select-output-header"
        onChange={(event) => onChange(event.currentTarget.value as "auto" | "keep" | "strip")}
        value={value || "auto"}
      >
        <option value="auto">auto ({retained ? "keep" : "strip"})</option>
        <option value="keep">keep</option>
        <option value="strip">strip</option>
      </select>
    </OutputField>
  );
};

const ApplyOutputAction = ({
  applyTotalTime,
  bundleActionLabel,
  bundleExport,
  bundleTools,
  bundleVerificationError,
  controllers,
  disabledPatchCount,
  enabledPatchCount,
  errorNotice,
  localizer,
  noticeController,
  outputState,
  patches,
  romInputs,
  uiController,
  uiState,
}: {
  applyTotalTime: PatcherOutputState["totalTiming"];
  bundleActionLabel: string;
  bundleExport?: BundleExportState;
  bundleTools?: BundleToolsState;
  bundleVerificationError: string | null;
  controllers: { output: PatcherOutputController };
  disabledPatchCount: number;
  enabledPatchCount: number;
  errorNotice: NoticeState | null;
  localizer: ReturnType<typeof useUiLocalizer>;
  noticeController?: NoticeController;
  outputState: PatcherOutputState;
  patches: PatchStackItemState[];
  romInputs: RomInputRowState[];
  uiController: PatcherUiController;
  uiState: ReturnType<PatcherUiController["getState"]>;
}) => (
  <>
    {errorNotice?.visible ? (
      <Notice
        id="rom-weaver-row-error-message"
        level={errorNotice.level === "warning" ? "warn" : "error"}
        onDismiss={errorNotice.dismissible ? () => noticeController?.dismiss?.() : undefined}
      >
        {errorNotice.message}
      </Notice>
    ) : null}
    {uiState.checksumOverride.visible ? (
      <label className="checkrow warn">
        <input
          checked={uiState.checksumOverride.checked}
          disabled={uiState.checksumOverride.disabled}
          id="rom-weaver-checkbox-checksum-override"
          onChange={(event) => uiController.setChecksumOverride?.(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>{uiState.checksumOverride.label}</span>
      </label>
    ) : null}
    {uiState.outputChecksumWarning.visible ? (
      <div id="rom-weaver-row-output-checksum-warning">
        <Notice level="warn">{uiState.outputChecksumWarning.message}</Notice>
        <label className="checkrow warn">
          <input
            checked={uiState.outputChecksumWarning.checked}
            disabled={uiState.outputChecksumWarning.disabled}
            id="rom-weaver-checkbox-output-checksum-override"
            onChange={(event) => uiController.setOutputChecksumOverride?.(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{uiState.outputChecksumWarning.label}</span>
        </label>
      </div>
    ) : null}
    <div className={disabledPatchCount ? "reveal is-open" : "reveal"} hidden={!disabledPatchCount}>
      <p aria-live="polite" className="patch-off-note">
        <TriangleAlert aria-hidden="true" />
        <span>{disabledPatchCount ? localizer.messageCount("ui.patch.offCount", disabledPatchCount) : ""}</span>
      </p>
    </div>
    <PatcherPrimaryAction
      controller={controllers.output}
      disableRun={(patches.length > 0 && enabledPatchCount === 0) || !!bundleVerificationError}
      totalTime={applyTotalTime || undefined}
    />
    {bundleVerificationError ? <Notice level="error">{bundleVerificationError}</Notice> : null}
    {bundleTools?.outputVerification ? (
      <p aria-live="polite" className="patch-off-note" id="rom-weaver-bundle-output-unverified">
        <TriangleAlert aria-hidden="true" />
        <span>{bundleTools.outputVerification.message}</span>
      </p>
    ) : null}
    {bundleExport && bundleTools?.exportVisible ? (
      bundleExport.busy ? (
        <ProgressActionButton
          cancelLabel="Cancel bundle export"
          disabled
          label={bundleActionLabel}
          onCancel={bundleExport.cancelExport}
          onClick={() => undefined}
          progress={bundleExport.progress}
          progressId="rom-weaver-bundle-export-progress"
        />
      ) : (
        <button
          className="btn ghost slim bundle-dl"
          disabled={outputState.disabled || !bundleExport.ready || !romInputs.length || !patches.length}
          id="rom-weaver-button-export-bundle"
          onClick={() => void bundleExport.runExport()}
          type="button"
        >
          {bundleExport.downloadable ? <Download aria-hidden="true" /> : <Package aria-hidden="true" />}
          {bundleActionLabel}
        </button>
      )
    ) : null}
    {bundleExport?.error ? <Notice level="error">{bundleExport.error}</Notice> : null}
  </>
);

const buildRomActualsById = (romInputs: RomInputRowState[]) => {
  const actualsById = new Map<string, RomCheckActuals>();
  for (const row of romInputs) {
    const actuals = {
      bytes: typeof row.size === "number" ? row.size : row.sourceSize,
      crc32: row.info.crc32 || undefined,
      md5: row.info.md5 || undefined,
      sha1: row.info.sha1 || undefined,
    };
    actualsById.set(row.id, actuals);
    if (row.kind === "track" && row.info.fileName && !actualsById.has(row.info.fileName)) {
      actualsById.set(row.info.fileName, actuals);
    }
  }
  return actualsById;
};

const getBundleActionLabel = (
  bundleExport: BundleExportState | undefined,
  localizer: ReturnType<typeof useUiLocalizer>,
  downloadable: boolean,
) => {
  if (!downloadable) {
    if (!bundleExport) return "";
    const formatValue = bundleExport.format && bundleExport.format !== "bundle" ? bundleExport.format : "zip";
    const formatName = formatValue === "7z" ? "7z" : formatValue.toUpperCase();
    const createKey = bundleExport.bundleRom ? "ui.bundleExport.createRom" : "ui.bundleExport.create";
    return localizer.message(createKey, { format: formatName });
  }
  if (!bundleExport?.downloadable) return "";
  const formatValue = bundleExport.format && bundleExport.format !== "bundle" ? bundleExport.format : "zip";
  const formatName = formatValue === "7z" ? "7z" : formatValue.toUpperCase();
  const downloadKey = bundleExport.bundleRom ? "ui.bundleExport.downloadRom" : "ui.bundleExport.download";
  return localizer.message(downloadKey, { format: formatName });
};

const getBundleFormatValue = (
  bundleExport: BundleExportState | undefined,
  bundleTools: BundleToolsState | undefined,
) => {
  const format = bundleTools?.exportVisible ? bundleExport?.format : "";
  if (!format || format === "bundle") return "";
  return `${format}:${bundleExport?.bundleRom ? "rom" : "patches"}`;
};

const BundleOutputFields = ({
  bundleExport,
  bundleTools,
  outputHeaderField,
}: {
  bundleExport?: BundleExportState;
  bundleTools?: BundleToolsState;
  outputHeaderField: ReactNode;
}) => {
  const exportTypeInfo = {
    items: [
      "A rom-weaver bundle is a portable recipe for weaving a specific patch chain into a ROM; it is not a pre-patched ROM.",
      "The required rom-weaver-bundle.json index contains the schema version, optional ROM description/checks, ordered patch entries, and optional output defaults/checks. Patch entries carry their sources, selections, header rules, and expected ROM-state checks.",
      "The archive holds that index plus the patch files. The “+ ROM” variants also include the original ROM, while a patch-only bundle carries its ROM checks and asks the player to provide the matching file.",
      "The bundle supplies instructions and verification data; rom-weaver still performs the patching when the player weaves it.",
    ],
    summary:
      "Exports this session as a distributable rom-weaver bundle: a portable patch recipe defined by rom-weaver-bundle.json.",
    title: "Bundle",
  };
  const bundleFormatValue = getBundleFormatValue(bundleExport, bundleTools);
  if (!bundleExport) return outputHeaderField;
  return (
    <>
      {outputHeaderField}
      <OutputField
        className="export-type-field"
        label="Bundle"
        labelInfo={<FieldInfoToggle info={exportTypeInfo} label="Bundle" />}
      >
        <select
          className="select"
          disabled={bundleExport.busy}
          id="rom-weaver-bundle-export-format"
          onChange={(event) => bundleTools?.setBundlePackage(event.currentTarget.value)}
          value={bundleFormatValue}
        >
          <option value="">Hide bundle creation</option>
          <option value="zip:patches">Bundle + patches (.zip)</option>
          <option value="zip:rom">Bundle + ROM + patches (.zip)</option>
          <option value="7z:patches">Bundle + patches (.7z)</option>
          <option value="7z:rom">Bundle + ROM + patches (.7z)</option>
        </select>
      </OutputField>
    </>
  );
};

const renderApplyTimingMeta = (applyDone: boolean, applyTiming?: string, compressTiming?: string): ReactNode => {
  if (applyDone) {
    return (
      <>
        {applyTiming ? (
          <span className="rb mono done-chip">
            <span className="k">Weave</span>
            <span className="t">{applyTiming}</span>
          </span>
        ) : null}
        {compressTiming ? (
          <span className="rb mono done-chip" style={{ animationDelay: "0.19s" }}>
            <span className="k">Compress</span>
            <span className="t">{compressTiming}</span>
          </span>
        ) : null}
      </>
    );
  }
  if (!applyTiming) return undefined;
  return (
    <span className="rb mono">
      <span className="k">Weave</span>
      <span className="t">{applyTiming}</span>
    </span>
  );
};

function ApplyWorkflowFormView({
  controllers,
  bundleExpectedRomChecks,
  bundleExport,
  bundleMetaById,
  bundleRomExpectation,
  bundleTools,
  onBundleMetaChange,
  onUnifiedDrop,
  patchEnablement,
  pendingDrops = [],
  startup = { message: "", status: "ready" },
}: {
  controllers: {
    output: PatcherOutputController;
    patchStack: PatcherStackController;
    ui: PatcherUiController;
    notice?: NoticeController;
    dialog?: DialogController;
  };
  /** Bundle export controls live directly in the Output options drawer. */
  bundleExport?: BundleExportState;
  /** Bundle notices + the export reveal state. */
  bundleTools?: BundleToolsState;
  /** The bundle's expected base-ROM checks, folded into the staged ROM card. */
  bundleExpectedRomChecks?: ParsedBundleChecks;
  /** Per-patch bundle metadata (label/description chips), keyed by stable source id. */
  bundleMetaById?: ReadonlyMap<string, BundlePatchMeta>;
  /** Shown while the bundle session waits for the user to supply the expected ROM. */
  bundleRomExpectation?: BundleRomExpectation;
  onBundleMetaChange?: (id: string, updates: Partial<BundlePatchMeta>) => void;
  onTrace?: (message: string, details?: Record<string, unknown>) => void;
  onUnifiedDrop?: (files: File[]) => void;
  patchEnablement?: PatchEnablement;
  pendingDrops?: PendingDrop[];
  startup?: StartupState;
}) {
  const uiController = controllers.ui || inertUiController;
  const uiState = useSyncExternalStore(uiController.subscribe, uiController.getState, uiController.getState);
  const outputState = useSyncExternalStore(
    controllers.output.subscribe,
    controllers.output.getState,
    controllers.output.getState,
  );
  const patchState = useSyncExternalStore(
    controllers.patchStack.subscribe,
    controllers.patchStack.getState,
    controllers.patchStack.getState,
  );
  const noticeController = controllers.notice;
  const errorNotice = useSyncExternalStore(
    noticeController ? noticeController.subscribe : () => () => undefined,
    noticeController ? noticeController.getState : () => null,
    noticeController ? noticeController.getState : () => null,
  );

  const fileInputAccept = getFileInputAcceptAttributes();
  const dismissSectionNotice = (key: PatcherSectionNoticeKey) => () => uiController.dismissNotice?.(key);

  const romInputs: RomInputRowState[] = uiState.romInputs;
  const patches = patchState.items;
  // Per-index disabled flags for the loom On/Off switches.
  const patchIds = patchEnablement ? patchEnablement.getPatchIds() : [];
  const disabledPatchFlags = patches.map((_, index) => {
    const id = patchIds[index];
    return !!patchEnablement && id !== undefined && patchEnablement.disabledIds.has(id);
  });
  // Card metadata is resolved by stable id so reorders keep the right annotations.
  const bundleMeta = patches.map((_, index) => {
    const id = patchIds[index];
    return bundleMetaById && id !== undefined ? bundleMetaById.get(id) : undefined;
  });
  const bundleVerificationError = getBundleVerificationError(bundleMeta, patches);
  const disabledPatchCount = disabledPatchFlags.filter(Boolean).length;
  const enabledPatchCount = patches.length - disabledPatchCount;
  const localizer = useUiLocalizer();
  // Inputs/patches still resolving - surfaced only on the selvage status strip.
  const inputsStaging =
    romInputs.some((row) => !!row.progress) || patches.some((item) => !!item.progress) || uiState.patchInput.loading;
  // The selvage status strip mirrors the apply job's lifecycle.
  const applyProgress = outputState.applyButton.progress;
  const applyStage = applyProgress ? String(applyProgress.label || applyProgress.message || "") : "";
  const applyFailed = !!errorNotice?.visible && errorNotice.level !== "warning";
  const applyDone = !!outputState.pendingDownloadFileName;
  const applyTotalTime = outputState.totalTiming;
  const stagingStage = localizer.message("ui.drop.staging");
  const doneStage = applyTotalTime ? localizer.message("ui.status.doneMsg", { t: applyTotalTime }) : "";
  useEffect(() => {
    if (applyProgress) setWorkbenchActivity(APPLY_ACTIVITY_KEY, { stage: applyStage, state: "running" });
    else if (applyFailed) setWorkbenchActivity(APPLY_ACTIVITY_KEY, { state: "failed" });
    else if (applyDone) setWorkbenchActivity(APPLY_ACTIVITY_KEY, { stage: doneStage, state: "done" });
    else if (inputsStaging) setWorkbenchActivity(APPLY_ACTIVITY_KEY, { stage: stagingStage, state: "staging" });
    else setWorkbenchActivity(APPLY_ACTIVITY_KEY, { state: "idle" });
  }, [applyProgress, applyStage, applyFailed, applyDone, doneStage, inputsStaging, stagingStage]);
  const running = !!applyProgress;
  const wovenSteps = running || applyDone;

  const romVerificationStates = buildRomVerificationStates(patches, romInputs, disabledPatchFlags);
  // Each ROM's computed identity, keyed by id, for patch-card check verification.
  // Disc-track rows are targeted by FILE NAME (their row id is not what the
  // target select resolves), so those alias their actuals under the file name too.
  const romActualsById = buildRomActualsById(romInputs);
  // The expected-ROM group describes THE base ROM, so it only renders for an
  // unambiguous single-ROM bench. Plan base-basis verdicts feed it; without plan
  // evidence the bundle expectation, then the chain-input patch's checks, stand in.
  const singleRom = romInputs.length === 1;
  const planBaseExpectation = singleRom
    ? buildPlanBaseExpectation(patches, disabledPatchFlags, bundleMeta, bundleExpectedRomChecks, romInputs[0]?.info)
    : null;
  const expectedRomChecks =
    planBaseExpectation?.expected ?? bundleExpectedRomChecks ?? parseChainInputExpectation(patches, disabledPatchFlags);
  const baseConflict = !!planBaseExpectation?.conflict;
  const romRowDeps: RomRowDeps = {
    romInputs,
    ui: uiController,
    verificationStates: romVerificationStates,
    ...(singleRom && expectedRomChecks ? { expectedChecks: expectedRomChecks } : {}),
  };
  const compressHeaderFormat = getOutputCompressionFormatLabel(outputState.compressionFormat, outputState.options);
  const compressionTypeOptions = createCompressionTypeOptions(outputState.options, "none");
  // The "ROM header" select only exists when the staged ROM has a strippable
  // copier header (the checksum variants carry the detection). Auto follows the
  // engine's rule: re-add emulator-required headers, drop junk copier headers.
  const outputHeaderVariant = romInputs
    .flatMap((row) => row.info.checksumVariants || [])
    .find(
      (variant) =>
        variant.applyCompatibility?.removeHeader === true || variant.applyCompatibility?.strip_header === true,
    );
  const outputHeaderTransform = outputHeaderVariant?.transforms?.removeHeader as
    | { headeredExtension?: string; headerlessExtension?: string; retainOnOutput?: boolean }
    | undefined;
  const outputHeaderRetained = outputHeaderTransform?.retainOnOutput !== false;
  const headeredExtension = outputHeaderTransform?.headeredExtension;
  const headerlessExtension = outputHeaderTransform?.headerlessExtension;
  const outputHeaderField = (
    <OutputHeaderField
      disabled={outputState.disabled}
      headeredExtension={headeredExtension}
      headerlessExtension={headerlessExtension}
      onChange={(value) => controllers.output.setOutputHeader?.(value)}
      retained={outputHeaderRetained}
      value={outputState.outputHeader}
      visible={!!outputHeaderVariant}
    />
  );
  // "Create <format> [ROM] Bundle" until an export exists, then "Download ...".
  const bundleCreateLabel = getBundleActionLabel(bundleExport, localizer, false);
  const bundleActionLabel = bundleExport?.downloadable
    ? getBundleActionLabel(bundleExport, localizer, true)
    : bundleCreateLabel;
  // The bundle package select mirrors the persisted "Bundle" user setting - ""
  // is the hide sentinel (matches the stored value), a format arms the action.
  const bundleFormatValue = getBundleFormatValue(bundleExport, bundleTools);
  const bundleOutputFields = (
    <BundleOutputFields bundleExport={bundleExport} bundleTools={bundleTools} outputHeaderField={outputHeaderField} />
  );

  // Unified drop: bare files stage immediately; each archive shows an
  // "identifying" placeholder until its ROM-vs-patch bucket is classified.
  const handleUnifiedDrop = onUnifiedDrop ?? (() => undefined);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState("");
  const loadFirstWeave = async () => {
    setSampleLoading(true);
    setSampleError("");
    try {
      const response = await fetch(FIRST_WEAVE_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      handleUnifiedDrop([new File([blob], "first-weave.zip", { type: "application/zip" })]);
    } catch {
      setSampleError("Could not load the sample. Try again.");
    } finally {
      setSampleLoading(false);
    }
  };
  // Start the hero morph at the gesture, not after a large input finishes enough
  // staging to publish its first row. This is presentation-only; Rust ingestion
  // continues on its existing schedule behind the transition.
  const [dropStarted, setDropStarted] = useState(false);
  const workflowHasContent = romInputs.length > 0 || patches.length > 0 || pendingDrops.length > 0 || inputsStaging;
  const formReady = pendingDrops.length === 0 && (romInputs.length > 0 || patches.length > 0 || inputsStaging);
  useEffect(() => {
    if (dropStarted && workflowHasContent) setDropStarted(false);
  }, [dropStarted, workflowHasContent]);
  // The empty bench fills (or clears) inside a flat crossfade - the 0x01 hero
  // shrinking into the add-row otherwise snaps. A drop-start signal makes that
  // crossfade begin before input staging publishes its first row.
  const workflowActuallyEmpty = !(workflowHasContent || dropStarted);
  const workflowEmpty = useFlatTransitionFlag(workflowActuallyEmpty);
  usePendingCardMorph(pendingDrops.length, romInputs.length + patches.length);
  // "Needs input" directives forward to the 0x01 unified picker.
  const openUnifiedPicker = () => document.getElementById("rom-weaver-input-file-unified")?.click();
  // Each section keeps its empty fixture whenever its own list is empty - not
  // just when the whole workflow is - so loading only a ROM (or only patches)
  // still shows the other section's "add it in 0x01" prompt instead of a bare
  // header.
  const romNeedsInput = (
    <NeedsInput onClick={openUnifiedPicker}>
      Add ROM in <b className="hexref mono">0x01</b> or click for any input
    </NeedsInput>
  );
  const patchesNeedsInput = (
    <NeedsInput onClick={openUnifiedPicker}>
      Add patches in <b className="hexref mono">0x01</b> or click for any input
    </NeedsInput>
  );
  const renderOutputAction = (
    <ApplyOutputAction
      applyTotalTime={applyTotalTime}
      bundleActionLabel={bundleActionLabel}
      bundleExport={bundleExport}
      bundleTools={bundleTools}
      bundleVerificationError={bundleVerificationError}
      controllers={{ output: controllers.output }}
      disabledPatchCount={disabledPatchCount}
      enabledPatchCount={enabledPatchCount}
      errorNotice={errorNotice}
      localizer={localizer}
      noticeController={noticeController}
      outputState={outputState}
      patches={patches}
      romInputs={romInputs}
      uiController={uiController}
      uiState={uiState}
    />
  );

  if (startup.status === "error") {
    return (
      <section className="panel" id="rom-weaver-container">
        <div className="step-body">
          <Notice level="error">{startup.message || "RomWeaver failed to load."}</Notice>
        </div>
      </section>
    );
  }

  return (
    <section className={formReady ? "panel form-ready" : "panel"} id="rom-weaver-container">
      <UnifiedDropZone
        accept={fileInputAccept.unifiedApply}
        addLabel="Replace the ROM or add patches"
        afterDropZone={
          <ApplyDropAfter
            onLoadSample={() => void loadFirstWeave()}
            pendingDrops={pendingDrops}
            sampleError={sampleError}
            sampleLoading={sampleLoading}
            workflowEmpty={workflowEmpty}
          />
        }
        big={workflowEmpty}
        heroLabel="Drop or click to add ROMs, patches, bundles, or archives"
        heroLabelCoarse="Tap to add ROMs, patches, bundles, or archives"
        id="rom-weaver-row-unified-drop"
        info={
          <ul className="info-list">
            <li>Nested archives are decompressed; ROMs and patches are located automatically.</li>
            <li>chd, rvz, and z3ds will be decompressed to raw formats before patching.</li>
            <li>
              A rom-weaver bundle is a portable patch recipe: a rom-weaver-bundle.json index, archived with its patches
              and optionally a ROM.
            </li>
            <li>RetroArch softpatch naming is supported.</li>
          </ul>
        }
        inputId="rom-weaver-input-file-unified"
        onDropStart={() => setDropStarted(true)}
        onFiles={handleUnifiedDrop}
        supported={APPLY_SUPPORTED_FILES}
      />
      {workflowEmpty ? (
        <GhostSteps
          steps={[
            { num: "0x02", title: localizer.message("ui.step.rom") },
            { num: "0x03", title: localizer.message("ui.step.patches") },
            { num: "0x04", title: localizer.message("ui.step.apply") },
          ]}
        />
      ) : (
        <>
          <WorkflowRomInputStep
            emptyState={romNeedsInput}
            fault={applyFailed}
            id="rom-weaver-row-file-rom"
            info={
              <InfoPopover title="Input handling">
                <strong>Input handling</strong>
                <ul>
                  <li>Archives are decompressed; we find the ROM or let you choose.</li>
                  <li>chd, rvz/wia/gcz, and z3ds files are decompressed before patching.</li>
                  <li>Nested archives (7z in rar, chd in 7z, …) are handled recursively.</li>
                  <li>
                    A rom-weaver bundle is a portable recipe for weaving a specific patch chain into a ROM. Its{" "}
                    <code>rom-weaver-bundle.json</code> file is the required index. The JSON contains the schema
                    version, optional ROM description/checks, ordered patch entries, and optional output
                    defaults/checks.
                  </li>
                  <li>
                    Patch entries can be required or optional, carry names/descriptions and default selections, point to
                    URLs or bundle-relative files, and record header rules and expected ROM-state checks.
                  </li>
                  <li>
                    A bundle can be a standalone JSON file or an archive containing that file and its patch files. It
                    may include the ROM too; otherwise, provide the matching ROM separately.
                  </li>
                  <li>
                    <a href="https://docs.libretro.com/guides/softpatching/" rel="noreferrer" target="_blank">
                      RetroArch softpatch format
                    </a>{" "}
                    is supported.
                  </li>
                </ul>
              </InfoPopover>
            }
            items={groupRomInputs(romInputs).map((group) =>
              group.kind === "disc"
                ? renderDiscGroup(group.rows, romRowDeps)
                : renderRomInputRow(group.row, group.index, romRowDeps),
            )}
            listId="rom-weaver-list-input-stack"
            notice={
              <>
                {bundleRomExpectation && romInputs.length === 0 ? (
                  <BundleRomExpectationCard expectation={bundleRomExpectation} />
                ) : null}
                {baseConflict ? (
                  <Notice id="rom-weaver-rom-expected-conflict" level="warn">
                    {localizer.message("ui.rom.baseConflict")}
                  </Notice>
                ) : null}
                <SectionNotice
                  id="rom-weaver-input-notice-message"
                  onDismiss={dismissSectionNotice("inputNotice")}
                  state={uiState.inputNotice}
                />
                <SectionNotice
                  id="rom-weaver-checksum-notice-message"
                  onDismiss={dismissSectionNotice("checksumNotice")}
                  state={uiState.checksumNotice}
                />
              </>
            }
            num="0x02"
            title="ROM"
            woven={wovenSteps}
          />

          <ApplyPatchListStep
            bundleMeta={bundleMeta}
            bundleOutputCheckHint={!!bundleTools?.hasOptionalEntries}
            disabledFlags={disabledPatchFlags}
            emptyState={patchesNeedsInput}
            fault={applyFailed}
            internalDescription={uiState.patchDetails.description}
            onBundleMetaChange={(index, updates) => {
              const id = patchIds[index];
              if (id) onBundleMetaChange?.(id, updates);
            }}
            onTogglePatch={patchEnablement?.onToggle}
            overrideAvailable={uiState.checksumOverride.visible}
            patches={patches}
            patchInput={uiState.patchInput}
            patchNotice={uiState.patchNotice}
            patchStack={controllers.patchStack}
            romActualsById={romActualsById}
            ui={uiController}
            woven={wovenSteps}
          />

          {uiState.patchDetails.requirementsValue ? (
            <div className="descblk mono" id="rom-weaver-row-patch-requirements">
              <div className="k">{uiState.patchDetails.requirementsLabel}</div>
              <div className="v" id="rom-weaver-patch-requirements-value">
                {uiState.patchDetails.requirementsValue}
              </div>
            </div>
          ) : null}
          <WorkflowOutputStep
            action={renderOutputAction}
            compress={buildOutputCompressionPanel({
              disabled: outputState.disabled,
              extraChildren: bundleOutputFields,
              fields: outputState.compress?.fields,
              format: compressHeaderFormat,
              formatId: "rom-weaver-select-output-format-compress",
              formatLabel: "Compression type",
              formatOptions: compressionTypeOptions,
              formatValue: outputState.compressionFormat,
              onFieldChange: (key, value, updates) => controllers.output.setOutputCompressOption?.(key, value, updates),
              onFormatChange: (value) => controllers.output.setOutputCompression(value),
              readouts: bundleExport ? (
                <DrawerReadout muted={!bundleFormatValue}>bundle:{bundleFormatValue || "hide"}</DrawerReadout>
              ) : null,
              summary: outputState.compress?.summary,
              timing: outputState.compressTiming || undefined,
            })}
            disabled={outputState.disabled}
            fault={applyFailed}
            fileName={outputState.displayFileName}
            fileNameId="rom-weaver-input-output-file-name"
            fileNamePlaceholder="Output filename (no extension)"
            format={outputState.compressionFormat}
            formatId="rom-weaver-select-output-format"
            formatOptions={outputState.options}
            id="rom-weaver-row-output-file-name"
            info={
              <InfoPopover title="Output options">
                <strong>Output</strong>
                <ul>
                  <li>Set the filename without an extension - the format selector controls it.</li>
                  <li>Container formats (zip, 7z, chd, rvz) are produced directly.</li>
                  <li>Compression defaults come from Settings › Compression and apply to compressed output.</li>
                </ul>
              </InfoPopover>
            }
            meta={renderApplyTimingMeta(applyDone, outputState.applyTiming, outputState.compressTiming)}
            notice={
              <SectionNotice
                id="rom-weaver-output-notice-message"
                onDismiss={dismissSectionNotice("outputNotice")}
                state={uiState.outputNotice}
              />
            }
            num="0x04"
            onFileNameChange={(value) => controllers.output.setDisplayFileName(value)}
            onFormatChange={(value) => controllers.output.setOutputCompression(value)}
            title="Weave"
            woven={applyDone || running}
          />
        </>
      )}

      <SharedArchiveDialog controller={controllers.dialog} />
    </section>
  );
}

export { ApplyWorkflowFormView };
