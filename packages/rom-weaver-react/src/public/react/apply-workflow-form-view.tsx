import { useSyncExternalStore } from "react";
import { createTiming, formatTiming } from "../../lib/progress/timing.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { ChecksumList, ChecksumRow } from "./components/ds/checksum-list.tsx";
import { CompressPanelBody } from "./components/ds/compress-panel.tsx";
import { type ExtractionLevel, ExtractionTree } from "./components/ds/extraction-tree.tsx";
import { FileProgress, Notice } from "./components/ds/feedback.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { DropZone, InfoPopover, StepSection } from "./components/ds/layout.tsx";
import { OutputCard } from "./components/ds/output-card.tsx";
import { PatcherPrimaryAction } from "./components/patcher-output-controls.tsx";
import { getFileInputAcceptAttributes } from "./file-input-accept";
import type {
  DialogController,
  NoticeController,
  PatcherOutputController,
  PatcherStackController,
  PatcherUiController,
  StartupState,
} from "./patcher-form.ts";
import { inertUiController } from "./patcher-form-session.ts";
import type { ArchivePathEntry, PatchStackItemState } from "./patcher-presentation.ts";
import { ArchiveDialog as SharedArchiveDialog } from "./patcher-react-shared.tsx";
import type { InputProgressState, NoticeState, RomInputRowState } from "./patcher-ui-state.ts";

/**
 * Apply-workflow view, rebuilt on the dark-pro design-system primitives. It is
 * purely presentational: it reads the same ui/patchStack/output/notice/dialog
 * controllers that ApplyPatchForm wires up and renders the step layout.
 */

const SIZE_LABEL = (bytes?: number) => (typeof bytes === "number" ? formatByteSize(bytes) : "");
const TIMING_LABEL = (ms?: number) =>
  typeof ms === "number" && Number.isFinite(ms) ? formatTiming(createTiming(ms)) : "";

/** Map a runtime InputProgressState onto the FileProgress primitive's props. */
const toProgressProps = (progress: NonNullable<InputProgressState>) => {
  const percent =
    typeof progress.visualPercent === "number"
      ? progress.visualPercent
      : typeof progress.percent === "number"
        ? progress.percent
        : null;
  // No known percentage → indeterminate (animated sliver), never a static partial bar.
  const indeterminate = percent === null;
  return {
    indeterminate,
    label: progress.label || progress.message || "Working…",
    percent,
    value:
      typeof progress.percent === "number" ? `${Math.round(progress.percent)}%` : indeterminate ? "working" : undefined,
  };
};

/** Build the extraction-tree levels for a resolved file from its archive chain. */
const toExtractionLevels = (
  fileName: string,
  fileSize: number | undefined,
  entries: ArchivePathEntry[] | undefined,
): ExtractionLevel[] => {
  const levels: ExtractionLevel[] = (entries ?? []).map((entry) => {
    // Each chain level shows that file's own stored size (the prototype's
    // "original → extracted" reads outer-archive size → final ROM size), so prefer
    // sourceSize; outputSize is the decompressed payload and only a fallback.
    const levelSize = entry.sourceSize ?? entry.outputSize;
    return {
      name: entry.fileName,
      sizeBytes: levelSize,
      sizeLabel: SIZE_LABEL(levelSize),
      timing: TIMING_LABEL(entry.decompressionTimeMs),
    };
  });
  const last = levels[levels.length - 1];
  if (!last || last.name !== fileName) {
    levels.push({ name: fileName, sizeBytes: fileSize, sizeLabel: SIZE_LABEL(fileSize) });
  }
  return levels;
};

const SectionNotice = ({ state }: { state: NoticeState }) => {
  if (!state.visible) return null;
  return <Notice level={state.level === "warning" ? "warn" : "error"}>{state.message}</Notice>;
};

const RomChecksums = ({ romInput, controller }: { romInput: RomInputRowState; controller: PatcherUiController }) => {
  const checksumProgress = romInput.progress && romInput.info.validationPhase === "checksum" ? romInput.progress : null;
  return (
    <ChecksumList
      label="Checksums"
      lead={
        checksumProgress ? (
          <FileProgress {...toProgressProps(checksumProgress)} />
        ) : romInput.info.romInfo ? (
          <p className="pdesc">{romInput.info.romInfo}</p>
        ) : null
      }
      onToggle={() => controller.toggleRomInputChecksums?.(romInput.id)}
      open={romInput.info.checksumsExpanded}
      timing={romInput.info.checksumTiming || undefined}
    >
      <ChecksumRow label="CRC32" value={romInput.info.crc32} />
      <ChecksumRow label="MD5" value={romInput.info.md5} />
      <ChecksumRow label="SHA-1" value={romInput.info.sha1} />
    </ChecksumList>
  );
};

const PatchInfo = ({ item }: { item: PatchStackItemState }) => {
  const hasDetails = !!(item.detailText || item.validationMessage || item.validationValues.length);
  if (!hasDetails) return null;
  const bad = item.validationState === "invalid";
  return (
    <ChecksumList
      label="Info"
      lead={
        item.validationMessage ? <p className={bad ? "pdesc bad" : "pdesc"}>{item.validationMessage}</p> : undefined
      }
      match={
        item.validationState === "invalid"
          ? { label: "Mismatch", ok: false }
          : item.validationState === "valid"
            ? { label: "Match", ok: true }
            : undefined
      }
    >
      {item.validationValues.map((value) => (
        <ChecksumRow key={value} label={item.validationLabel} value={value} />
      ))}
    </ChecksumList>
  );
};

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

  const romInputs: RomInputRowState[] = uiState.romInputs;
  const patches = patchState.items;

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
      <StepSection
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
        meta={
          uiState.sectionTimings.input ? (
            <>
              <span className="k">extract</span> <span className="t">{uiState.sectionTimings.input}</span>
            </>
          ) : null
        }
        num="01"
        title="ROMs"
      >
        {romInputs.map((romInput, index) => {
          const state = romInput.invalid ? "bad" : romInput.valid ? "ok" : undefined;
          const rowProgress =
            romInput.progress && romInput.info.validationPhase !== "checksum" ? romInput.progress : null;
          return (
            <FileCard
              index={index + 1}
              key={romInput.id}
              name={
                <ExtractionTree
                  levels={toExtractionLevels(
                    romInput.info.fileName,
                    romInput.size ?? romInput.sourceSize,
                    romInput.archivePathEntries,
                  )}
                  timing={TIMING_LABEL(romInput.decompressionTimeMs)}
                />
              }
              onRemove={() => {
                if (romInputs.length === 1 && uiController.clearRomInput) uiController.clearRomInput();
                else uiController.removeRomInput?.(romInput.id);
              }}
              removeLabel={romInputs.length > 1 ? "Remove ROM input" : "Clear ROM input"}
              state={state}
            >
              {/* While extracting/decoding, show only progress — hide the collapsible sections. */}
              {rowProgress ? (
                <FileProgress {...toProgressProps(rowProgress)} />
              ) : romInput.kind === "cue" ? null : (
                <RomChecksums controller={uiController} romInput={romInput} />
              )}
            </FileCard>
          );
        })}
        {uiState.chdSplitBin.visible ? (
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
        ) : null}
        <DropZone
          accept={fileInputAccept.rom}
          big={romInputs.length === 0}
          hint={romInputs.length === 0 ? ".sfc, .nes, .gba, .iso, .chd, .rvz, .z3ds, .zip, .7z, .rar…" : undefined}
          label={romInputs.length ? "Add another ROM · drop or browse" : "Select ROM · drop or browse"}
          onFiles={(files) => uiController.provideRomInputFiles?.(files)}
        />
        <SectionNotice state={uiState.inputNotice} />
        <SectionNotice state={uiState.checksumNotice} />
      </StepSection>

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
        meta={
          uiState.sectionTimings.patch ? (
            <>
              <span className="k">extract</span> <span className="t">{uiState.sectionTimings.patch}</span>
            </>
          ) : null
        }
        num="02"
        title="Patches"
      >
        {patches.map((item, index) => (
          <FileCard
            key={item.key ?? `${index}:${item.fileName}`}
            name={<ExtractionTree levels={toExtractionLevels(item.fileName, item.fileSize, item.archivePathEntries)} />}
            patch={{
              index,
              onDown: () => controllers.patchStack.moveItem(index, 1),
              onRemove: () => controllers.patchStack.removeItem(index),
              onUp: () => controllers.patchStack.moveItem(index, -1),
              total: patches.length,
            }}
            state={item.validationState === "invalid" ? "bad" : item.validationState === "valid" ? "ok" : undefined}
          >
            {item.progress ? <FileProgress {...toProgressProps(item.progress)} /> : <PatchInfo item={item} />}
          </FileCard>
        ))}
        {uiState.patchInput.embeddedPatchLoadingVisible ? (
          <p className="hintline">{uiState.patchInput.embeddedPatchLoadingMessage}</p>
        ) : null}
        {uiState.patchInput.embeddedPatchOptions.length ? (
          <select
            className="select"
            disabled={uiState.patchInput.embeddedPatchDisabled}
            id="rom-weaver-select-patch"
            onChange={(event) => uiController.selectEmbeddedPatch?.(event.currentTarget.value)}
            value={uiState.patchInput.embeddedPatchValue}
          >
            {uiState.patchInput.embeddedPatchOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        {uiState.patchInput.optionalPatches.length ? (
          <div className="ropts">
            {uiState.patchInput.optionalPatches.map((option) => (
              <label className="opt" key={option.id} title={option.description || undefined}>
                <input
                  checked={option.checked}
                  disabled={option.disabled}
                  onChange={(event) => uiController.setOptionalPatch?.(option.id, event.currentTarget.checked)}
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
          label={patches.length ? "Add patch · drop or browse" : "Select patch · drop or browse"}
          onFiles={(files) => uiController.providePatchInputFiles?.(files)}
        />
        <SectionNotice state={uiState.patchNotice} />
      </StepSection>

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

      <StepSection
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
        meta={uiState.sectionTimings.output ? <span className="t">{uiState.sectionTimings.output}</span> : null}
        num="03"
        title="Apply"
      >
        <OutputCard
          action={
            <>
              {uiState.romInfo.alterHeaderVisible ? (
                <label className="opt trim-ack">
                  <input
                    checked={uiState.romInfo.alterHeaderChecked}
                    disabled={uiState.romInfo.alterHeaderDisabled}
                    id="rom-weaver-checkbox-alter-header"
                    onChange={(event) => uiController.setAlterHeader?.(event.currentTarget.checked)}
                    type="checkbox"
                  />
                  {uiState.romInfo.alterHeaderLabel}
                </label>
              ) : null}
              {errorNotice?.visible ? (
                <Notice id="rom-weaver-row-error-message" level={errorNotice.level === "warning" ? "warn" : "error"}>
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
          compress={
            outputState.compress
              ? {
                  children: (
                    <CompressPanelBody
                      disabled={outputState.disabled}
                      fields={outputState.compress.fields}
                      onChange={(key, value) => controllers.output.setOutputCompressOption?.(key, value)}
                    />
                  ),
                  summary: outputState.compress.summary,
                }
              : null
          }
          disabled={outputState.disabled}
          fileName={outputState.displayFileName}
          fileNameId="rom-weaver-input-output-file-name"
          fileNamePlaceholder="Output filename (no extension)"
          format={outputState.compressionFormat}
          formatId="rom-weaver-select-output-format"
          formatOptions={outputState.options}
          onFileNameChange={(value) => controllers.output.setDisplayFileName(value)}
          onFormatChange={(value) => controllers.output.setOutputCompression(value)}
        />
        <SectionNotice state={uiState.outputNotice} />
      </StepSection>

      <SharedArchiveDialog controller={controllers.dialog} />
    </main>
  );
}

export { ApplyWorkflowFormView };
