import { createTiming, formatTiming } from "../../lib/progress/timing.ts";
import { ChecksumList, ChecksumRow } from "./components/ds/checksum-list.tsx";
import { ExtractPanel } from "./components/ds/extraction-tree.tsx";
import { FileProgress, Notice } from "./components/ds/feedback.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { DropZone, InfoPopover, StepSection } from "./components/ds/layout.tsx";
import { getFileInputAcceptAttributes } from "./file-input-accept";
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

const PatchInfo = ({ item }: { item: PatchStackItemState }) => {
  const { inputRows, outputRows } = getPatchVerificationRows(item);
  const hasInputDetails = !!(inputRows.length || item.validationMessage);
  const hasOutputDetails = outputRows.length > 0;
  const hasDetails = hasInputDetails || hasOutputDetails;
  if (!hasDetails) return null;
  const bad = item.validationState === "invalid";
  const hasInputVerificationInfo = inputRows.length > 0;
  const hasOutputVerificationInfo = outputRows.length > 0;
  return (
    <>
      {hasInputDetails ? (
        <ChecksumList
          defaultOpen={hasInputVerificationInfo}
          label="Input Check"
          lead={bad && item.validationMessage ? <p className="pdesc bad">{item.validationMessage}</p> : undefined}
          match={
            item.validationState === "invalid"
              ? { label: null, ok: false }
              : item.validationState === "valid"
                ? { label: null, ok: true }
                : undefined
          }
          timing={CHECKSUM_TIMING_LABEL(item.checksumTiming, "Verify")}
        >
          {inputRows.map((row) => (
            <ChecksumRow key={`input:${row.label}:${row.value}`} label={row.label} value={row.value} />
          ))}
        </ChecksumList>
      ) : null}
      {hasOutputDetails ? (
        <ChecksumList defaultOpen={hasOutputVerificationInfo} label="Output Check">
          {outputRows.map((row) => (
            <ChecksumRow key={`output:${row.label}:${row.value}`} label={row.label} value={row.value} />
          ))}
        </ChecksumList>
      ) : null}
    </>
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
  const fileInputAccept = getFileInputAcceptAttributes();
  return (
    <StepSection
      id="rom-weaver-row-patch-stack"
      info={
        <InfoPopover title="Supported patch types">
          <strong>Supported patch types</strong>
          <ul>
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
      num="02"
      title="Patches"
    >
      <div className="workflow-file-list" id="rom-weaver-list-patch-stack">
        {patches.map((item, index) =>
          item.progress ? (
            <FileProgress
              id={`rom-weaver-progress-patch-${index}`}
              key={item.key ?? `${index}:${item.fileName}`}
              {...toWorkflowFileProgressProps(item.progress)!}
            />
          ) : (
            <FileCard
              key={item.key ?? `${index}:${item.fileName}`}
              name={
                <ExtractPanel
                  fileName={item.fileName}
                  fileSize={item.fileSize}
                  legacyFileClassName="rom-weaver-patch-stack-file"
                  parentCompressions={item.archivePathEntries}
                  timing={TIMING_LABEL(item.decompressionTimeMs)}
                />
              }
              patch={{
                index,
                onDown: () => patchStack.moveItem(index, 1),
                onRemove: () => patchStack.removeItem(index),
                onUp: () => patchStack.moveItem(index, -1),
                total: patches.length,
              }}
              state={item.validationState === "invalid" ? "bad" : item.validationState === "valid" ? "ok" : undefined}
              target={
                item.targetOptions && item.targetOptions.length > 1 ? (
                  <div className="ptgt-row">
                    <label className="sr-only" htmlFor={`rom-weaver-select-patch-target-${index}`}>
                      Apply patch to
                    </label>
                    <select
                      className="select ptgt-sel"
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
                  </div>
                ) : undefined
              }
            >
              <PatchInfo item={item} />
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
        <div className="ropts">
          {patchInput.optionalPatches.map((option) => (
            <label className="opt" key={option.id} title={option.description || undefined}>
              <input
                checked={option.checked}
                disabled={option.disabled}
                onChange={(event) => ui.setOptionalPatch?.(option.id, event.currentTarget.checked)}
                type="checkbox"
              />
              {option.label}
            </label>
          ))}
        </div>
      ) : null}
      <DropZone
        accept={fileInputAccept.patch}
        big={patches.length === 0}
        hint={patches.length === 0 ? "compressed & archived patches are accepted" : undefined}
        inputId="rom-weaver-input-file-patch"
        label={patches.length ? "Add patch · drop or browse" : "Select patch · drop or browse"}
        onFiles={(files) => ui.providePatchInputFiles?.(files)}
      />
      <SectionNotice onDismiss={() => ui.dismissNotice?.("patchNotice")} state={patchNotice} />
    </StepSection>
  );
};

export { ApplyPatchListStep };
