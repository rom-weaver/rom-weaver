import { Download, Share2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  postApplyDownloadBehaviorOption,
  postApplyTestBehaviorOption,
  POST_APPLY_DOWNLOAD_BEHAVIOR_OPTIONS,
  POST_APPLY_TEST_BEHAVIOR_OPTIONS,
} from "../../lib/apply/post-apply-behavior.ts";
import type { BrowserApplyResult } from "../../platform/browser/browser-api.ts";
import { type ProgressViewModel } from "../../presentation/workflow-presentation.ts";
import { type RomCheckActuals } from "./apply-patch-list-step.tsx";
import { DropdownSelect } from "./components/ds/dropdown-select.tsx";
import { FieldInfoToggle } from "./components/ds/compress-panel.tsx";
import { Drawer, DrawerReadout } from "./components/ds/drawer.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { OutputField } from "./components/ds/output-card.tsx";
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

/** Bundle-related notices and export reveal state, threaded from the form. */
export type BundleToolsState = {
  /** Persist the bundle package choice, synced to user settings. */
  setBundlePackage: (value: string) => void;
  /** The run has optional entries (or patches toggled off): output checks only
   * describe the full chain. */
  hasOptionalEntries: boolean;
  /** Why the woven final result won't be verified against an expected output;
   * null when it will be, or when nothing declares an output. */
  outputVerification: { level: "warn"; message: string } | null;
};

export type BundleExportState = {
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
export const OutputHeaderField = ({
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
        id="rom-weaver-select-output-header"
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
    <>
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
    </>
  );
};

/** Export while running shows the live bar; otherwise the create/download button. */
const BundleExportAction = ({
  bundleActionLabel,
  bundleExport,
  disabled,
}: {
  bundleActionLabel: string;
  bundleExport: BundleExportState;
  disabled: boolean;
}) => {
  const localizer = useUiLocalizer();
  if (bundleExport.busy) {
    return (
      <ProgressActionButton
        cancelLabel={localizer.message("ui.apply.cancelBundleExport")}
        disabled
        label={bundleActionLabel}
        onCancel={bundleExport.cancelExport}
        onClick={() => undefined}
        progress={bundleExport.progress}
        progressId="rom-weaver-bundle-export-progress"
      />
    );
  }
  return (
    <button
      className="btn primary slim bundle-share"
      disabled={disabled}
      id="rom-weaver-button-export-bundle"
      onClick={() => void bundleExport.runExport()}
      type="button"
    >
      {bundleExport.downloadable ? <Download aria-hidden="true" /> : <Share2 aria-hidden="true" />}
      {bundleActionLabel}
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
  bundleTools,
  bundleVerificationError,
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
  bundleTools?: BundleToolsState;
  bundleVerificationError: string | null;
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
          (patches.length > 0 && enabledPatchCount === 0) || !!bundleVerificationError || !!cheatHeaderStripConflict
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
      {bundleVerificationError ? <Notice level="error">{bundleVerificationError}</Notice> : null}
      {bundleTools?.outputVerification ? (
        <p aria-live="polite" className="patch-off-note" id="rom-weaver-bundle-output-unverified">
          <TriangleAlert aria-hidden="true" />
          <span>{bundleTools.outputVerification.message}</span>
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

export const getBundleActionLabel = (
  bundleExport: BundleExportState | undefined,
  localizer: ReturnType<typeof useUiLocalizer>,
  downloadable: boolean,
) => {
  if (!downloadable) return bundleExport ? localizer.message("ui.bundleExport.share") : "";
  if (!bundleExport?.downloadable) return "";
  const formatValue = bundleExport.format || "zip";
  const formatName = formatValue === "7z" ? "7z" : formatValue.toUpperCase();
  const downloadKey = bundleExport.bundleRom ? "ui.bundleExport.downloadRom" : "ui.bundleExport.download";
  return localizer.message(downloadKey, { format: formatName });
};

const BundleOutputFields = ({
  bundleExport,
  bundleTools,
}: {
  bundleExport?: BundleExportState;
  bundleTools?: BundleToolsState;
}) => {
  const localizer = useUiLocalizer();
  if (!bundleExport) return null;
  const setBundleContents = (includeRom: boolean) => {
    bundleTools?.setBundlePackage(includeRom ? "rom" : "patches");
  };
  return (
    <div className="bundle-job-fields">
      <div className="bundle-rom-option">
        <label className="checkrow" htmlFor="rom-weaver-bundle-export-bundle-rom">
          <input
            checked={bundleExport.bundleRom}
            disabled={bundleExport.busy}
            id="rom-weaver-bundle-export-bundle-rom"
            onChange={(event) => setBundleContents(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{localizer.message("ui.bundleExport.includeRom")}</span>
        </label>
      </div>
      {bundleExport.bundleRom ? (
        <div className="bundle-rom-warning">
          <Notice level="warn">{localizer.message("ui.bundleExport.romDistributionWarning")}</Notice>
        </div>
      ) : null}
    </div>
  );
};

/**
 * Bundle export is a separate job from Apply. The Bundle route presents it
 * first, while the Apply route keeps it after the primary action.
 */
export const BundleSecondaryJob = ({
  bundleActionLabel,
  bundleExport,
  bundleTools,
  disabled,
  primary = false,
}: {
  bundleActionLabel: string;
  bundleExport: BundleExportState;
  bundleTools: BundleToolsState;
  disabled: boolean;
  primary?: boolean;
}) => {
  const localizer = useUiLocalizer();
  const [open, setOpen] = useState(primary);
  const headingRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (primary && !disabled) setOpen(true);
  }, [disabled, primary]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let frameId: number | undefined;
    const revealBundleStep = () => {
      if (window.location.hash.toLowerCase() !== "#bundle") return;
      setOpen(true);
      frameId = window.requestAnimationFrame(() => {
        frameId = undefined;
        headingRef.current?.scrollIntoView({ block: "start" });
        headingRef.current?.focus();
      });
    };
    revealBundleStep();
    window.addEventListener("hashchange", revealBundleStep);
    return () => {
      window.removeEventListener("hashchange", revealBundleStep);
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
    };
  }, []);
  return (
    <div id="rom-weaver-bundle-job">
      <Drawer
        bodyClassName="bundle-job-content"
        className="bundle-job"
        headingRef={headingRef}
        label={localizer.message("ui.bundleExport.shareTitle")}
        onToggle={setOpen}
        open={open}
        readouts={
          primary ? undefined : <DrawerReadout muted>{localizer.message("ui.bundleExport.optional")}</DrawerReadout>
        }
      >
        <BundleOutputFields bundleExport={bundleExport} bundleTools={bundleTools} />
        {bundleExport.error ? <Notice level="error">{bundleExport.error}</Notice> : null}
        <BundleExportAction bundleActionLabel={bundleActionLabel} bundleExport={bundleExport} disabled={disabled} />
      </Drawer>
    </div>
  );
};
