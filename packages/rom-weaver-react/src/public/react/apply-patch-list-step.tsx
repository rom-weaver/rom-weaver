import Crosshair from "lucide-react/dist/esm/icons/crosshair.js";
import GripVertical from "lucide-react/dist/esm/icons/grip-vertical.js";
import { createTiming, formatTiming } from "../../lib/progress/timing.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { ChecksumList, ChecksumRow } from "./components/ds/checksum-list.tsx";
import { Drawer, DrawerReadout } from "./components/ds/drawer.tsx";
import { ExtractDrawer, ExtractName } from "./components/ds/extraction-tree.tsx";
import { FileProgress, Notice } from "./components/ds/feedback.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { InfoPopover, StepSection } from "./components/ds/layout.tsx";
import { useListReorder } from "./components/ds/use-list-reorder.ts";
import type { PatcherStackController, PatcherUiController } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import type { NoticeState, PatcherUiState } from "./patcher-ui-state.ts";
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
  for (const entry of item.validationValues) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
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
  return { inputRows, outputRows };
};

/** One Verify drawer per patch, with INPUT / OUTPUT sub-groups — the loom
 * prototype's verification language (a single section, grouped rows). */
const PatchInfo = ({ item }: { item: PatchStackItemState }) => {
  const { inputRows, outputRows } = getPatchVerificationRows(item);
  const hasInputDetails = !!(inputRows.length || item.validationMessage);
  const hasOutputDetails = outputRows.length > 0;
  if (!(hasInputDetails || hasOutputDetails)) return null;
  const bad = item.validationState === "invalid";
  return (
    <ChecksumList
      defaultOpen={inputRows.length > 0 || hasOutputDetails}
      label="Verify"
      lead={
        item.validationMessage ? <p className={bad ? "pdesc bad" : "pdesc"}>{item.validationMessage}</p> : undefined
      }
      match={
        item.validationState === "invalid"
          ? { label: null, ok: false }
          : item.validationState === "valid"
            ? { label: null, ok: true }
            : undefined
      }
      timing={CHECKSUM_TIMING_LABEL(item.checksumTiming, "Verify")}
    >
      {inputRows.length ? (
        <div className="ck-group ckgrp">
          <div className="ck-group-head">
            <span>Input</span>
          </div>
          {inputRows.map((row) => (
            <ChecksumRow key={`input:${row.label}:${row.value}`} label={row.label} value={row.value} />
          ))}
        </div>
      ) : null}
      {hasOutputDetails ? (
        <div className="ck-group ckgrp">
          <div className="ck-group-head">
            <span>Output</span>
          </div>
          {outputRows.map((row) => (
            <ChecksumRow key={`output:${row.label}:${row.value}`} label={row.label} value={row.value} />
          ))}
        </div>
      ) : null}
    </ChecksumList>
  );
};

const CHECKSUM_HINT = "Paste a CRC32, MD5, or SHA1 hex digest";

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

const ApplyPatchListStep = ({
  patchInput,
  patchNotice,
  patches,
  patchStack,
  ui,
}: {
  patchInput: PatcherUiState["patchInput"];
  patchNotice: NoticeState;
  patches: PatchStackItemState[];
  patchStack: PatcherStackController;
  ui: PatcherUiController;
}) => {
  const total = patches.length;
  // Reordering only makes sense for a multi-patch stack. Dragging is additionally
  // suspended while any patch is staging or the stack is otherwise busy.
  const reorderable = total > 1;
  const canReorder = reorderable && patches.every((item) => !item.progress && item.canRemove);
  const reorderList = useListReorder({ count: total, disabled: !canReorder, onReorder: patchStack.reorder });
  const enabledBytes = patches.reduce((sum, item) => sum + (item.fileSize || 0), 0);
  return (
    <StepSection
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
              {total} {total === 1 ? "file" : "files"}
            </span>
            {enabledBytes ? <span className="rb mono">{formatByteSize(enabledBytes)}</span> : null}
          </>
        ) : undefined
      }
      num="0x03"
      title="Patches"
    >
      <div
        className="cards patch-cards workflow-file-list"
        id="rom-weaver-list-patch-stack"
        ref={reorderList.containerRef}
      >
        {patches.map((item, index) =>
          item.progress ? (
            <FileProgress
              cancelLabel="Cancel patch staging"
              id={`rom-weaver-progress-patch-${index}`}
              key={item.key ?? `${index}:${item.fileName}`}
              onCancel={() => patchStack.removeItem(index)}
              {...toWorkflowFileProgressProps(item.progress)!}
            />
          ) : (
            <FileCard
              key={item.key ?? `${index}:${item.fileName}`}
              {...reorderList.rowProps(index)}
              handle={
                reorderable ? (
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
                  {item.fileSize ? <span className="fsize mono">{formatByteSize(item.fileSize)}</span> : null}
                  {item.format ? <span className="meta-fmt mono">{item.format.toLowerCase()}</span> : null}
                </>
              }
              name={
                <ExtractName
                  fileName={item.fileName}
                  fileSize={item.fileSize}
                  legacyFileClassName="rom-weaver-patch-stack-file"
                  parentCompressions={item.archivePathEntries}
                />
              }
              onRemove={() => patchStack.removeItem(index)}
              patch
              removeLabel="Remove patch"
              state={item.validationState === "invalid" ? "bad" : item.validationState === "valid" ? "ok" : undefined}
              target={<PatchTarget index={index} item={item} patchStack={patchStack} />}
            >
              <ExtractDrawer
                fileName={item.fileName}
                fileSize={item.fileSize}
                parentCompressions={item.archivePathEntries}
                timing={TIMING_LABEL(item.decompressionTimeMs)}
              />
              <PatchInfo item={item} />
              <PatchOptions index={index} item={item} patchStack={patchStack} />
            </FileCard>
          ),
        )}
      </div>
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
