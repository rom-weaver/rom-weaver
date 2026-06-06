import { useSyncExternalStore } from "react";
import { createTiming, formatTiming } from "../../lib/progress/timing.ts";
import { ApplyPatchListStep } from "./apply-patch-list-step.tsx";
import { buildOutputCompressionPanel, getOutputCompressionFormatLabel } from "./components/ds/compress-panel.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { InfoPopover } from "./components/ds/layout.tsx";
import { WorkflowOutputStep } from "./components/ds/workflow-output-step.tsx";
import { WorkflowRomInputStep } from "./components/ds/workflow-rom-input-step.tsx";
import { PatcherPrimaryAction } from "./components/patcher-output-controls.tsx";
import { getFileInputAcceptAttributes } from "./file-input-accept";
import { ROM_INPUT_HINT } from "./input-helper-text.ts";
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
import { ArchiveDialog as SharedArchiveDialog } from "./patcher-react-shared.tsx";
import type { NoticeState, PatcherSectionNoticeKey, RomInputRowState } from "./patcher-ui-state.ts";
import { toWorkflowChecksumProgressProps, toWorkflowFileProgressProps } from "./workflow-run-hooks.ts";

/**
 * Apply-workflow view, rebuilt on the dark-pro design-system primitives. It is
 * purely presentational: it reads the same ui/patchStack/output/notice/dialog
 * controllers that ApplyPatchForm wires up and renders the step layout.
 */

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

function ApplyWorkflowFormView({
  controllers,
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
  const compressHeaderFormat = getOutputCompressionFormatLabel(outputState.compressionFormat, outputState.options);
  const compressionTypeOptions = createCompressionTypeOptions(outputState.options, "none");

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
      <WorkflowRomInputStep
        afterItems={
          uiState.chdSplitBin.visible ? (
            <label className="opt">
              <input
                checked={uiState.chdSplitBin.checked}
                disabled={uiState.chdSplitBin.disabled}
                id="rom-weaver-checkbox-chd-split-bin"
                onChange={(event) => uiController.setChdSplitBin?.(event.currentTarget.checked)}
                type="checkbox"
              />
              {uiState.chdSplitBin.label}
            </label>
          ) : null
        }
        dropZone={{
          accept: fileInputAccept.rom,
          big: romInputs.length === 0,
          hint: romInputs.length === 0 ? ROM_INPUT_HINT : undefined,
          inputId: "rom-weaver-input-file-rom",
          label: romInputs.length ? "Add another ROM · drop or browse" : "Select ROM · drop or browse",
          onFiles: (files) => uiController.provideRomInputFiles?.(files),
        }}
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
        items={romInputs.map((romInput, index) => {
          const state = romInput.invalid ? "bad" : romInput.valid ? "ok" : undefined;
          const rowProgress =
            romInput.progress && romInput.info.validationPhase !== "checksum" ? romInput.progress : null;
          if (rowProgress) {
            return {
              id: romInput.id,
              progress: {
                id: `rom-weaver-progress-rom-${index}`,
                ...toWorkflowFileProgressProps(rowProgress)!,
              },
            };
          }
          const checksumProgress =
            romInput.progress && romInput.info.validationPhase === "checksum" ? romInput.progress : null;
          return {
            card: {
              extract: {
                fileName: romInput.info.fileName,
                fileSize: romInput.size ?? romInput.sourceSize,
                legacyFileClassName: "rom-weaver-input-stack-file",
                parentCompressions: romInput.archivePathEntries,
                timing: TIMING_LABEL(romInput.decompressionTimeMs),
              },
              index: index + 1,
              onRemove: () => {
                if (romInputs.length === 1 && uiController.clearRomInput) uiController.clearRomInput();
                else uiController.removeRomInput?.(romInput.id);
              },
              panels: {
                fixes: {
                  headerSummary: uiState.romInfo.alterHeaderChecked ? "header will be fixed" : "header unchanged",
                  headerValue: getHeaderFixLabel(uiState.romInfo.alterHeaderChecked),
                  lead: romInput.info.romInfo ? <p className="pdesc">{romInput.info.romInfo}</p> : undefined,
                  romInfoText: romInput.info.romInfo,
                  trim: romInput.info.romProbe?.trim,
                },
                info: {
                  bytes: romInput.size ?? romInput.sourceSize,
                  checksums: {
                    crc32: romInput.info.crc32,
                    md5: romInput.info.md5,
                    sha1: romInput.info.sha1,
                  },
                  lead:
                    !checksumProgress && romInput.info.romInfo ? (
                      <p className="pdesc">{romInput.info.romInfo}</p>
                    ) : undefined,
                  onToggle: () => uiController.toggleRomInputChecksums?.(romInput.id),
                  open: romInput.info.checksumsExpanded,
                  progress: toWorkflowChecksumProgressProps(checksumProgress),
                  timing: CHECKSUM_TIMING_LABEL(romInput.info.checksumTiming),
                },
                showFixes: romInput.kind !== "cue",
                showInfo: romInput.kind !== "cue",
              },
              removeLabel: romInputs.length > 1 ? "Remove ROM input" : "Clear ROM input",
              state,
            },
            id: romInput.id,
          };
        })}
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
        num="01"
        title="ROMs"
      />

      <ApplyPatchListStep
        patches={patches}
        patchInput={uiState.patchInput}
        patchNotice={uiState.patchNotice}
        patchStack={controllers.patchStack}
        ui={uiController}
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
            <PatcherPrimaryAction controller={controllers.output} />
            {uiState.cueDownload.visible ? (
              <button
                className="btn ghost"
                disabled={uiState.cueDownload.disabled}
                id="rom-weaver-button-download-cue"
                onClick={() => uiController.downloadCue?.()}
                title={uiState.cueDownload.title}
                type="button"
              >
                {uiState.cueDownload.label}
              </button>
            ) : null}
          </>
        }
        compress={buildOutputCompressionPanel({
          disabled: outputState.disabled,
          fields: outputState.compress?.fields,
          format: compressHeaderFormat,
          formatId: "rom-weaver-select-output-format-compress",
          formatOptions: compressionTypeOptions,
          formatValue: outputState.compressionFormat,
          onFieldChange: (key, value) => controllers.output.setOutputCompressOption?.(key, value),
          onFormatChange: (value) => controllers.output.setOutputCompression(value),
          summary: outputState.compress?.summary,
          timing: outputState.compressTiming || undefined,
        })}
        disabled={outputState.disabled}
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
        meta={outputState.applyTiming ? <span className="t">{outputState.applyTiming}</span> : undefined}
        notice={
          <SectionNotice
            id="rom-weaver-output-notice-message"
            onDismiss={dismissSectionNotice("outputNotice")}
            state={uiState.outputNotice}
          />
        }
        num="03"
        onFileNameChange={(value) => controllers.output.setDisplayFileName(value)}
        onFormatChange={(value) => controllers.output.setOutputCompression(value)}
        title="Apply"
      />

      <SharedArchiveDialog controller={controllers.dialog} />
    </main>
  );
}

export { ApplyWorkflowFormView };
