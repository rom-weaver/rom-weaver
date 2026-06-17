import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import { useEffect, useSyncExternalStore } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { createTiming, formatTiming } from "../../storage/shared/timing.ts";
import { probeApplyArchiveHasRom } from "./apply-archive-probe.ts";
import { ApplyPatchListStep } from "./apply-patch-list-step.tsx";
import { buildOutputCompressionPanel, getOutputCompressionFormatLabel } from "./components/ds/compress-panel.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { useFlatTransitionFlag } from "./components/ds/flat-transition.ts";
import { InfoPopover, NeedsInput, StepSection } from "./components/ds/layout.tsx";
import { UnifiedDropZone } from "./components/ds/unified-drop-zone.tsx";
import { WorkflowOutputStep } from "./components/ds/workflow-output-step.tsx";
import { WorkflowRomInputStep, type WorkflowRomInputStepItem } from "./components/ds/workflow-rom-input-step.tsx";
import { PatcherPrimaryAction } from "./components/patcher-output-controls.tsx";
import { ARCHIVE_FILE_EXTENSIONS, PATCH_FILE_EXTENSIONS, ROM_FILE_EXTENSIONS } from "./file-classification.ts";
import { getFileInputAcceptAttributes } from "./file-input-accept";
import { ARCHIVE_INPUT_HINT, PATCH_INPUT_HINT, ROM_INPUT_HINT } from "./input-helper-text.ts";
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
import type { PatchStackItemState } from "./patcher-presentation.ts";
import { ArchiveDialog as SharedArchiveDialog } from "./patcher-react-shared.tsx";
import type { NoticeState, PatcherSectionNoticeKey, RomInputRowState } from "./patcher-ui-state.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import { routeByTypeProbed } from "./unified-drop-routing.ts";
import { toWorkflowChecksumProgressProps, toWorkflowFileProgressProps } from "./workflow-run-hooks.ts";

/**
 * Apply-workflow view, rebuilt on the dark-pro design-system primitives. It is
 * purely presentational: it reads the same ui/patchStack/output/notice/dialog
 * controllers that ApplyPatchForm wires up and renders the step layout.
 */

/** Format pills under the 0x01 hero — mirrors the loom prototype's apply list. */
const APPLY_HERO_FORMATS = ["ips", "bps", "ups", "xdelta", "ppf", "cue", "zip", "7z", "chd", "rvz"] as const;

/** Full registry support, listed in the 0x01 info popover. */
const APPLY_SUPPORTED_FILES = [
  { extensions: ROM_FILE_EXTENSIONS, label: "ROMs" },
  { extensions: PATCH_FILE_EXTENSIONS, label: "Patches" },
  { extensions: ARCHIVE_FILE_EXTENSIONS, label: "Archives & containers" },
] as const;

const TIMING_LABEL = (ms?: number) =>
  typeof ms === "number" && Number.isFinite(ms) ? formatTiming(createTiming(ms)) : "";
const CHECKSUM_TIMING_LABEL = (timing?: string, prefix = "Checksum") => (timing ? `${prefix} ${timing}` : undefined);

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

const getHeaderFixLabel = (checked: boolean) => (checked ? "Will fix internal checksum" : "No change");

const ROM_CHECKSUM_HEX_LENGTHS: Record<number, "crc32" | "md5" | "sha1"> = { 8: "crc32", 32: "md5", 40: "sha1" };

/**
 * Compare a user-pasted input checksum against a ROM's computed checksums,
 * mirroring the apply-time hex auto-detection (crc32/md5/sha1 by length).
 * Returns "ok" on match, "bad" on mismatch, or undefined when there is nothing
 * to compare yet (no/invalid pasted value, unsupported length, or the matching
 * ROM checksum has not been computed).
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
 * Derive each ROM's verification color from the patches targeting it. A ROM is
 * only highlighted once a patch has actually verified it: green when the ROM
 * matches a required source checksum (the patch's embedded preflight) or a
 * user-pasted input checksum, red on mismatch, and no color when there is
 * nothing to verify against. A mismatch from any signal wins over a match.
 */
const buildRomVerificationStates = (patches: PatchStackItemState[], romInputs: RomInputRowState[]) => {
  const infoById = new Map(romInputs.map((rom) => [rom.id, rom.info]));
  const states = new Map<string, "bad" | "ok">();
  const apply = (romId: string, verdict: "bad" | "ok" | undefined) => {
    if (!verdict) return;
    if (verdict === "bad" || !states.has(romId)) states.set(romId, verdict);
  };
  for (const patch of patches) {
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
  alterHeaderChecked: boolean;
  verificationStates: Map<string, "bad" | "ok">;
  ui: PatcherUiController;
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
  // A "disc" of a single row is not a disc — render it as a normal row.
  return groups.map((group) => {
    if (group.kind === "disc" && group.rows.length === 1) {
      const only = group.rows[0];
      if (only) return { index: only.index, kind: "single", row: only.row };
    }
    return group;
  });
};

/** Render a single (non-disc) ROM input row. */
const renderRomInputRow = (romInput: RomInputRowState, index: number, deps: RomRowDeps): WorkflowRomInputStepItem => {
  const { romInputs, alterHeaderChecked, verificationStates, ui } = deps;
  const state = verificationStates.get(romInput.id);
  const rowProgress = romInput.progress && romInput.info.validationPhase !== "checksum" ? romInput.progress : null;
  if (rowProgress) {
    return {
      id: romInput.id,
      progress: {
        cancelLabel: romInputs.length > 1 ? "Cancel ROM input staging" : "Cancel ROM staging",
        id: `rom-weaver-progress-rom-${index}`,
        onCancel: () => {
          if (romInputs.length === 1 && ui.clearRomInput) ui.clearRomInput();
          else ui.removeRomInput?.(romInput.id);
        },
        ...toWorkflowFileProgressProps(rowProgress)!,
      },
    };
  }
  const checksumProgress = romInput.progress && romInput.info.validationPhase === "checksum" ? romInput.progress : null;
  const romBytes = romInput.size ?? romInput.sourceSize;
  return {
    card: {
      extract: {
        fileName: romInput.info.fileName,
        fileSize: romBytes,
        legacyFileClassName: "rom-weaver-input-stack-file",
        parentCompressions: romInput.archivePathEntries,
        timing: TIMING_LABEL(romInput.decompressionTimeMs),
      },
      meta: typeof romBytes === "number" ? <span className="fsize mono">{formatByteSize(romBytes)}</span> : undefined,
      onRemove: () => {
        if (romInputs.length === 1 && ui.clearRomInput) ui.clearRomInput();
        else ui.removeRomInput?.(romInput.id);
      },
      panels: {
        fixes: {
          headerSummary: alterHeaderChecked ? "header will be fixed" : "header unchanged",
          headerValue: getHeaderFixLabel(alterHeaderChecked),
          lead: romInput.info.romInfo ? <p className="pdesc">{romInput.info.romInfo}</p> : undefined,
          romInfoText: romInput.info.romInfo,
          trim: romInput.info.romProbe?.trim,
        },
        info: {
          bytes: romInput.size ?? romInput.sourceSize,
          checksums: { crc32: romInput.info.crc32, md5: romInput.info.md5, sha1: romInput.info.sha1 },
          checksumVariants: romInput.info.checksumVariants,
          lead:
            !checksumProgress && romInput.info.romInfo ? <p className="pdesc">{romInput.info.romInfo}</p> : undefined,
          onToggle: () => ui.toggleRomInputChecksums?.(romInput.id),
          open: romInput.info.checksumsExpanded,
          progress: toWorkflowChecksumProgressProps(checksumProgress),
          timing: CHECKSUM_TIMING_LABEL(romInput.info.checksumTiming),
        },
        ...(romInput.cueText ? { cue: { cueText: romInput.cueText } } : {}),
      },
      removeLabel: romInputs.length > 1 ? "Remove ROM input" : "Clear ROM input",
      state,
    },
    id: romInput.id,
  };
};

/**
 * Normalize a disc-related filename into a display name by dropping the extension
 * and a trailing "(Track N)" suffix — e.g. "Game (Track 1).bin" → "Game",
 * "Final Fantasy VII (Disc 1).7z" → "Final Fantasy VII (Disc 1)".
 */
const discDisplayName = (fileName: string): string => {
  const base = fileName.replace(/^.*[/\\]/, "");
  const withoutExt = base.replace(/\.[^.]+$/, "");
  return withoutExt.replace(/\s*\(track\s*\d+\)\s*$/i, "") || withoutExt || base;
};

/**
 * The disc's display name. The cue is not a row of its own (its text rides on the
 * track rows), so a track filename like "track01.bin" is a poor title. Prefer the
 * source archive's base name (what the user dropped, e.g. "disc-bincue.7z" →
 * "disc-bincue"), then a `.cue`/`.gdi` sheet row if one exists, and only fall back
 * to a track-derived name when nothing better is available.
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

/** Render a multi-track disc as one card with per-track checksums + cue view. */
const renderDiscGroup = (
  rows: Array<{ row: RomInputRowState; index: number }>,
  deps: RomRowDeps,
): WorkflowRomInputStepItem => {
  const { romInputs, verificationStates, ui } = deps;
  const groupRows = rows.map((entry) => entry.row);
  const cueRow = groupRows.find((row) => row.kind === "cue");
  const trackRows = groupRows.filter((row) => row.kind !== "cue" && row.kind !== "gdi");
  const groupId = groupRows[0]?.groupId || cueRow?.id || "disc";
  const cueText = groupRows.find((row) => Boolean(row.cueText))?.cueText;
  const gdiText = groupRows.find((row) => Boolean(row.gdiText))?.gdiText;
  const totalBytes = trackRows.reduce((sum, row) => sum + (row.size ?? row.sourceSize ?? 0), 0);
  const firstTrackName = trackRows[0]?.info.fileName;
  const discName = discGroupDisplayName(groupRows, cueRow, firstTrackName);
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
      timing: CHECKSUM_TIMING_LABEL(row.info.checksumTiming),
    };
  });
  return {
    card: {
      extract: {
        fileName: discName,
        fileSize: totalBytes || undefined,
        legacyFileClassName: "rom-weaver-input-stack-file",
      },
      meta: totalBytes ? <span className="fsize mono">{formatByteSize(totalBytes)}</span> : undefined,
      onRemove: removeDisc,
      panels: {
        tracks,
        ...(cueText ? { cue: { cueText } } : {}),
        ...(gdiText ? { gdi: { gdiText } } : {}),
      },
      removeLabel: "Remove disc",
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

function ApplyWorkflowFormView({
  controllers,
  patchEnablement,
  startup = { message: "", status: "ready" },
}: {
  controllers: {
    output: PatcherOutputController;
    patchStack: PatcherStackController;
    ui: PatcherUiController;
    notice?: NoticeController;
    dialog?: DialogController;
  };
  onTrace?: (message: string, details?: Record<string, unknown>) => void;
  patchEnablement?: PatchEnablement;
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
  const disabledPatchCount = disabledPatchFlags.filter(Boolean).length;
  const enabledPatchCount = patches.length - disabledPatchCount;
  const localizer = useUiLocalizer();
  // Inputs/patches still resolving — surfaced only on the selvage status strip.
  const inputsStaging =
    romInputs.some((row) => !!row.progress) || patches.some((item) => !!item.progress) || uiState.patchInput.loading;
  // The selvage status strip mirrors the apply job: staging while files route,
  // running with the active stage label, done once a download is pending,
  // failed on an error notice.
  const applyProgress = outputState.applyButton.progress;
  const applyStage = applyProgress ? String(applyProgress.label || applyProgress.message || "") : "";
  const applyFailed = !!errorNotice?.visible && errorNotice.level !== "warning";
  const applyDone = !!outputState.pendingDownloadFileName;
  const applyTotalTime = outputState.totalTiming;
  const stagingStage = localizer.message("ui.drop.staging");
  const doneStage = applyTotalTime ? localizer.message("ui.status.doneMsg", { t: applyTotalTime }) : "";
  useEffect(() => {
    if (applyProgress) setWorkbenchActivity({ stage: applyStage, state: "running" });
    else if (applyFailed) setWorkbenchActivity({ state: "failed" });
    else if (applyDone) setWorkbenchActivity({ stage: doneStage, state: "done" });
    else if (inputsStaging) setWorkbenchActivity({ stage: stagingStage, state: "staging" });
    else setWorkbenchActivity({ state: "idle" });
  }, [applyProgress, applyStage, applyFailed, applyDone, doneStage, inputsStaging, stagingStage]);
  const running = !!applyProgress;
  const wovenSteps = running || applyDone;

  const romVerificationStates = buildRomVerificationStates(patches, romInputs);
  const romRowDeps: RomRowDeps = {
    alterHeaderChecked: uiState.romInfo.alterHeaderChecked,
    romInputs,
    ui: uiController,
    verificationStates: romVerificationStates,
  };
  const compressHeaderFormat = getOutputCompressionFormatLabel(outputState.compressionFormat, outputState.options);
  const compressionTypeOptions = createCompressionTypeOptions(outputState.options, "none");

  // Combined drop surface (--rom-filter + --patch-filter): ROMs → the ROM
  // bucket, patches → the patch bucket, and each archive is probed for a ROM —
  // a ROM archive is an input (embedded patches are auto-discovered), one
  // without a ROM is a patch container (see routeByTypeProbed).
  const handleUnifiedDrop = (files: File[]) => {
    void routeByTypeProbed(files, probeApplyArchiveHasRom).then(({ inputs, patches: patchFiles }) => {
      if (inputs.length) uiController.provideRomInputFiles?.(inputs);
      if (patchFiles.length) uiController.providePatchInputFiles?.(patchFiles);
    });
  };
  // The empty bench fills (or clears) inside a flat crossfade — the 0x01 hero
  // shrinking into the add-row otherwise snaps.
  const workflowEmpty = useFlatTransitionFlag(romInputs.length === 0 && patches.length === 0);
  // "Needs input" directives forward to the 0x01 unified picker.
  const openUnifiedPicker = () => document.getElementById("rom-weaver-input-file-unified")?.click();
  // Each section keeps its empty fixture whenever its own list is empty — not
  // just when the whole workflow is — so loading only a ROM (or only patches)
  // still shows the other section's "add it in 0x01" prompt instead of a bare
  // header.
  const romNeedsInput = (
    <NeedsInput onClick={openUnifiedPicker}>
      Add a ROM in <b className="hexref mono">0x01</b> above
    </NeedsInput>
  );
  const patchesNeedsInput = (
    <NeedsInput onClick={openUnifiedPicker}>
      Add patches in <b className="hexref mono">0x01</b> above
    </NeedsInput>
  );

  if (startup.status === "error") {
    return (
      <main className="panel" id="rom-weaver-container">
        <div className="step-body">
          <Notice level="error">{startup.message || "RomWeaver failed to load."}</Notice>
        </div>
      </main>
    );
  }

  return (
    <main aria-labelledby="tab-patcher" className="panel" id="rom-weaver-container">
      <UnifiedDropZone
        accept={fileInputAccept.unifiedApply}
        archiveHint={`archives (${ARCHIVE_INPUT_HINT})`}
        big={workflowEmpty}
        formats={APPLY_HERO_FORMATS}
        hintCoarse={localizer.message(workflowEmpty ? "ui.drop.tapAnywhere" : "ui.drop.tap")}
        id="rom-weaver-row-unified-drop"
        info={
          <ul className="info-list">
            <li>Archives are decompressed and the ROM is located automatically.</li>
            <li>chd, rvz, and z3ds containers are unpacked before patching.</li>
            <li>Nested archives resolve recursively.</li>
            <li>RetroArch softpatch naming is supported.</li>
          </ul>
        }
        inputId="rom-weaver-input-file-unified"
        label={workflowEmpty ? "Drop a ROM or patches" : "Replace the ROM or add patches"}
        onFiles={handleUnifiedDrop}
        patchHint={`patches (${PATCH_INPUT_HINT})`}
        romHint={`roms (${ROM_INPUT_HINT})`}
        supported={APPLY_SUPPORTED_FILES}
      />
      {workflowEmpty ? (
        <>
          <StepSection num="0x02" title="ROM">
            {romNeedsInput}
          </StepSection>
          <StepSection num="0x03" title="Patches">
            {patchesNeedsInput}
          </StepSection>
        </>
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
            disabledFlags={disabledPatchFlags}
            emptyState={patchesNeedsInput}
            fault={applyFailed}
            onTogglePatch={patchEnablement?.onToggle}
            patches={patches}
            patchInput={uiState.patchInput}
            patchNotice={uiState.patchNotice}
            patchStack={controllers.patchStack}
            ui={uiController}
            woven={wovenSteps}
          />

          {uiState.patchDetails.description ? (
            <div className="descblk" id="rom-weaver-row-patch-description">
              <div className="k">Description</div>
              <div className="v" id="rom-weaver-patch-description">
                {uiState.patchDetails.description}
              </div>
            </div>
          ) : null}
          {uiState.patchDetails.requirementsValue ? (
            <div className="descblk mono" id="rom-weaver-row-patch-requirements">
              <div className="k">{uiState.patchDetails.requirementsLabel}</div>
              <div className="v" id="rom-weaver-patch-requirements-value">
                {uiState.patchDetails.requirementsValue}
              </div>
            </div>
          ) : null}
        </>
      )}

      <WorkflowOutputStep
        action={
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
              disableRun={patches.length > 0 && enabledPatchCount === 0}
              totalTime={applyTotalTime || undefined}
            />
          </>
        }
        compress={buildOutputCompressionPanel({
          disabled: outputState.disabled,
          fields: outputState.compress?.fields,
          format: compressHeaderFormat,
          formatId: "rom-weaver-select-output-format-compress",
          formatOptions: compressionTypeOptions,
          formatValue: outputState.compressionFormat,
          onFieldChange: (key, value, updates) => controllers.output.setOutputCompressOption?.(key, value, updates),
          onFormatChange: (value) => controllers.output.setOutputCompression(value),
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
              <li>Set the filename without an extension — the format selector controls it.</li>
              <li>Container formats (zip, 7z, chd, rvz) are produced directly.</li>
              <li>Compression defaults come from Settings › Compression and apply to compressed output.</li>
            </ul>
          </InfoPopover>
        }
        meta={
          applyDone ? (
            <>
              {outputState.applyTiming ? (
                <span className="rb mono done-chip">
                  <span className="k">Apply</span>
                  <span className="t">{outputState.applyTiming}</span>
                </span>
              ) : null}
              {outputState.compressTiming ? (
                <span className="rb mono done-chip" style={{ animationDelay: "0.19s" }}>
                  <span className="k">Compress</span>
                  <span className="t">{outputState.compressTiming}</span>
                </span>
              ) : null}
            </>
          ) : outputState.applyTiming ? (
            <span className="t">{outputState.applyTiming}</span>
          ) : undefined
        }
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
        title="Apply"
        woven={applyDone || running}
      />

      <SharedArchiveDialog controller={controllers.dialog} />
    </main>
  );
}

export { ApplyWorkflowFormView };
