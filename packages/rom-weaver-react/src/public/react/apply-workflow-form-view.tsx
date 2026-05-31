import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import CircleX from "lucide-react/dist/esm/icons/circle-x.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import Upload from "lucide-react/dist/esm/icons/upload.js";
import { type DragEvent, useRef, useState, useSyncExternalStore } from "react";
import {
  PatcherFileStack,
  PatcherFileStackRemoveButton,
  PatcherFileStackRow,
  PatcherPatchStackRows,
} from "./components/patcher-file-stack.tsx";
import { PatcherOutputControls, PatcherPrimaryAction } from "./components/patcher-output-controls.tsx";
import { getFileInputAcceptAttributes } from "./file-input-accept";
import type {
  BinarySource,
  DialogController,
  NoticeController,
  PatcherOutputController,
  PatcherStackController,
  PatcherUiController,
  StartupState,
} from "./patcher-form.ts";
import { inertUiController } from "./patcher-form-session.ts";
import {
  fileInputClassName,
  InfoToggle,
  patchUploadCellClassName,
  patchUploadRowClassName,
  SectionNotice,
  SectionTiming,
  ArchiveDialog as SharedArchiveDialog,
  InputProgress as SharedInputProgress,
  RuntimeNotice as SharedRuntimeNotice,
} from "./patcher-react-shared.tsx";
import type { RomInputRowState } from "./patcher-ui-state.ts";
import {
  buttonClasses,
  cx,
  formClasses,
  layoutClasses,
  noticeClasses,
  patchStackClasses,
  rowClasses,
  sectionClasses,
  textClasses,
  uploadClasses,
} from "./tailwind-classes";

function UploadIcon({ className }: { className: string }) {
  return <Upload aria-hidden="true" className={className} />;
}

function NoticeIcon({ level, className }: { level?: string; className: string }) {
  if (level === "warning") {
    return <TriangleAlert aria-hidden="true" className={className} />;
  }
  return <CircleX aria-hidden="true" className={className} />;
}

const renderRuntimeNoticeIcon = (level: string, className: string) => (
  <NoticeIcon className={className} level={level} />
);
const InputProgress = SharedInputProgress;
const TRAILING_COLON_REGEX = /:\s*$/;
const normalizeLabel = (value: string) => value.replace(TRAILING_COLON_REGEX, "").trim();
const normalizeSecondsUnit = (value: string) =>
  value
    .replace(/\bseconds?\b/gi, "s")
    .replace(/\bsec\b/gi, "s")
    .replace(/(\d)\s*S\b/g, "$1s");

function RuntimeNotice({
  controller,
  rowId,
  messageId,
}: {
  controller?: NoticeController;
  rowId: string;
  messageId: string;
}) {
  return (
    <SharedRuntimeNotice
      controller={controller}
      messageId={messageId}
      renderIcon={renderRuntimeNoticeIcon}
      rowId={rowId}
    />
  );
}

const ArchiveDialog = ({ controller }: { controller?: DialogController }) => (
  <SharedArchiveDialog controller={controller} />
);

type FileSystemDropItem = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<unknown>;
};

const isDroppedFileHandle = (source: unknown): source is FileSystemFileHandle =>
  typeof source === "object" &&
  source !== null &&
  (source as { kind?: unknown }).kind === "file" &&
  typeof (source as { getFile?: unknown }).getFile === "function";

const getInputEventSourceKind = (source: unknown) => {
  if (typeof File !== "undefined" && source instanceof File) return "file";
  if (typeof Blob !== "undefined" && source instanceof Blob) return "blob";
  if (isDroppedFileHandle(source)) return "file-handle";
  if (source && typeof source === "object") return "object";
  return typeof source;
};

const getInputEventSourceSummary = (source: BinarySource | null | undefined) => ({
  kind: getInputEventSourceKind(source),
  name:
    source && "name" in source && typeof (source as { name?: unknown }).name === "string"
      ? (source as { name: string }).name
      : "",
  size: source instanceof File ? source.size : undefined,
});

const emitInputEventTrace = (message: string, details?: Record<string, unknown>) => {
  if (typeof console === "undefined") return;
  const log = typeof console.debug === "function" ? console.debug : console.log;
  log.call(console, `[rom-weaver trace] apply-form: ${message}`, details || {});
};

const getDroppedBinarySources = async (dataTransfer: DataTransfer): Promise<BinarySource[]> => {
  const itemSources = await Promise.all(
    Array.from(dataTransfer.items || []).map(async (item) => {
      const dropItem = item as FileSystemDropItem;
      const handle = dropItem.getAsFileSystemHandle ? await dropItem.getAsFileSystemHandle().catch(() => null) : null;
      if (isDroppedFileHandle(handle)) return handle;
      return item.kind === "file" ? item.getAsFile() : null;
    }),
  );
  const sources = itemSources.filter(
    (source): source is BinarySource => source instanceof File || isDroppedFileHandle(source),
  );
  return sources.length ? sources : Array.from(dataTransfer.files || []);
};

function RomInfoMetaRow({
  id,
  label,
  rowClassName,
  spanId,
  valueContainerClassName,
  valueClassName,
  value,
  visible,
}: {
  id?: string;
  label: string;
  rowClassName?: string;
  spanId: string;
  valueContainerClassName?: string;
  valueClassName?: string;
  value?: string | number | null;
  visible?: boolean;
}) {
  const baseRowClass = rowClassName || textClasses.metaRow;
  const className =
    visible === undefined
      ? baseRowClass
      : (() => {
          if (visible) {
            return cx("show", baseRowClass);
          }
          return "hidden";
        })();
  return (
    <div className={className} id={id}>
      <div className={textClasses.metaRowLabel}>{normalizeLabel(label)}</div>
      <div className={valueContainerClassName || [textClasses.metaRowValue, textClasses.truncate].join(" ")}>
        <span className={valueClassName} id={spanId}>
          {value}
        </span>
      </div>
    </div>
  );
}

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
  startup?: StartupState;
}) {
  const uiController = controllers.ui || inertUiController;
  const uiState = useSyncExternalStore(uiController.subscribe, uiController.getState, uiController.getState);
  const startupIsError = startup.status === "error";
  const startupVisible = startupIsError;
  const [romDragActive, setRomDragActive] = useState(false);
  const [patchDragActive, setPatchDragActive] = useState(false);
  const romInputRef = useRef<HTMLInputElement>(null);
  const patchInputRef = useRef<HTMLInputElement>(null);
  const fileInputAccept = getFileInputAcceptAttributes();
  const romInputs: RomInputRowState[] = uiState.romInputs.length
    ? uiState.romInputs
    : uiState.romInfo.fileName
      ? [
          {
            ...uiState.romInput,
            groupId: "",
            id: "input",
            info: {
              archiveName: uiState.romInfo.archiveName,
              checksumsExpanded: true,
              checksumTiming: uiState.sectionTimings.checksum,
              crc32: uiState.romInfo.crc32,
              fileName: uiState.romInfo.fileName,
              md5: uiState.romInfo.md5,
              romInfo: uiState.romInfo.romInfo,
              sha1: uiState.romInfo.sha1,
              validationPhase: uiState.romInfo.validationPhase,
            },
            kind: "",
            order: 0,
          },
        ]
      : [];
  const romInputUploadState = { ...uiState.romInput, progress: null };
  const patchInputUploadState = { ...uiState.patchInput, progress: null };
  const expandedChecksumCount = romInputs.filter((entry) => entry.info.checksumsExpanded).length;
  const shouldContainInputStack = romInputs.length + expandedChecksumCount > 4;
  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (event.dataTransfer?.types && Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
  };
  const handleRomDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setRomDragActive(false);
    emitInputEventTrace("rom drop received", {
      disabled: uiState.romInput.disabled,
      fileCount: event.dataTransfer.files?.length || 0,
      itemCount: event.dataTransfer.items?.length || 0,
      types: Array.from(event.dataTransfer.types || []),
    });
    if (uiState.romInput.disabled) {
      emitInputEventTrace("rom drop ignored", {
        reason: "disabled",
      });
      return;
    }
    void getDroppedBinarySources(event.dataTransfer)
      .then((sources) => {
        emitInputEventTrace("rom drop sources resolved", {
          sourceCount: sources.length,
          sources: sources.map((source) => getInputEventSourceSummary(source)),
        });
        uiController.provideRomInputFiles?.(sources.length ? sources : null);
      })
      .catch((error) => {
        emitInputEventTrace("rom drop source resolution failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  };
  const handlePatchDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setPatchDragActive(false);
    if (uiState.patchInput.disabled) return;
    void getDroppedBinarySources(event.dataTransfer).then((sources) => {
      if (sources.length) uiController.providePatchInputFiles?.(sources);
    });
  };
  const openRomInput = () => {
    emitInputEventTrace("rom input open requested", {
      disabled: uiState.romInput.disabled,
      hasInputElement: !!romInputRef.current,
    });
    if (uiState.romInput.disabled) {
      emitInputEventTrace("rom input open ignored", {
        reason: "disabled",
      });
      return;
    }
    if (!romInputRef.current) {
      emitInputEventTrace("rom input open ignored", {
        reason: "missing-input-element",
      });
      return;
    }
    romInputRef.current.click();
  };
  const openPatchInput = () => {
    if (!uiState.patchInput.disabled) patchInputRef.current?.click();
  };
  return (
    <div
      aria-labelledby="tab-patcher"
      className="grid items-start gap-4 font-['Inter_Tight','Segoe_UI',sans-serif]"
      id="rom-weaver-container"
      role="tabpanel"
    >
      <div
        aria-live={startupIsError ? "assertive" : "polite"}
        className={cx(
          startupVisible ? "show mb-0 flex" : "hidden",
          noticeClasses.startup,
          startupIsError ? noticeClasses.startupError : noticeClasses.startupLoading,
        )}
        id="rom-weaver-row-startup-status"
        role={startupIsError ? "alert" : "status"}
      >
        {startup.status === "loading" ? <span aria-hidden="true" className="rom-weaver-spinner" /> : null}
        <span id="rom-weaver-startup-status-message">
          {startup.message || (startupIsError ? "RomWeaver failed to load." : "Loading patcher tools...")}
        </span>
      </div>
      <div className={cx(rowClasses.upload, "mb-0 !block")} id="rom-weaver-row-file-rom">
        <div className={rowClasses.uploadLabel}>
          <label htmlFor="rom-weaver-input-file-rom">ROM</label>
        </div>
        <div className={cx("rom-weaver-container-input", layoutClasses.containerInputFill)}>
          <div className="px-0 pt-0 pb-1">
            <div className={cx("rom-weaver-input-section-header", sectionClasses.header, "mb-0")}>
              <div className={cx("rom-weaver-input-section-title", sectionClasses.title)}>
                <div className={sectionClasses.titleRow}>
                  <span data-localize="yes">Input</span>
                  <InfoToggle
                    ariaLabel="Show input archive behavior"
                    className="rom-weaver-input-info"
                    panelClassName={cx("rom-weaver-input-info-panel", sectionClasses.inputInfoPanel)}
                    portalPanel
                    title="Show input archive behavior"
                  >
                    <ul className="m-0 list-disc space-y-1 pl-4">
                      <li>
                        Supported archive formats are decompressed and we will automatically find the rom or give you a
                        choice.
                      </li>
                      <li>chd, rvz/wia/gcz, and z3ds files will be decompressed before patching.</li>
                      <li>Nested archives (7z in rar, chd in 7z, etc) are also handled.</li>
                      <li>
                        <a
                          className="font-semibold text-[var(--rom-weaver-color-primary)] underline underline-offset-2 hover:text-[var(--rom-weaver-color-primary-hover)] focus-visible:text-[var(--rom-weaver-color-primary-hover)]"
                          href="https://docs.libretro.com/guides/softpatching/"
                          rel="noreferrer"
                          target="_blank"
                        >
                          RetroArch softpatch format is supported.
                        </a>
                      </li>
                    </ul>
                  </InfoToggle>
                </div>
                <SectionTiming
                  className={sectionClasses.timingInline}
                  id="rom-weaver-section-timing-input"
                  value={uiState.sectionTimings.input}
                />
              </div>
            </div>
          </div>
          <input
            accept={fileInputAccept.rom}
            className={fileInputClassName(uiState.romInput)}
            disabled={uiState.romInput.disabled}
            id="rom-weaver-input-file-rom"
            onChange={(event) => {
              const selectedFiles = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
              const selectedFile = selectedFiles[0] || null;
              emitInputEventTrace("rom file input changed", {
                disabled: uiState.romInput.disabled,
                fileCount: event.currentTarget.files?.length || 0,
                source: getInputEventSourceSummary(selectedFile),
              });
              uiController.provideRomInputFiles?.(selectedFiles.length ? selectedFiles : null);
              event.currentTarget.value = "";
            }}
            ref={romInputRef}
            type="file"
          />
          <div>
            <div className={cx(shouldContainInputStack && "max-h-[min(72vh,640px)] overflow-y-auto")}>
              <PatcherFileStack
                ariaLabel="Selected ROM input"
                className="rom-weaver-input-stack !rounded-none !border-0"
                footer={
                  <tfoot>
                    <tr
                      aria-busy={uiState.romInput.disabled || undefined}
                      className={cx(
                        patchUploadRowClassName(romInputUploadState),
                        romDragActive && uploadClasses.patchRowDrag,
                      )}
                      id="rom-weaver-row-file-rom-upload"
                      onClick={(event) => {
                        const target = event.target as HTMLElement | null;
                        if (target?.closest("input,label,button,select,a,summary")) return;
                        event.preventDefault();
                        event.stopPropagation();
                        openRomInput();
                      }}
                      onDragEnter={() => setRomDragActive(true)}
                      onDragLeave={() => setRomDragActive(false)}
                      onDragOver={handleDragOver}
                      onDrop={handleRomDrop}
                      title={romInputs.length ? "Add ROM (will be decompressed)" : "Select ROM (will be decompressed)"}
                    >
                      <td
                        className={cx(
                          patchUploadCellClassName(romInputUploadState),
                          "rom-weaver-patch-stack-empty",
                          uploadClasses.patchEmptyCell,
                        )}
                        colSpan={2}
                      >
                        <label
                          className={cx(
                            "rom-weaver-rom-upload-label rom-weaver-patch-upload-label-inline-icon",
                            uploadClasses.patchLabel,
                          )}
                          data-localize="yes"
                          htmlFor="rom-weaver-input-file-rom"
                        >
                          <UploadIcon className={buttonClasses.icon} />
                          {romInputs.length ? "Add ROM (will be decompressed)" : "Select ROM (will be decompressed)"}
                        </label>
                      </td>
                    </tr>
                  </tfoot>
                }
                id="rom-weaver-table-input-stack"
                listId="rom-weaver-list-input-stack"
              >
                {romInputs.map((romInput, index) => {
                  const showChecksumSection = romInput.kind !== "cue";
                  const checksumProgressActive =
                    showChecksumSection && !!romInput.progress && romInput.info.validationPhase === "checksum";
                  const archiveName =
                    romInput.info.archiveName && romInput.info.archiveName !== "-" ? romInput.info.archiveName : "";
                  const checksumDetailsId =
                    index === 0 ? "rom-weaver-checksum-details" : `rom-weaver-checksum-details-${index + 1}`;
                  return (
                    <PatcherFileStackRow
                      archiveFileName={archiveName}
                      archivePathEntries={romInput.archivePathEntries}
                      className="rom-weaver-input-stack-item"
                      controls={
                        <PatcherFileStackRemoveButton
                          ariaLabel={romInputs.length > 1 ? `Remove ROM input ${index + 1}` : "Clear ROM input"}
                          onClick={() => {
                            if (romInputs.length === 1 && uiController.clearRomInput) uiController.clearRomInput();
                            else uiController.removeRomInput?.(romInput.id);
                          }}
                          title={romInputs.length > 1 ? "Remove ROM input" : "Clear ROM input"}
                        />
                      }
                      fileClassName="rom-weaver-input-stack-file"
                      fileName={romInput.info.fileName}
                      fileSize={romInput.size ?? romInput.sourceSize}
                      key={romInput.id}
                      nameClassName="rom-weaver-input-stack-name"
                    >
                      <div
                        className={cx(
                          "overflow-hidden transition-[max-height,opacity,margin] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
                          romInput.progress && !checksumProgressActive
                            ? "mt-2 max-h-[52px] opacity-100"
                            : "mt-0 max-h-0 opacity-0",
                        )}
                      >
                        <div className="relative min-h-[calc(var(--rom-weaver-control-height)-2px)]">
                          {romInput.progress && !checksumProgressActive ? (
                            <InputProgress
                              id={index === 0 ? "rom-weaver-progress-rom" : `rom-weaver-progress-rom-${index + 1}`}
                              progress={romInput.progress}
                            />
                          ) : null}
                        </div>
                      </div>
                      {showChecksumSection ? (
                        <div
                          aria-busy={checksumProgressActive || undefined}
                          className="rom-weaver-checksum-section mt-2 border-t border-[var(--rom-weaver-color-border)] pt-2 font-['Inter_Tight','Segoe_UI',sans-serif] text-[11px] leading-[1.32] tracking-[0.01em] text-[var(--rom-weaver-color-muted)]"
                          id={index === 0 ? "rom-weaver-rom-info" : `rom-weaver-rom-info-${index + 1}`}
                        >
                          <div className="mb-1 flex items-center gap-3">
                            <button
                              aria-controls={checksumDetailsId}
                              aria-expanded={romInput.info.checksumsExpanded ? "true" : "false"}
                              className="inline-flex items-center gap-1.5 rounded-[8px] pl-0 pr-1 py-1 text-left text-[10px] font-semibold tracking-[0.045em] text-[var(--rom-weaver-color-text-soft)] uppercase transition-colors hover:bg-[var(--rom-weaver-color-surface-muted)]"
                              onClick={() => uiController.toggleRomInputChecksums?.(romInput.id)}
                              type="button"
                            >
                              {romInput.info.checksumsExpanded ? (
                                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                              )}
                              <span>Checksums</span>
                              <SectionTiming
                                className={cx(textClasses.mono, "!flex-none")}
                                id={
                                  index === 0
                                    ? "rom-weaver-section-timing-checksum"
                                    : `rom-weaver-section-timing-checksum-${index + 1}`
                                }
                                value={normalizeSecondsUnit(romInput.info.checksumTiming)}
                              />
                            </button>
                          </div>
                          <div
                            className={cx(
                              "overflow-hidden transition-[max-height,opacity] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]",
                              romInput.info.checksumsExpanded ? "max-h-[440px] opacity-100" : "max-h-0 opacity-0",
                            )}
                            id={checksumDetailsId}
                          >
                            <div className="pt-1 space-y-1">
                              <div
                                className={cx(
                                  "grid max-w-full items-start gap-3",
                                  checksumProgressActive ? "grid-cols-[max-content_minmax(0,1fr)]" : "grid-cols-1",
                                )}
                              >
                                <div className={cx("min-w-0", checksumProgressActive && "w-fit max-w-[272px]")}>
                                  <RomInfoMetaRow
                                    label="CRC32"
                                    rowClassName="mb-[3px] grid grid-cols-[52px_minmax(0,1fr)] items-baseline gap-x-[6px] last:mb-0"
                                    spanId={
                                      index === 0 ? "rom-weaver-span-crc32" : `rom-weaver-span-crc32-${index + 1}`
                                    }
                                    value={romInput.info.crc32}
                                    valueClassName="font-semibold tabular-nums text-[var(--rom-weaver-color-text)]"
                                    valueContainerClassName={textClasses.checksumValue}
                                  />
                                  <RomInfoMetaRow
                                    label="MD5"
                                    rowClassName="mb-[3px] grid grid-cols-[52px_minmax(0,1fr)] items-baseline gap-x-[6px] last:mb-0"
                                    spanId={index === 0 ? "rom-weaver-span-md5" : `rom-weaver-span-md5-${index + 1}`}
                                    value={romInput.info.md5}
                                    valueClassName="font-semibold tabular-nums text-[var(--rom-weaver-color-text)]"
                                    valueContainerClassName={textClasses.checksumValue}
                                  />
                                  <RomInfoMetaRow
                                    label="SHA-1"
                                    rowClassName="mb-[3px] grid grid-cols-[52px_minmax(0,1fr)] items-baseline gap-x-[6px] last:mb-0"
                                    spanId={index === 0 ? "rom-weaver-span-sha1" : `rom-weaver-span-sha1-${index + 1}`}
                                    value={romInput.info.sha1}
                                    valueClassName="font-semibold tabular-nums text-[var(--rom-weaver-color-text)]"
                                    valueContainerClassName={textClasses.checksumValue}
                                  />
                                </div>
                                {checksumProgressActive ? (
                                  <div className="min-w-0 pt-[2px]">
                                    <div className="relative min-h-[calc(var(--rom-weaver-control-height)-2px)]">
                                      <InputProgress
                                        id={
                                          index === 0
                                            ? "rom-weaver-progress-checksum"
                                            : `rom-weaver-progress-checksum-${index + 1}`
                                        }
                                        progress={romInput.progress}
                                      />
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                              <RomInfoMetaRow
                                id={index === 0 ? "rom-weaver-row-info-rom" : `rom-weaver-row-info-rom-${index + 1}`}
                                label="ROM"
                                spanId={
                                  index === 0 ? "rom-weaver-span-rom-info" : `rom-weaver-span-rom-info-${index + 1}`
                                }
                                value={romInput.info.romInfo}
                                visible={!!romInput.info.romInfo}
                              />
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </PatcherFileStackRow>
                  );
                })}
              </PatcherFileStack>
            </div>
            <div className="px-0 pt-0 pb-0">
              <SectionNotice
                id="rom-weaver-row-input-notice"
                messageId="rom-weaver-input-notice-message"
                renderIcon={renderRuntimeNoticeIcon}
                state={uiState.inputNotice}
              />
              <SectionNotice
                id="rom-weaver-row-checksum-notice"
                messageId="rom-weaver-checksum-notice-message"
                renderIcon={renderRuntimeNoticeIcon}
                state={uiState.checksumNotice}
              />
              {uiState.chdSplitBin.visible ? (
                <div
                  className="show rom-weaver-chd-split-bin mt-2 block text-[13px] text-[var(--rom-weaver-color-text)]"
                  id="rom-weaver-row-chd-split-bin"
                >
                  <label>
                    <input
                      checked={uiState.chdSplitBin.checked}
                      className={formClasses.checkbox}
                      disabled={uiState.chdSplitBin.disabled}
                      id="rom-weaver-checkbox-chd-split-bin"
                      onChange={(event) => uiController.setChdSplitBin?.(event.currentTarget.checked)}
                      type="checkbox"
                    />{" "}
                    <span data-localize="yes">{uiState.chdSplitBin.label}</span>
                  </label>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <div
        className={cx(
          rowClasses.base,
          rowClasses.source,
          "mb-0 !block border-t border-[var(--rom-weaver-color-border)] pt-3",
        )}
        id="rom-weaver-row-patch-stack"
      >
        <div className={rowClasses.uploadLabel}>
          <label htmlFor="rom-weaver-input-file-patch">Patch</label>
        </div>
        <div className={cx("rom-weaver-container-input", layoutClasses.containerInputFill)}>
          <div className={cx("rom-weaver-patch-section-header", sectionClasses.header)}>
            <div className={cx("rom-weaver-patch-section-title", sectionClasses.title)}>
              <div className={sectionClasses.titleRow}>
                <span data-localize="yes">Patches</span>
                <InfoToggle
                  ariaLabel="Show supported patch types"
                  className="rom-weaver-patch-info"
                  panelClassName={cx("rom-weaver-patch-info-panel", sectionClasses.patchInfoPanel)}
                  portalPanel
                  title="Show supported patch types"
                >
                  <ul className="m-0 list-disc space-y-1 pl-4">
                    <li>
                      Supported patch formats: IPS, IPS32, SOLID, BPS, UPS, VCDIFF, xdelta, GDIFF, HDiffPatch/HPatchZ,
                      APS (N64), APSGBA, RUP, PPF, PAT/FFP, EBP, BDF/BSDIFF40, BSP, MOD/PMSR, DLDI, and DPS.
                    </li>
                    <li>NINJA1 headers are recognized, but NINJA1 patch apply is not supported.</li>
                    <li>PDS patch files are explicitly unsupported.</li>
                    <li>
                      HDiffPatch directory patches (HDIFF19) are unsupported; single-file .hdiff/.hpatchz is supported.
                    </li>
                    <li>Patches can be decompressed and chosen from supported archive formats.</li>
                    <li>Nested archives (7z in rar, rar in zip, etc) are supported.</li>
                  </ul>
                </InfoToggle>
              </div>
              <SectionTiming id="rom-weaver-section-timing-patch" value={uiState.sectionTimings.patch} />
            </div>
          </div>
          <PatcherFileStack
            ariaLabel="Selected patches"
            className={cx("rom-weaver-patch-stack", patchStackClasses.table)}
            footer={
              <tfoot>
                <tr
                  aria-busy={uiState.patchInput.disabled || undefined}
                  className={cx(
                    patchUploadRowClassName(patchInputUploadState),
                    patchDragActive && uploadClasses.patchRowDrag,
                  )}
                  id="rom-weaver-row-file-patch"
                  onClick={(event) => {
                    const target = event.target as HTMLElement | null;
                    if (target?.closest("input,label,button,select,a,summary")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    openPatchInput();
                  }}
                  onDragEnter={() => setPatchDragActive(true)}
                  onDragLeave={() => setPatchDragActive(false)}
                  onDragOver={handleDragOver}
                  onDrop={handlePatchDrop}
                  title="Select Patch (will be decompressed)"
                >
                  <td
                    className={cx(
                      patchUploadCellClassName(patchInputUploadState),
                      "rom-weaver-patch-stack-empty",
                      uploadClasses.patchEmptyCell,
                    )}
                    colSpan={2}
                  >
                    <label
                      className={cx(
                        "rom-weaver-patch-upload-label rom-weaver-patch-upload-label-inline-icon",
                        uploadClasses.patchLabel,
                      )}
                      data-localize="yes"
                      htmlFor="rom-weaver-input-file-patch"
                    >
                      <UploadIcon className={buttonClasses.icon} />
                      Select Patch (will be decompressed)
                    </label>
                    <input
                      accept={fileInputAccept.patch}
                      className={fileInputClassName(uiState.patchInput)}
                      disabled={uiState.patchInput.disabled}
                      id="rom-weaver-input-file-patch"
                      onChange={(event) => {
                        uiController.providePatchInputFiles?.(event.currentTarget.files);
                        event.currentTarget.value = "";
                      }}
                      ref={patchInputRef}
                      type="file"
                    />
                  </td>
                </tr>
              </tfoot>
            }
            id="rom-weaver-table-patch-stack"
            listId="rom-weaver-list-patch-stack"
          >
            <PatcherPatchStackRows controller={controllers.patchStack} />
          </PatcherFileStack>
          {uiState.patchInput.embeddedPatchLoadingVisible ? (
            <span id="rom-weaver-span-loading-embedded-patch">{uiState.patchInput.embeddedPatchLoadingMessage}</span>
          ) : (
            <span className="hidden" id="rom-weaver-span-loading-embedded-patch" />
          )}
          {uiState.patchInput.embeddedPatchOptions.length ? (
            <select
              className={cx(
                formClasses.select,
                uiState.patchInput.embeddedPatchMode === "single" && "bg-transparent bg-none pl-0 text-inherit",
              )}
              disabled={uiState.patchInput.embeddedPatchDisabled}
              id="rom-weaver-select-patch"
              onChange={(event) => uiController.selectEmbeddedPatch?.(event.currentTarget.value)}
              value={uiState.patchInput.embeddedPatchValue}
            >
              {uiState.patchInput.embeddedPatchOptions.map((option: { value: string; label: string }) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <select className="hidden" id="rom-weaver-select-patch" />
          )}
          <div
            className={uiState.patchInput.optionalPatches.length ? "block" : "hidden"}
            id="rom-weaver-container-optional-patches"
          >
            {uiState.patchInput.optionalPatches.map(
              (option: { id: string; label: string; description: string; checked: boolean; disabled: boolean }) => (
                <label className="block text-left" key={option.id} title={option.description || undefined}>
                  <input
                    checked={option.checked}
                    className={formClasses.checkbox}
                    disabled={option.disabled}
                    onChange={(event) => uiController.setOptionalPatch?.(option.id, event.currentTarget.checked)}
                    type="checkbox"
                  />
                  {option.label}
                </label>
              ),
            )}
          </div>
          <SectionNotice
            id="rom-weaver-row-patch-notice"
            messageId="rom-weaver-patch-notice-message"
            renderIcon={renderRuntimeNoticeIcon}
            state={uiState.patchNotice}
          />
        </div>
      </div>
      <div
        className={
          uiState.patchDetails.description
            ? cx(
                "show",
                "mb-0 !block border-t border-[var(--rom-weaver-color-border)] pt-2 text-[var(--rom-weaver-color-text-soft)]",
              )
            : "hidden"
        }
        id="rom-weaver-row-patch-description"
      >
        <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--rom-weaver-color-text-soft)]">
          Description
        </div>
        <div className={cx(textClasses.truncate, "text-[85%]")} id="rom-weaver-patch-description">
          {uiState.patchDetails.description}
        </div>
      </div>
      <div
        className={
          uiState.patchDetails.requirementsValue
            ? cx(
                "show",
                textClasses.selectable,
                textClasses.mono,
                "mb-0 !block border-t border-[var(--rom-weaver-color-border)] pt-2",
              )
            : "hidden"
        }
        id="rom-weaver-row-patch-requirements"
      >
        <div
          className="mb-1 text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--rom-weaver-color-text-soft)]"
          id="rom-weaver-patch-requirements-type"
        >
          {normalizeLabel(uiState.patchDetails.requirementsLabel)}
        </div>
        <div className={cx(textClasses.truncate)} id="rom-weaver-patch-requirements-value">
          {uiState.patchDetails.requirementsValue}
        </div>
      </div>
      <div className={cx(rowClasses.output, "mb-0 !block")} id="rom-weaver-row-output-file-name">
        <div className={rowClasses.outputLabel}>
          <div className={sectionClasses.title}>
            <div className={sectionClasses.titleRow}>
              <label data-localize="yes" htmlFor="rom-weaver-input-output-file-name">
                Output
              </label>
            </div>
            <SectionTiming
              className={sectionClasses.timingInline}
              id="rom-weaver-section-timing-output"
              value={uiState.sectionTimings.output}
            />
          </div>
          <SectionNotice
            id="rom-weaver-row-output-notice"
            messageId="rom-weaver-output-notice-message"
            renderIcon={renderRuntimeNoticeIcon}
            state={uiState.outputNotice}
          />
        </div>
        <div className={rowClasses.outputValue}>
          <PatcherOutputControls controller={controllers.output} />
        </div>
      </div>
      <div
        className={cx(
          layoutClasses.spacedStack,
          "mt-0 border-t border-[var(--rom-weaver-color-border)] pt-3 text-left",
        )}
      >
        <div
          className={
            uiState.romInfo.alterHeaderVisible
              ? cx("show", "mb-3 text-[13px] text-[var(--rom-weaver-color-text)]")
              : "hidden"
          }
          id="rom-weaver-row-alter-header"
        >
          <label>
            <input
              checked={uiState.romInfo.alterHeaderChecked}
              className={formClasses.checkbox}
              disabled={uiState.romInfo.alterHeaderDisabled}
              id="rom-weaver-checkbox-alter-header"
              onChange={(event) => uiController.setAlterHeader?.(event.currentTarget.checked)}
              type="checkbox"
            />{" "}
            <span id="rom-weaver-span-alter-header">{uiState.romInfo.alterHeaderLabel}</span>
          </label>
        </div>
        <RuntimeNotice
          controller={controllers.notice}
          messageId="rom-weaver-error-message"
          rowId="rom-weaver-row-error-message"
        />
        <div
          className={
            uiState.checksumOverride.visible
              ? "show rom-weaver-checksum-override mb-2 block text-[90%] text-[var(--rom-weaver-color-danger)]"
              : "hidden"
          }
          id="rom-weaver-row-checksum-override"
        >
          <label>
            <input
              checked={uiState.checksumOverride.checked}
              className={formClasses.checkbox}
              disabled={uiState.checksumOverride.disabled}
              id="rom-weaver-checkbox-checksum-override"
              onChange={(event) => uiController.setChecksumOverride?.(event.currentTarget.checked)}
              type="checkbox"
            />{" "}
            <span data-localize="yes">{uiState.checksumOverride.label}</span>
          </label>
        </div>
        <div
          className={
            uiState.outputChecksumWarning.visible
              ? "show rom-weaver-output-checksum-warning mb-2 block text-[90%] text-[var(--rom-weaver-color-danger)]"
              : "hidden"
          }
          id="rom-weaver-row-output-checksum-warning"
        >
          <div className="mb-1" id="rom-weaver-output-checksum-warning-message">
            {uiState.outputChecksumWarning.message}
          </div>
          <label>
            <input
              checked={uiState.outputChecksumWarning.checked}
              className={formClasses.checkbox}
              disabled={uiState.outputChecksumWarning.disabled}
              id="rom-weaver-checkbox-output-checksum-override"
              onChange={(event) => uiController.setOutputChecksumOverride?.(event.currentTarget.checked)}
              type="checkbox"
            />{" "}
            <span data-localize="yes">{uiState.outputChecksumWarning.label}</span>
          </label>
        </div>
        <PatcherPrimaryAction controller={controllers.output} />
        <button
          className={cx(buttonClasses.primary, buttonClasses.secondary, !uiState.cueDownload.visible && "!hidden")}
          disabled={uiState.cueDownload.disabled}
          id="rom-weaver-button-download-cue"
          onClick={() => uiController.downloadCue?.()}
          title={uiState.cueDownload.title}
          type="button"
        >
          <FileText aria-hidden="true" className={buttonClasses.icon} />
          {uiState.cueDownload.label}
        </button>
      </div>
      <ArchiveDialog controller={controllers.dialog} />
    </div>
  );
}

export { ApplyWorkflowFormView };
