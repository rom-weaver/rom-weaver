import Check from "lucide-react/dist/esm/icons/check.js";
import Crosshair from "lucide-react/dist/esm/icons/crosshair.js";
import GripVertical from "lucide-react/dist/esm/icons/grip-vertical.js";
import X from "lucide-react/dist/esm/icons/x.js";
import type { ReactNode } from "react";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { createTiming, formatTiming } from "../../storage/shared/timing.ts";
import { ChecksumList, type ChecksumPendingGroup, ChecksumRow, PendingChecks } from "./components/ds/checksum-list.tsx";
import { Drawer, DrawerReadout } from "./components/ds/drawer.tsx";
import { ExtractDrawer, ExtractName } from "./components/ds/extraction-tree.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { InfoPopover, StepSection } from "./components/ds/layout.tsx";
import { StageStatus, stageBarValue, stagePercent, stageStatusLabel } from "./components/ds/staging-meta.tsx";
import { useListReorder } from "./components/ds/use-list-reorder.ts";
import type { PatcherStackController, PatcherUiController } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import type { NoticeState, PatcherUiState } from "./patcher-ui-state.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import { toWorkflowFileProgressProps } from "./workflow-run-hooks.ts";

const TIMING_LABEL = (ms?: number) =>
  typeof ms === "number" && Number.isFinite(ms) ? formatTiming(createTiming(ms)) : "";
const CHECKSUM_TIMING_LABEL = (timing?: string, prefix = "Checksum") => (timing ? `${prefix} ${timing}` : undefined);

const PATCH_INPUT_VERIFICATION_LABELS: Record<string, string> = {
  "in crc32": "CRC32",
  "in min size": "MIN BYTES",
  "in size": "BYTES",
};

const PATCH_OUTPUT_VERIFICATION_LABELS: Record<string, string> = {
  "out crc32": "CRC32",
  "out size": "BYTES",
  "patch crc32": "PATCH CRC32",
};

const SectionNotice = ({ onDismiss, state }: { onDismiss?: () => void; state: NoticeState }) => {
  if (!state.visible) return null;
  return (
    <Notice
      id="rom-weaver-patch-notice-message"
      level={state.level === "warning" ? "warn" : "error"}
      onDismiss={state.dismissible ? onDismiss : undefined}
    >
      {state.message}
    </Notice>
  );
};

const getPatchVerificationRows = (item: PatchStackItemState) => {
  const inputRows: Array<{ label: string; value: string }> = [];
  const outputRows: Array<{ label: string; value: string }> = [];
  let dryRun = false;
  for (const entry of item.validationValues) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
      // "dry-run apply" marks scratch-copy validation — rendered as the
      // prototype's dry-run verdict block, not a checksum row.
      if (/dry-?run/i.test(entry)) {
        dryRun = true;
        continue;
      }
      inputRows.push({ label: "VALIDATION", value: entry });
      continue;
    }
    const rawLabel = entry.slice(0, separatorIndex).trim().toLowerCase();
    const value = entry.slice(separatorIndex + 1).trim();
    if (!value) continue;
    if (PATCH_INPUT_VERIFICATION_LABELS[rawLabel]) {
      inputRows.push({ label: PATCH_INPUT_VERIFICATION_LABELS[rawLabel], value });
      continue;
    }
    outputRows.push({ label: PATCH_OUTPUT_VERIFICATION_LABELS[rawLabel] || rawLabel.toUpperCase(), value });
  }
  return { dryRun, inputRows, outputRows };
};

/** One Checks drawer per patch, with INPUT / OUTPUT / DRY-RUN sub-groups — the
 * loom prototype's verification language (a single section, grouped rows; the
 * dry-run reports a verdict block, not a checksum row). */
const PatchInfo = ({
  item,
  pending,
}: {
  item: PatchStackItemState;
  /** When set, the patch is still staging: render shimmer placeholders for these
   * planned verification sections (Input / Output) so the card holds its resolved
   * height through staging — the bar + meta status carry progress. */
  pending?: ChecksumPendingGroup[];
}) => {
  const localizer = useUiLocalizer();
  if (pending?.length) {
    return <PendingChecks defaultOpen groupClassName="ck-group ckgrp" groups={pending} label="Checks" />;
  }
  const { dryRun, inputRows, outputRows } = getPatchVerificationRows(item);
  const hasInputDetails = !!(inputRows.length || item.validationMessage);
  const hasOutputDetails = outputRows.length > 0;
  if (!(hasInputDetails || hasOutputDetails || dryRun)) return null;
  const bad = item.validationState === "invalid";
  // The dry-run verdict line already says pass/fail — only surface the raw
  // validation message alongside it when it carries failure detail.
  const showMessage = !!item.validationMessage && (!dryRun || bad);
  let match: { label: null; ok: boolean } | undefined;
  if (item.validationState === "invalid") match = { label: null, ok: false };
  else if (item.validationState === "valid") match = { label: null, ok: true };
  return (
    <ChecksumList
      defaultOpen={inputRows.length > 0 || hasOutputDetails || dryRun}
      label="Checks"
      lead={showMessage ? <p className={bad ? "pdesc bad" : "pdesc"}>{item.validationMessage}</p> : undefined}
      match={match}
      timing={CHECKSUM_TIMING_LABEL(item.checksumTiming, "Checks")}
    >
      {inputRows.length ? (
        <div className="ck-group ckgrp">
          <div className="ck-group-head">
            <span>{localizer.message("ui.verify.input")}</span>
          </div>
          {inputRows.map((row) => (
            <ChecksumRow key={`input:${row.label}:${row.value}`} label={row.label} value={row.value} />
          ))}
        </div>
      ) : null}
      {hasOutputDetails ? (
        <div className="ck-group ckgrp">
          <div className="ck-group-head">
            <span>{localizer.message("ui.verify.output")}</span>
          </div>
          {outputRows.map((row) => (
            <ChecksumRow key={`output:${row.label}:${row.value}`} label={row.label} value={row.value} />
          ))}
        </div>
      ) : null}
      {dryRun ? (
        <div className="ck-group ckgrp">
          <div className="ck-group-head">
            <span>{localizer.message("ui.verify.dryRun")}</span>
          </div>
          <div className="dryrun">
            <span className="dryrun-desc">{localizer.message("ui.verify.dryRunDesc")}</span>
            <span className={bad ? "dryrun-verdict bad" : "dryrun-verdict ok"}>
              {bad ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
              <span>{localizer.message(bad ? "ui.verify.dryRunFail" : "ui.verify.dryRunPass")}</span>
            </span>
          </div>
        </div>
      ) : null}
    </ChecksumList>
  );
};

const CHECKSUM_HINT = "CRC32, MD5, or SHA-1";

const PatchOptions = ({
  index,
  item,
  patchStack,
}: {
  index: number;
  item: PatchStackItemState;
  patchStack: PatcherStackController;
}) => {
  const setOption = patchStack.setPatchOption;
  if (!setOption) return null;
  const ppfUndoChecked = item.ppfUndo !== false;
  return (
    <Drawer
      bodyClassName="optsbody"
      className="optsblock"
      label="Options"
      readouts={item.format ? <DrawerReadout>{item.format}</DrawerReadout> : undefined}
    >
      <div className="optsgrid">
        <div className="ofld">
          <label className="ofld-l" htmlFor={`rom-weaver-patch-validate-input-${index}`}>
            Validate input
          </label>
          <input
            className="input mono popt-input"
            defaultValue={item.validateInputChecksum || ""}
            disabled={item.optionsDisabled}
            id={`rom-weaver-patch-validate-input-${index}`}
            key={`validate-input:${item.key ?? index}`}
            onBlur={(event) => setOption(index, { validateInputChecksum: event.currentTarget.value })}
            placeholder={CHECKSUM_HINT}
            spellCheck={false}
            type="text"
          />
        </div>
        <div className="ofld">
          <label className="ofld-l" htmlFor={`rom-weaver-patch-validate-output-${index}`}>
            Validate output
          </label>
          <input
            className="input mono popt-input"
            defaultValue={item.validateOutputChecksum || ""}
            disabled={item.optionsDisabled}
            id={`rom-weaver-patch-validate-output-${index}`}
            key={`validate-output:${item.key ?? index}`}
            onBlur={(event) => setOption(index, { validateOutputChecksum: event.currentTarget.value })}
            placeholder={CHECKSUM_HINT}
            spellCheck={false}
            type="text"
          />
        </div>
      </div>
      {item.showPpfUndo ? (
        <div className="optschecks">
          <label className="popt" title="Safely re-apply over an already-patched ROM using the PPF undo data">
            <input
              checked={ppfUndoChecked}
              disabled={item.optionsDisabled}
              onChange={(event) => setOption(index, { ppfUndo: event.currentTarget.checked })}
              type="checkbox"
            />
            <span>PPF undo (safe re-apply)</span>
          </label>
        </div>
      ) : null}
    </Drawer>
  );
};

type ReorderHandleProps = ReturnType<ReturnType<typeof useListReorder>["handleProps"]>;

/** Drag handle in the patch card's action column: grip glyph, drag or arrow keys to reorder. */
const PatchDragHandle = ({
  disabled,
  handleProps,
  index,
  total,
}: {
  disabled: boolean;
  handleProps: ReorderHandleProps;
  index: number;
  total: number;
}) => (
  <button
    aria-label={`Patch ${index + 1} of ${total}. Drag or press the up and down arrow keys to reorder.`}
    className="handle phandle"
    disabled={disabled}
    title="Drag to reorder · ↑ / ↓ keys"
    type="button"
    {...handleProps}
  >
    <GripVertical aria-hidden="true" className="phandle-grip" />
  </button>
);

/** The patch's track/target on the meta line — inline select when there is a choice. */
const PatchTarget = ({
  index,
  item,
  patchStack,
}: {
  index: number;
  item: PatchStackItemState;
  patchStack: PatcherStackController;
}) => {
  if (!item.targetOptions || item.targetOptions.length <= 1) return null;
  return (
    <span className="target-grp">
      <Crosshair aria-hidden="true" />
      <label className="sr-only" htmlFor={`rom-weaver-select-patch-target-${index}`}>
        Apply patch to
      </label>
      <select
        className="meta-target-select mono ptgt-sel"
        disabled={item.targetDisabled}
        id={`rom-weaver-select-patch-target-${index}`}
        onChange={(event) => patchStack.setPatchTarget?.(index, event.currentTarget.value)}
        value={item.targetValue || ""}
      >
        <option disabled value="">
          Select target
        </option>
        {item.targetOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
};

/** The loom On/Off switch leading a patch card's meta line. */
const PatchEnableToggle = ({
  disabled,
  fileName,
  onToggle,
}: {
  disabled: boolean;
  fileName: string;
  onToggle: () => void;
}) => (
  <label className="patch-enable">
    <input
      aria-label={`Include ${fileName.replace(/\.[^.]+$/, "")}`}
      checked={!disabled}
      onChange={onToggle}
      type="checkbox"
    />
    <span aria-hidden="true" className="switch-state">
      <b className="on">On</b>
      <b className="off">Off</b>
    </span>
  </label>
);

const ApplyPatchListStep = ({
  disabledFlags,
  emptyState,
  fault,
  onTogglePatch,
  patchInput,
  patchNotice,
  patches,
  patchStack,
  ui,
  woven,
}: {
  disabledFlags?: readonly boolean[];
  /** Fixture shown when no patches (and no embedded/optional patch choices) are present. */
  emptyState?: ReactNode;
  fault?: boolean;
  onTogglePatch?: (index: number) => void;
  patchInput: PatcherUiState["patchInput"];
  patchNotice: NoticeState;
  patches: PatchStackItemState[];
  patchStack: PatcherStackController;
  ui: PatcherUiController;
  woven?: boolean;
}) => {
  const localizer = useUiLocalizer();
  const total = patches.length;
  // Reordering only makes sense for a multi-patch stack. Dragging is additionally
  // suspended while any patch is staging or the stack is otherwise busy.
  const reorderable = total > 1;
  const canReorder = reorderable && patches.every((item) => !item.progress && item.canRemove);
  const reorderList = useListReorder({ count: total, disabled: !canReorder, onReorder: patchStack.reorder });
  const disabledCount = (disabledFlags || []).filter(Boolean).length;
  const enabledBytes = patches.reduce(
    (sum, item, index) => (disabledFlags?.[index] ? sum : sum + (item.fileSize || 0)),
    0,
  );
  const enabledCount = total - disabledCount;
  return (
    <StepSection
      fault={fault}
      id="rom-weaver-row-patch-stack"
      info={
        <InfoPopover title="Supported patch types">
          <strong>Supported patch types</strong>
          <ul className="info-list">
            <li>
              IPS, IPS32, SOLID, BPS, UPS, VCDIFF/xdelta, GDIFF, HDiffPatch, APS, APSGBA, RUP, PPF, EBP, BSDIFF, and
              more.
            </li>
            <li>NINJA1 headers are recognized, but NINJA1 apply is not supported.</li>
            <li>PDS patches are unsupported; HDIFF19 directory patches are unsupported.</li>
            <li>Patches can be chosen from supported (and nested) archives.</li>
          </ul>
        </InfoPopover>
      }
      meta={
        total > 0 ? (
          <>
            <span className="rb mono">
              {enabledCount} {enabledCount === 1 ? "file" : "files"}
            </span>
            {disabledCount ? <span className="rb mono muted">{disabledCount} disabled</span> : null}
            {enabledBytes ? <span className="rb mono">{formatByteSize(enabledBytes)}</span> : null}
          </>
        ) : undefined
      }
      num="0x03"
      title="Patches"
      woven={woven}
    >
      <div
        className="cards patch-cards workflow-file-list"
        id="rom-weaver-list-patch-stack"
        ref={reorderList.containerRef}
      >
        {patches.map((item, index) => {
          // Mirrors the ROM card: the resolved card structure stays mounted through
          // staging — a determinate bar on the top edge + a "Validating…" status in
          // the meta line carry progress, and the Checks drawer reserves its
          // verification sections as shimmer placeholders — so the stack doesn't
          // jump when validation lands. The bar stays full once finished.
          const staging = !!item.progress;
          const stagingProps = staging ? toWorkflowFileProgressProps(item.progress) : null;
          const percent = stagePercent(stagingProps);
          const rowProps = reorderList.rowProps(index);
          const disabledClass = disabledFlags?.[index] ? "is-disabled" : undefined;
          let verdict: "bad" | "ok" | undefined;
          if (item.validationState === "invalid") verdict = "bad";
          else if (item.validationState === "valid") verdict = "ok";
          // Phase A reserves the source (Input) verification group; the streamed
          // section plan will extend this to the exact sections (Input/Output/dry-run).
          const pendingSections: ChecksumPendingGroup[] = [
            {
              id: "input",
              label: localizer.message("ui.verify.input"),
              rows: [
                { label: "CRC32", length: 8 },
                { label: "BYTES", length: 8 },
              ],
            },
          ];
          return (
            <FileCard
              key={item.key ?? `${index}:${item.fileName}`}
              {...rowProps}
              className={[rowProps.className, disabledClass].filter(Boolean).join(" ") || undefined}
              handle={
                reorderable && !staging ? (
                  <PatchDragHandle
                    disabled={!canReorder}
                    handleProps={reorderList.handleProps(index)}
                    index={index}
                    total={total}
                  />
                ) : undefined
              }
              meta={
                <>
                  {onTogglePatch ? (
                    <PatchEnableToggle
                      disabled={!!disabledFlags?.[index]}
                      fileName={item.fileName}
                      onToggle={() => onTogglePatch(index)}
                    />
                  ) : null}
                  {item.fileSize ? <span className="fsize mono">{formatByteSize(item.fileSize)}</span> : null}
                  {item.format ? <span className="meta-fmt mono">{item.format.toLowerCase()}</span> : null}
                  {staging ? (
                    <StageStatus
                      id={`rom-weaver-progress-patch-${index}`}
                      label={stageStatusLabel(stagingProps, "Validating")}
                      percent={percent}
                    />
                  ) : null}
                </>
              }
              name={
                <ExtractName
                  fileName={item.fileName}
                  fileSize={item.fileSize}
                  // The first archive-path entry is the source archive itself (shown
                  // in the Extract drawer / picker); the rest is the folder path
                  // within it, surfaced inline on the name.
                  folderPath={
                    (item.archivePathEntries || [])
                      .slice(1)
                      .map((entry) => entry.fileName)
                      .filter(Boolean)
                      .join(" › ") || undefined
                  }
                  legacyFileClassName="rom-weaver-patch-stack-file"
                  parentCompressions={item.archivePathEntries}
                />
              }
              onRemove={() => patchStack.removeItem(index)}
              patch
              removeLabel="Remove patch"
              stageBar={stageBarValue(staging, percent)}
              state={staging ? undefined : verdict}
              target={staging ? undefined : <PatchTarget index={index} item={item} patchStack={patchStack} />}
            >
              <div className="patch-body">
                <div className="patch-body-inner">
                  <ExtractDrawer
                    fileName={item.fileName}
                    fileSize={item.fileSize}
                    parentCompressions={item.archivePathEntries}
                    timing={TIMING_LABEL(item.decompressionTimeMs)}
                  />
                  <PatchOptions index={index} item={item} patchStack={patchStack} />
                  <PatchInfo item={item} pending={staging ? pendingSections : undefined} />
                </div>
              </div>
            </FileCard>
          );
        })}
      </div>
      {total === 0 &&
      emptyState &&
      !patchInput.embeddedPatchLoadingVisible &&
      !patchInput.embeddedPatchOptions.length &&
      !patchInput.optionalPatches.length
        ? emptyState
        : null}
      {patchInput.embeddedPatchLoadingVisible ? (
        <p className="hintline">{patchInput.embeddedPatchLoadingMessage}</p>
      ) : null}
      {patchInput.embeddedPatchOptions.length ? (
        <select
          className="select"
          disabled={patchInput.embeddedPatchDisabled}
          id="rom-weaver-select-patch"
          onChange={(event) => ui.selectEmbeddedPatch?.(event.currentTarget.value)}
          value={patchInput.embeddedPatchValue}
        >
          {patchInput.embeddedPatchOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}
      {patchInput.optionalPatches.length ? (
        <div className="optschecks ropts">
          {patchInput.optionalPatches.map((option) => (
            <label className="popt opt" key={option.id} title={option.description || undefined}>
              <input
                checked={option.checked}
                disabled={option.disabled}
                onChange={(event) => ui.setOptionalPatch?.(option.id, event.currentTarget.checked)}
                type="checkbox"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : null}
      <SectionNotice onDismiss={() => ui.dismissNotice?.("patchNotice")} state={patchNotice} />
    </StepSection>
  );
};

export { ApplyPatchListStep };
