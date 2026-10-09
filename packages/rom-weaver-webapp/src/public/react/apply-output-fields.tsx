import { Download, Share2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  postApplyDownloadBehaviorOption,
  postApplyTestBehaviorOption,
  POST_APPLY_DOWNLOAD_BEHAVIOR_OPTIONS,
  POST_APPLY_TEST_BEHAVIOR_OPTIONS,
} from "../../lib/apply/post-apply-behavior.ts";
import type { BrowserApplyResult } from "../../platform/browser/browser-api.ts";
import type { ProgressViewModel } from "../../presentation/workflow-presentation.ts";
import type { RomCheckActuals } from "./apply-patch-input-checks.ts";
import { DropdownSelect } from "./components/ds/dropdown-select.tsx";
import { FieldInfoToggle } from "./components/ds/compress-panel.tsx";
import { Drawer, DrawerReadout } from "./components/ds/drawer.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { OutputField } from "./components/ds/output-card.tsx";
import { WorkflowOutputStep } from "./components/ds/workflow-output-step.tsx";
import { PatcherPrimaryAction } from "./components/patcher-output-controls.tsx";
import { ProgressActionButton } from "./components/progress-action-button.tsx";
import type { NoticeController, PatcherOutputController, PatcherUiController } from "./patcher-form.ts";
import type { PatcherOutputState, PatchStackItemState } from "./patcher-presentation.ts";
import type { NoticeState, RomInputRowState } from "./patcher-ui-state.ts";
import { useRomWeaverSettings, useUiLocalizer } from "./settings-context.tsx";
import {
  setPostApplyDownloadBehaviorOverride,
  setPostApplyTestBehaviorOverride,
  usePostApplyDownloadBehaviorValue,
  usePostApplyTestBehaviorValue,
} from "./use-apply-download-orchestration.ts";
import type { PostApplyActionBehavior } from "../../types/settings.ts";
import { EmulatorJsAction } from "./apply-emulatorjs-action.tsx";

/** Weave-related notices and export reveal state, threaded from the form. */
export type WeaveToolsState = {
  /** Persist the weave package choice, synced to user settings. */
  setWeavePackage: (value: string) => void;
  /** The run has optional entries (or patches toggled off): output checks only
   * describe the full chain. */
  hasOptionalEntries: boolean;
  /** Why the woven final result won't be verified against an expected output;
   * null when it will be, or when nothing declares an output. */
  outputVerification: { level: "warn"; message: string } | null;
};

export type WeaveExportState = {
  weaveRom: boolean;
  busy: boolean;
  cancelExport: () => void;
  downloadable: boolean;
  error: string;
  format: string;
  progress: ProgressViewModel | null;
  ready: boolean;
  runExport: () => Promise<void>;
  setWeaveRom: (value: boolean) => void;
  setFormat: (value: string) => void;
};
export const OutputHeaderField = ({
  disabled,
  headeredExtension,
  headerlessExtension,
  id = "rom-weaver-select-output-header",
  onChange,
  retained,
  value,
  visible,
}: {
  disabled: boolean;
  headeredExtension?: string;
  headerlessExtension?: string;
  id?: string;
  onChange: (value: "auto" | "keep" | "strip") => void;
  retained: boolean;
  value?: "auto" | "keep" | "strip";
  visible: boolean;
}) => {
  const localizer = useUiLocalizer();
  if (!visible) return null;
  const extensionsDiffer = !!headeredExtension && !!headerlessExtension && headeredExtension !== headerlessExtension;
  const info = {
    items: [
      localizer.message(retained ? "ui.apply.header.autoRetain" : "ui.apply.header.autoStrip"),
      localizer.message("ui.apply.header.keepInfo"),
      localizer.message("ui.apply.header.stripInfo"),
      ...(extensionsDiffer
        ? [localizer.message("ui.apply.header.extensionInfo", { headeredExtension, headerlessExtension })]
        : []),
    ],
    summary: localizer.message("ui.apply.header.summary"),
    title: localizer.message("ui.apply.header.title"),
  };
  return (
    <OutputField
      label={localizer.message("ui.apply.header.title")}
      labelInfo={<FieldInfoToggle info={info} label={localizer.message("ui.apply.header.title")} />}
    >
      <DropdownSelect
        aria-label={localizer.message("ui.apply.header.title")}
        className="select"
        disabled={disabled}
        id={id}
        onChange={(event) => onChange(event.currentTarget.value as "auto" | "keep" | "strip")}
        value={value || "auto"}
      >
        <option value="auto">
          {localizer.message(retained ? "ui.apply.header.autoKeep" : "ui.apply.header.autoStripOption")}
        </option>
        <option value="keep">{localizer.message("ui.apply.header.keep")}</option>
        <option value="strip">{localizer.message("ui.apply.header.strip")}</option>
      </DropdownSelect>
    </OutputField>
  );
};

const PostApplyActionField = ({
  disabled,
  id,
  label,
  onChange,
  options,
  value,
}: {
  disabled: boolean;
  id: string;
  label: string;
  onChange: (value: PostApplyActionBehavior) => void;
  options: readonly { label: string; value: PostApplyActionBehavior }[];
  value: PostApplyActionBehavior;
}) => {
  return (
    <OutputField label={label}>
      <DropdownSelect
        aria-label={label}
        className="select"
        disabled={disabled}
        id={id}
        onChange={(event) => onChange(event.currentTarget.value as PostApplyActionBehavior)}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </DropdownSelect>
    </OutputField>
  );
};

/** These fields override the read-only host settings for the current Apply session. */
export const PostApplyBehaviorFields = ({
  disabled,
  downloadSetting,
  testSetting,
}: {
  disabled: boolean;
  downloadSetting: unknown;
  testSetting: unknown;
}) => {
  const localizer = useUiLocalizer();
  const downloadValue = usePostApplyDownloadBehaviorValue(downloadSetting);
  const testValue = usePostApplyTestBehaviorValue(testSetting);
  return (
    <div className="post-apply-fields">
      <PostApplyActionField
        disabled={disabled}
        id="rom-weaver-select-post-apply-download"
        label={localizer.message("ui.apply.postDownload")}
        onChange={setPostApplyDownloadBehaviorOverride}
        options={POST_APPLY_DOWNLOAD_BEHAVIOR_OPTIONS}
        value={downloadValue}
      />
      <PostApplyActionField
        disabled={disabled}
        id="rom-weaver-select-post-apply-test"
        label={localizer.message("ui.apply.postTest")}
        onChange={setPostApplyTestBehaviorOverride}
        options={POST_APPLY_TEST_BEHAVIOR_OPTIONS}
        value={testValue}
      />
    </div>
  );
};

/** Export while running shows the live bar; otherwise the create/download button. */
const WeaveExportAction = ({
  weaveActionLabel,
  weaveExport,
  disabled,
}: {
  weaveActionLabel: string;
  weaveExport: WeaveExportState;
  disabled: boolean;
}) => {
  const localizer = useUiLocalizer();
  if (weaveExport.busy) {
    return (
      <ProgressActionButton
        cancelLabel={localizer.message("ui.apply.cancelWeaveExport")}
        disabled
        label={weaveActionLabel}
        onCancel={weaveExport.cancelExport}
        onClick={() => undefined}
        progress={weaveExport.progress}
        progressId="rom-weaver-weave-export-progress"
      />
    );
  }
  return (
    <button
      className="btn primary slim weave-share"
      data-downloadable={weaveExport.downloadable || undefined}
      disabled={disabled}
      id="rom-weaver-button-export-weave"
      onClick={() => void weaveExport.runExport()}
      type="button"
    >
      {weaveExport.downloadable ? <Download aria-hidden="true" /> : <Share2 aria-hidden="true" />}
      {weaveActionLabel}
    </button>
  );
};

const ApplyErrorNotice = ({
  notice,
  noticeController,
}: {
  notice: NoticeState | null;
  noticeController?: NoticeController;
}) => {
  if (!notice?.visible) return null;
  return (
    <Notice
      id="rom-weaver-row-error-message"
      level={notice.level === "warning" ? "warn" : "error"}
      onDismiss={notice.dismissible ? () => noticeController?.dismiss?.() : undefined}
    >
      {notice.message}
    </Notice>
  );
};

const ChecksumOverrideRow = ({
  state,
  uiController,
}: {
  state: ReturnType<PatcherUiController["getState"]>["checksumOverride"];
  uiController: PatcherUiController;
}) => {
  const localizer = useUiLocalizer();
  if (!state.visible) return null;
  return (
    <label className="checkrow warn">
      <input
        checked={state.checked}
        disabled={state.disabled}
        id="rom-weaver-checkbox-checksum-override"
        onChange={(event) => uiController.setChecksumOverride?.(event.currentTarget.checked)}
        type="checkbox"
      />
      <span>{localizer.message("ui.apply.validation.overrideChecksum")}</span>
    </label>
  );
};

export const ApplyOutputAction = ({
  applyTotalTime,
  weaveTools,
  weaveVerificationError,
  cheatHeaderStripConflict,
  controllers,
  disabledPatchCount,
  enabledPatchCount,
  emulatorCore,
  emulatorFileName,
  emulatorPlatform,
  emulatorOutput,
  errorNotice,
  localizer,
  noticeController,
  onSelectView,
  outputState,
  patches,
  uiController,
  uiState,
}: {
  applyTotalTime: PatcherOutputState["totalTiming"];
  weaveTools?: WeaveToolsState;
  weaveVerificationError: string | null;
  /** Cheats are On while a header strip is pinned - Apply stays blocked. */
  cheatHeaderStripConflict: string;
  controllers: { output: PatcherOutputController };
  disabledPatchCount: number;
  enabledPatchCount: number;
  emulatorCore?: string;
  emulatorFileName?: string;
  emulatorPlatform?: string;
  emulatorOutput?: BrowserApplyResult["output"] | null;
  onSelectView?: (view: "test") => void;
  errorNotice: NoticeState | null;
  localizer: ReturnType<typeof useUiLocalizer>;
  noticeController?: NoticeController;
  outputState: PatcherOutputState;
  patches: PatchStackItemState[];
  uiController: PatcherUiController;
  uiState: ReturnType<PatcherUiController["getState"]>;
}) => {
  const settings = useRomWeaverSettings();
  const postApplyDownloadBehavior = usePostApplyDownloadBehaviorValue(settings.postApplyDownloadBehavior);
  const postApplyTestBehavior = usePostApplyTestBehaviorValue(settings.postApplyTestBehavior);
  const postApplyDownloadOption = postApplyDownloadBehaviorOption(postApplyDownloadBehavior);
  const postApplyTestOption = postApplyTestBehaviorOption(postApplyTestBehavior);
  const showDownloadFallback = !emulatorCore && (postApplyTestOption.visible || postApplyTestOption.automatic);
  return (
    <>
      <ApplyErrorNotice notice={errorNotice} noticeController={noticeController} />
      <ChecksumOverrideRow state={uiState.checksumOverride} uiController={uiController} />
      <div className={disabledPatchCount ? "reveal is-open" : "reveal"} hidden={!disabledPatchCount}>
        <p aria-live="polite" className="patch-off-note">
          <TriangleAlert aria-hidden="true" />
          <span>{disabledPatchCount ? localizer.messageCount("ui.patch.offCount", disabledPatchCount) : ""}</span>
        </p>
      </div>
      <PatcherPrimaryAction
        controller={controllers.output}
        disableRun={
          (patches.length > 0 && enabledPatchCount === 0) || !!weaveVerificationError || !!cheatHeaderStripConflict
        }
        showCompletedDownload={postApplyDownloadOption.visible || showDownloadFallback}
        totalTime={applyTotalTime || undefined}
      />
      <EmulatorJsAction
        core={emulatorCore}
        fileName={emulatorFileName}
        onSelectView={onSelectView}
        output={outputState.pendingDownloadFileName ? emulatorOutput : null}
        platform={emulatorPlatform}
        shown={postApplyTestOption.visible}
      />
      {weaveVerificationError ? <Notice level="error">{weaveVerificationError}</Notice> : null}
      {weaveTools?.outputVerification ? (
        <p aria-live="polite" className="patch-off-note" id="rom-weaver-weave-output-unverified">
          <TriangleAlert aria-hidden="true" />
          <span>{weaveTools.outputVerification.message}</span>
        </p>
      ) : null}
    </>
  );
};

export const buildRomActualsById = (romInputs: RomInputRowState[]) => {
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

export const getWeaveActionLabel = (
  weaveExport: WeaveExportState | undefined,
  localizer: ReturnType<typeof useUiLocalizer>,
  downloadable: boolean,
) => {
  if (!downloadable) return weaveExport ? localizer.message("ui.weaveExport.share") : "";
  if (!weaveExport?.downloadable) return "";
  const formatValue = weaveExport.format || "zip";
  const formatName = formatValue === "7z" ? "7z" : formatValue.toUpperCase();
  const downloadKey = weaveExport.weaveRom ? "ui.weaveExport.downloadRom" : "ui.weaveExport.download";
  return localizer.message(downloadKey, { format: formatName });
};

const WeaveOutputFields = ({
  weaveExport,
  weaveTools,
}: {
  weaveExport?: WeaveExportState;
  weaveTools?: WeaveToolsState;
}) => {
  const localizer = useUiLocalizer();
  if (!weaveExport) return null;
  const setWeaveContents = (includeRom: boolean) => {
    weaveTools?.setWeavePackage(includeRom ? "rom" : "patches");
  };
  return (
    <div className="weave-job-fields">
      <div className="weave-rom-option">
        <label className="checkrow" htmlFor="rom-weaver-weave-export-weave-rom">
          <input
            checked={weaveExport.weaveRom}
            disabled={weaveExport.busy}
            id="rom-weaver-weave-export-weave-rom"
            onChange={(event) => setWeaveContents(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{localizer.message("ui.weaveExport.includeRom")}</span>
        </label>
      </div>
      {weaveExport.weaveRom ? (
        <div className="weave-rom-warning">
          <Notice level="warn">{localizer.message("ui.weaveExport.romDistributionWarning")}</Notice>
        </div>
      ) : null}
    </div>
  );
};

export const WeaveOutputStep = ({
  weaveActionLabel,
  weaveExport,
  weaveTools,
  disabled,
  fileName,
  headerField,
  onFileNameChange,
  onFormatChange,
  secondary,
}: {
  weaveActionLabel: string;
  weaveExport: WeaveExportState;
  weaveTools: WeaveToolsState;
  disabled: boolean;
  fileName: string;
  headerField?: ReactNode;
  onFileNameChange: (value: string) => void;
  onFormatChange: (value: string) => void;
  secondary?: ReactNode;
}) => {
  const localizer = useUiLocalizer();
  return (
    <WorkflowOutputStep
      action={
        <>
          {weaveExport.error ? <Notice level="error">{weaveExport.error}</Notice> : null}
          <WeaveExportAction weaveActionLabel={weaveActionLabel} weaveExport={weaveExport} disabled={disabled} />
        </>
      }
      compress={{
        children: null,
        extraChildren: (
          <>
            <WeaveOutputFields weaveExport={weaveExport} weaveTools={weaveTools} />
            {headerField}
          </>
        ),
      }}
      disabled={weaveExport.busy}
      fault={!!weaveExport.error}
      fileName={fileName}
      fileNameId="rom-weaver-input-weave-file-name"
      fileNamePlaceholder={localizer.message("ui.weaveExport.outputFilename")}
      format={weaveExport.format}
      formatId="rom-weaver-weave-export-format"
      formatOptions={[
        { label: ".zip", value: "zip" },
        { label: ".7z", value: "7z" },
      ]}
      id="rom-weaver-weave-job"
      num="0x04"
      onFileNameChange={onFileNameChange}
      onFormatChange={onFormatChange}
      secondary={secondary}
      title={localizer.message("ui.step.weave")}
    />
  );
};

const SecondaryOutputJob = ({
  children,
  hash,
  id,
  label,
}: {
  children: ReactNode;
  hash?: string;
  id: string;
  label: string;
}) => {
  const localizer = useUiLocalizer();
  const [open, setOpen] = useState(false);
  const headingRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (typeof window === "undefined" || !hash) return;
    let frameId: number | undefined;
    const revealJob = () => {
      if (window.location.hash.toLowerCase() !== hash) return;
      setOpen(true);
      frameId = window.requestAnimationFrame(() => {
        frameId = undefined;
        headingRef.current?.scrollIntoView({ block: "start" });
        headingRef.current?.focus();
      });
    };
    revealJob();
    window.addEventListener("hashchange", revealJob);
    return () => {
      window.removeEventListener("hashchange", revealJob);
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
    };
  }, [hash]);
  return (
    <div id={id}>
      <Drawer
        bodyClassName="weave-job-content"
        className="weave-job"
        headingRef={headingRef}
        label={label}
        onToggle={setOpen}
        open={open}
        readouts={<DrawerReadout muted>{localizer.message("ui.weaveExport.optional")}</DrawerReadout>}
      >
        {children}
      </Drawer>
    </div>
  );
};

/** Weave export is the optional alternate job on the Apply route. */
export const WeaveSecondaryJob = ({
  weaveActionLabel,
  weaveExport,
  weaveTools,
  disabled,
}: {
  weaveActionLabel: string;
  weaveExport: WeaveExportState;
  weaveTools: WeaveToolsState;
  disabled: boolean;
}) => {
  const localizer = useUiLocalizer();
  return (
    <SecondaryOutputJob hash="#weave" id="rom-weaver-weave-job" label={localizer.message("ui.weaveExport.shareTitle")}>
      <WeaveOutputFields weaveExport={weaveExport} weaveTools={weaveTools} />
      {weaveExport.error ? <Notice level="error">{weaveExport.error}</Notice> : null}
      <WeaveExportAction weaveActionLabel={weaveActionLabel} weaveExport={weaveExport} disabled={disabled} />
    </SecondaryOutputJob>
  );
};

/** Apply is the optional alternate job on the Weave route. */
export const ApplySecondaryJob = ({ children }: { children: ReactNode }) => {
  const localizer = useUiLocalizer();
  return (
    <SecondaryOutputJob id="rom-weaver-apply-job" label={localizer.message("ui.step.apply")}>
      {children}
    </SecondaryOutputJob>
  );
};
