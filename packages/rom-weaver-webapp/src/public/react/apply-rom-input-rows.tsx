import { createTiming, formatTiming } from "../../storage/shared/timing.ts";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import { StageStatus, stageBarValue, stagePercent, stageStatusLabel } from "./components/ds/staging-meta.tsx";
import { IDENTIFY_STATUS_LABEL } from "../../presentation/identify-status.ts";
import { identifyRecordChecks } from "../../lib/identify/identify-record-checks.ts";
import { abbreviatePlatform } from "../../presentation/platform-abbreviations.ts";
import { type WorkflowRomInputStepItem } from "./components/ds/workflow-rom-input-step.tsx";
import type { PatcherUiController } from "./patcher-form.ts";
import type { RomInputRowState } from "./patcher-ui-state.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import { toWorkflowChecksumProgressProps, toWorkflowFileProgressProps } from "./workflow-run-hooks.ts";
import {
  type RomIdentificationState,
  resolveRomIdentification,
  buildPatchIdentificationLookup,
} from "./apply-rom-expectations.ts";

const TIMING_LABEL = (ms?: number) =>
  typeof ms === "number" && Number.isFinite(ms) ? formatTiming(createTiming(ms)) : "";
const checksumTimingLabel = (timing: string | undefined, localizer: ReturnType<typeof useUiLocalizer>) =>
  timing ? localizer.message("ui.apply.checksumTiming", { timing }) : undefined;

/** Render a backend ROM type tag as "PLATFORM · DISC" (e.g. "PSX · CD"); empty when unknown. */
const formatRomTypeTag = (romType: { platform?: string; discFormat?: string } | undefined): string => {
  if (!romType) return "";
  const platform = romType.platform ? abbreviatePlatform(romType.platform) : "";
  return [platform, romType.discFormat].filter(Boolean).join(" · ");
};
/** Dependencies threaded into the ROM-row renderers. */
export type RomRowDeps = {
  identificationStates: ReadonlyMap<string, RomIdentificationState>;
  localizer: ReturnType<typeof useUiLocalizer>;
  romInputs: RomInputRowState[];
  verificationStates: Map<string, "bad" | "ok">;
  ui: PatcherUiController;
  /** The bundle's expected base-ROM checks - an "Expected" group with match
   * marks inside the staged ROM's Checks drawer (single-ROM sessions only). */
  expectedChecks?: ParsedBundleChecks;
  /** Advisory expected logical ROM basename from bundle `rom.name`. */
  expectedName?: string;
  /** Checksums the identify database adds for the same record; informational. */
  expectedDatabaseChecksums?: Record<string, string>;
};

/**
 * Multi-track CD/GD discs arrive as several rows (the cue/gdi sheet plus one
 * row per .bin track) sharing a `groupId`. Collapse each such group into one
 * "disc" entry; rows without a groupId (and lone groups) render individually.
 */
type RomInputGroup =
  | { kind: "single"; row: RomInputRowState; index: number }
  | { kind: "disc"; rows: Array<{ row: RomInputRowState; index: number }> };

export const groupRomInputs = (rows: RomInputRowState[]): RomInputGroup[] => {
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

/**
 * CLS: the resolved card stays mounted through staging - a slim top-edge bar and
 * meta status carry progress - so nothing below the card moves when the
 * checksums land. The bare-panel to full-card swap was the dominant shift.
 */
const resolveRomStaging = (romInput: RomInputRowState) => {
  const staging = !!romInput.progress;
  const stagingPhase = romInput.info.validationPhase === "checksum" ? "checksum" : "rom";
  if (!staging) return { percent: stagePercent(null), staging, stagingPhase };
  const stagingProps =
    stagingPhase === "checksum"
      ? toWorkflowChecksumProgressProps(romInput.progress)
      : toWorkflowFileProgressProps(romInput.progress);
  return { percent: stagePercent(stagingProps), staging, stagingPhase };
};

/** A disc track lists its sheet alongside the track itself; other ROMs list nothing. */
const buildDiscFileEntries = (romInput: RomInputRowState, romBytes: number | undefined, hasDiscSheet: boolean) => {
  if (!(hasDiscSheet && (romInput.cueText || romInput.gdiText))) return undefined;
  const entries: Array<{ decompressionTimeMs?: number; fileName: string; fileSize: number | undefined }> = [];
  if (romInput.cueText) {
    entries.push({
      decompressionTimeMs: romInput.decompressionTimeMs,
      fileName: romInput.info.fileName.replace(/\.[^.]+$/, ".cue"),
      fileSize: new TextEncoder().encode(romInput.cueText).byteLength,
    });
  }
  if (romInput.gdiText) {
    entries.push({
      fileName: romInput.info.fileName.replace(/\.[^.]+$/, ".gdi"),
      fileSize: new TextEncoder().encode(romInput.gdiText).byteLength,
    });
  }
  entries.push({ fileName: romInput.info.fileName, fileSize: romBytes });
  return entries;
};

/**
 * Reserve the engine's planned checksum groups before their values arrive.
 * Byte-count placeholders use the source length until each variant resolves.
 */
const buildPendingChecksumGroups = (
  romInput: RomInputRowState,
  romBytes: number | undefined,
  localizer: ReturnType<typeof useUiLocalizer>,
) => {
  const romByteCount = typeof romBytes === "number" && Number.isFinite(romBytes) ? Math.floor(romBytes) : undefined;
  const rows = [
    { label: "CRC32", length: 8 },
    {
      label: localizer.message("ui.apply.bytes"),
      length: romByteCount === undefined ? 8 : String(romByteCount).length,
    },
    { label: "MD5", length: 32 },
    { label: "SHA-1", length: 40 },
  ];
  const variantPlan = romInput.info.checksumVariantPlan;
  if (!variantPlan?.length) return [{ id: "raw", rows }];
  return variantPlan.map((variant) => ({
    id: variant.id,
    rows,
    ...(variant.id === "raw" ? {} : { label: variant.label }),
  }));
};

const buildExpectedChecks = (deps: RomRowDeps) => {
  if (!(deps.expectedChecks || deps.expectedName)) return undefined;
  return {
    ...deps.expectedChecks,
    ...(deps.expectedName ? { name: deps.expectedName } : {}),
    ...(deps.expectedDatabaseChecksums ? { databaseChecksums: deps.expectedDatabaseChecksums } : {}),
  };
};

const renderRomCardMeta = (input: {
  identificationStatus: RomInputRowState["info"]["identificationStatus"];
  localizer: ReturnType<typeof useUiLocalizer>;
  percent: number | null;
  stageLabel: string;
  staging: boolean;
  statusId: string;
}) => {
  if (input.staging) return <StageStatus id={input.statusId} label={input.stageLabel} percent={input.percent} />;
  /* The verdict border is never the only signal (WCAG 1.4.1), and a lookup
     database that never loaded is not a ROM verdict at all - it reads as a quiet
     note beside the file, never as a checksum or patching failure. */
  if (input.identificationStatus === "unavailable") {
    return <span className="rb mono muted">{input.localizer.message("ui.apply.titleLookupUnavailable")}</span>;
  }
  if (input.identificationStatus === "ambiguous") {
    return <span className="rb mono muted">{IDENTIFY_STATUS_LABEL.ambiguous}</span>;
  }
  return undefined;
};

const resolveRomCardState = (
  verificationState: "bad" | "ok" | undefined,
  identificationStatus: RomInputRowState["info"]["identificationStatus"],
): "bad" | "ok" | "warn" | undefined => {
  if (verificationState === "bad") return "bad";
  if (identificationStatus === "ambiguous") return "warn";
  if (verificationState === "ok" || identificationStatus === "matched") return "ok";
  return undefined;
};

export const renderRomInputRow = (
  romInput: RomInputRowState,
  index: number,
  deps: RomRowDeps,
): WorkflowRomInputStepItem => {
  const { localizer, verificationStates, ui } = deps;
  const identification = resolveRomIdentification(romInput, deps.identificationStates.get(romInput.id));
  const identificationLookup = romInput.info.identification || buildPatchIdentificationLookup(identification);
  const database = identifyRecordChecks(romInput.info.identification);
  const state = resolveRomCardState(verificationStates.get(romInput.id), identification?.status);
  const { percent, staging, stagingPhase } = resolveRomStaging(romInput);
  // A container ROM extracts and checksums in one pass (Rust hashes inline), so it
  // sits in the "extract" phase throughout - show both verbs. Phase comes from the
  // runtime stage, not the label text, so the verb survives stageless ticks.
  const stageLabel = stageStatusLabel(
    localizer.message("ui.apply.checksumming"),
    romInput.info.validationPhase === "extract",
    localizer,
  );
  const romBytes = romInput.size ?? romInput.sourceSize;
  const romTypeTag = formatRomTypeTag(romInput.info.romType);
  const hasDiscSheet = romInput.kind === "track";
  const fileEntries = buildDiscFileEntries(romInput, romBytes, hasDiscSheet);
  const pendingGroups = buildPendingChecksumGroups(romInput, romBytes, localizer);
  const expected = buildExpectedChecks(deps);
  return {
    card: {
      extract: {
        fileEntries,
        fileName: romInput.info.fileName,
        fileSize: romBytes,
        parentCompressions: romInput.archivePathEntries,
        timing: TIMING_LABEL(romInput.decompressionTimeMs),
      },
      displayName: !staging && identification?.status === "matched" ? identification.name : undefined,
      identified: !staging && identification?.status === "matched",
      meta: renderRomCardMeta({
        identificationStatus: romInput.info.identificationStatus,
        localizer,
        percent,
        stageLabel,
        staging,
        statusId: `rom-weaver-progress-${stagingPhase}-${index}`,
      }),
      onRemove: () => ui.clearRomInput?.(),
      panels: {
        ...(identificationLookup ? { identification: identificationLookup } : {}),
        identifyPending: staging,
        ...(romTypeTag ? { platformTag: romTypeTag } : {}),
        info: {
          bytes: romBytes,
          checksums: staging
            ? undefined
            : { crc32: romInput.info.crc32, md5: romInput.info.md5, sha1: romInput.info.sha1 },
          checksumVariants: staging ? undefined : romInput.info.checksumVariants,
          ...(database ? { database } : {}),
          // Also while staging: the bundle already declares these, so they reserve their own group
          // (and read) before the hashes land instead of appearing with them.
          ...(expected ? { expected } : {}),
          onToggle: () => ui.toggleRomInputChecksums?.(romInput.id),
          open: staging ? true : romInput.info.checksumsExpanded,
          pending: staging ? pendingGroups : undefined,
          timing: staging ? undefined : checksumTimingLabel(romInput.info.checksumTiming, localizer),
          trim: staging ? undefined : romInput.info.romProbe?.trim,
        },
        ...(hasDiscSheet && romInput.cueText ? { cue: { cueText: romInput.cueText } } : {}),
      },
      removeLabel: localizer.message("ui.apply.clearRom"),
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
  localizer: ReturnType<typeof useUiLocalizer>,
): string => {
  const archiveFileName = groupRows.find((row) => row.archivePathEntries?.length)?.archivePathEntries?.[0]?.fileName;
  return (
    (archiveFileName && discDisplayName(archiveFileName)) ||
    (cueRow?.info.fileName && discDisplayName(cueRow.info.fileName)) ||
    (firstTrackName ? discDisplayName(firstTrackName) : localizer.message("ui.apply.disc"))
  );
};

/**
 * Bytes one track contributes to the disc's overall bar: all of them once it has
 * hashed, none while it waits its turn, and a share of them mid-run. Null means
 * the track cannot be scored, which makes the whole bar indeterminate.
 */
const trackCompletedBytes = (
  row: RomInputRowState,
  progress: ReturnType<typeof toWorkflowChecksumProgressProps> | undefined,
): number | null => {
  const bytes = row.size ?? row.sourceSize;
  if (!(typeof bytes === "number" && Number.isFinite(bytes))) return null;
  if (!row.progress && (row.info.crc32 || row.info.md5 || row.info.sha1)) return bytes;
  if (row.progress?.value === "waiting") return 0;
  if (typeof progress?.percent === "number") return bytes * (progress.percent / 100);
  return null;
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
    const done = trackCompletedBytes(row, tracks[index]?.progress);
    if (done === null) return null;
    completedBytes += done;
  }
  return (completedBytes / totalBytes) * 100;
};

/** A sheet that arrived as text rather than its own row still lists as a file. */
const buildDiscSheetEntries = (input: {
  cueRow: RomInputRowState | undefined;
  cueText: string | undefined;
  discName: string;
  firstTrackName: string | undefined;
  gdiRow: RomInputRowState | undefined;
  gdiText: string | undefined;
  trackDecompressionTimeMs: number | undefined;
}) => {
  const { cueText, discName, firstTrackName, gdiText } = input;
  const entries: Array<{ fileName: string; fileSize?: number; decompressionTimeMs?: number }> = [];
  if (cueText && !input.cueRow) {
    entries.push({
      decompressionTimeMs: input.trackDecompressionTimeMs,
      fileName: firstTrackName?.replace(/\.[^.]+$/, ".cue") || `${discName}.cue`,
      fileSize: new TextEncoder().encode(cueText).byteLength,
    });
  }
  if (gdiText && !input.gdiRow) {
    entries.push({
      fileName: firstTrackName?.replace(/\.[^.]+$/, ".gdi") || `${discName}.gdi`,
      fileSize: new TextEncoder().encode(gdiText).byteLength,
    });
  }
  return entries;
};

/** Any verified-bad track marks the disc bad; otherwise ok once any track verifies. */
const resolveDiscVerdict = (
  groupRows: RomInputRowState[],
  verificationStates: RomRowDeps["verificationStates"],
): "bad" | "ok" | undefined => {
  let state: "bad" | "ok" | undefined;
  for (const row of groupRows) {
    const verdict = verificationStates.get(row.id);
    if (verdict === "bad") return "bad";
    if (verdict === "ok") state = "ok";
  }
  return state;
};

/** Render a multi-track disc as one card with per-track checksums + cue view. */
export const renderDiscGroup = (
  rows: Array<{ row: RomInputRowState; index: number }>,
  deps: RomRowDeps,
): WorkflowRomInputStepItem => {
  const { localizer, romInputs, verificationStates, ui } = deps;
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
  const discName = discGroupDisplayName(groupRows, cueRow, firstTrackName, localizer);
  const sheetEntries = buildDiscSheetEntries({
    cueRow,
    cueText,
    discName,
    firstTrackName,
    gdiRow,
    gdiText,
    trackDecompressionTimeMs: trackRows[0]?.decompressionTimeMs,
  });
  const fileEntries = [
    ...sheetEntries,
    ...groupRows.map((row) => ({
      decompressionTimeMs: row.decompressionTimeMs,
      fileName: row.info.fileName,
      fileSize: row.size ?? row.sourceSize,
    })),
  ];
  const totalFileBytes = fileEntries.reduce((sum, entry) => sum + (entry.fileSize ?? 0), 0);
  const state = resolveDiscVerdict(groupRows, verificationStates);
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
  // Any row of the group carries the disc-group identification the ingest
  // resolved (tracks and sheet share it), so the disc card gets one drawer.
  const discIdentification = groupRows.find((row) => row.info.identification)?.info.identification;
  return {
    card: {
      extract: {
        fileName: discName,
        fileEntries,
        fileSize: totalFileBytes || totalBytes || undefined,
        parentCompressions: groupRows.find((row) => row.archivePathEntries?.length)?.archivePathEntries,
      },
      meta: renderRomCardMeta({
        identificationStatus: undefined,
        localizer,
        percent: overallPercent,
        stageLabel: localizer.message("ui.apply.checksummingProgress"),
        staging,
        statusId: `rom-weaver-progress-disc-${groupId}`,
      }),
      onRemove: removeDisc,
      panels: {
        ...(discIdentification ? { identification: discIdentification } : {}),
        identifyPending: staging,
        ...(discRomTypeTag ? { platformTag: discRomTypeTag } : {}),
        info: { timing: checksumTimingLabel(trackRows[0]?.info.checksumTiming, localizer) },
        tracks,
        ...(cueText ? { cue: { cueText } } : {}),
        ...(gdiText ? { gdi: { gdiText } } : {}),
      },
      removeLabel: localizer.message("ui.apply.removeDisc"),
      stageBar: stageBarValue(staging, overallPercent),
      state,
    },
    id: groupId,
  };
};
