import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import type { BundleRomExpectation } from "../../lib/bundle/bundle-session-model.ts";
import { validatePatchDependencies } from "../../lib/bundle/bundle-targets.ts";
import type { BrowserApplyResult } from "../../platform/browser/browser-api.ts";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import { RelatedStrip } from "../../webapp/components/related-strip.tsx";
import { getCheatHeaderStripConflict } from "../../lib/cheats/header-guard.ts";
import { ApplyPatchListStep } from "./apply-patch-list-step.tsx";
import type { CheatStackRenderState } from "./components/cheat-database-section.tsx";
import { getEmulatorJsCore } from "./components/emulatorjs.ts";
import { buildOutputCompressionPanel, getOutputCompressionFormatLabel } from "./components/ds/compress-panel.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import {
  databaseOnlyChecks,
  ROM_LOOKUP_MESSAGES,
  romLookupSource,
  RomExpectationCard,
  RomSearch,
  type RomExpectation,
} from "./components/ds/rom-expectation-card.tsx";
import { useFlatTransitionFlag } from "./components/ds/flat-transition.ts";
import { GhostSteps } from "./components/ds/ghost-steps.tsx";
import { InfoPopover, NeedsInput } from "./components/ds/layout.tsx";
import { SampleTutorial, type SampleTutorialStep, useGuidedSampleStart } from "./components/ds/sample-tutorial.tsx";
import { skipSourceIdentification } from "../../lib/input/input-identification-policy.ts";
import { UnifiedDropZone } from "./components/ds/unified-drop-zone.tsx";
import { WorkflowOutputStep } from "./components/ds/workflow-output-step.tsx";
import { OutputCard, type OutputCardProps } from "./components/ds/output-card.tsx";
import { WorkflowRomInputStep } from "./components/ds/workflow-rom-input-step.tsx";
import { ARCHIVE_FILE_EXTENSIONS, PATCH_FILE_EXTENSIONS, ROM_FILE_EXTENSIONS } from "./file-classification.ts";
import { getFileInputAcceptAttributes } from "./file-input-accept";
import { createCompressionTypeOptions } from "./output-view-model.ts";
import type {
  NoticeController,
  PatcherOutputController,
  PatcherStackController,
  PatcherUiController,
  StartupState,
} from "./patcher-form.ts";
import type { PatcherSectionNoticeKey, RomInputRowState } from "./patcher-ui-state.ts";
import { resolveAssetUrl } from "./asset-url.ts";
import { useRomWeaverAssetBaseUrl, useRomWeaverSettings, useUiLocalizer } from "./settings-context.tsx";
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";
import type { PatchInputBasis } from "./patch-input-basis.ts";
import { useExpectedRomIdentification } from "./use-expected-rom-identification.ts";
import { useRomLookup, type RomLookupResultRequest } from "./use-rom-lookup.ts";
import type { PendingDrop } from "./use-unified-apply-drop.ts";
import {
  parseChainInputExpectation,
  buildPlanBaseExpectation,
  buildRomVerificationStates,
  type RomIdentificationState,
  buildRomIdentificationStates,
} from "./apply-rom-expectations.ts";
import { getBundleVerificationError } from "./apply-declared-checksums.ts";
import {
  type BundleToolsState,
  type BundleExportState,
  OutputHeaderField,
  PostApplyBehaviorFields,
  ApplyOutputAction,
  ApplySecondaryJob,
  buildRomActualsById,
  getBundleActionLabel,
  BundleOutputStep,
  BundleSecondaryJob,
} from "./apply-output-fields.tsx";
import { type RomRowDeps, groupRomInputs, renderRomInputRow, renderDiscGroup } from "./apply-rom-input-rows.tsx";
import { SectionNotice } from "./apply-section-notice.tsx";
import { FIRST_WEAVE_ASSET, usePendingCardMorph, ApplyDropAfter } from "./apply-drop-after.tsx";

const getApplySampleTutorialSteps = (localizer: ReturnType<typeof useUiLocalizer>): readonly SampleTutorialStep[] => [
  {
    actions: [
      ["checks", localizer.message("ui.apply.tutorial.checks")],
      ["remove", localizer.message("ui.apply.tutorial.remove")],
    ],
    body: localizer.message("ui.apply.tutorial.rom.body"),
    openDrawers: true,
    target: "#rom-weaver-row-file-rom",
    title: localizer.message("ui.apply.tutorial.rom.title"),
  },
  {
    actions: [
      ["reorder", localizer.message("ui.apply.tutorial.moveUp")],
      ["reorder", localizer.message("ui.apply.tutorial.moveDown")],
      ["toggle", localizer.message("ui.apply.tutorial.toggle")],
      ["header", localizer.message("ui.apply.tutorial.header")],
      ["checks", localizer.message("ui.apply.tutorial.checks")],
      ["replace", localizer.message("ui.apply.tutorial.replacePatch")],
      ["menu", localizer.message("ui.apply.tutorial.patchDetails")],
    ],
    body: localizer.message("ui.apply.tutorial.patches.body"),
    openDrawers: true,
    openMenu: true,
    target: "#rom-weaver-row-patch-stack",
    title: localizer.message("ui.apply.tutorial.patches.title"),
  },
  {
    actions: [
      ["drop", localizer.message("ui.apply.tutorial.dropFiles")],
      ["drop", localizer.message("ui.apply.tutorial.browse")],
    ],
    body: localizer.message("ui.apply.tutorial.addFiles.body"),
    target: "#rom-weaver-row-unified-drop",
    title: localizer.message("ui.apply.tutorial.addFiles.title"),
  },
  {
    actions: [
      ["options", localizer.message("ui.apply.tutorial.options")],
      ["apply", localizer.message("ui.apply.tutorial.applyDownload")],
    ],
    body: localizer.message("ui.apply.tutorial.output.body"),
    cta: ".btn.run",
    openDrawers: true,
    placement: "top",
    target: "#rom-weaver-row-output-file-name",
    title: localizer.message("ui.apply.tutorial.output.title"),
  },
];

const getBundleSampleTutorialSteps = (localizer: ReturnType<typeof useUiLocalizer>): readonly SampleTutorialStep[] => [
  {
    actions: [
      ["checks", localizer.message("ui.apply.tutorial.checks")],
      ["remove", localizer.message("ui.apply.tutorial.remove")],
    ],
    body: localizer.message("ui.apply.bundleTutorial.rom.body"),
    openDrawers: true,
    target: "#rom-weaver-row-file-rom",
    title: localizer.message("ui.apply.bundleTutorial.rom.title"),
  },
  {
    actions: [
      ["reorder", localizer.message("ui.apply.tutorial.moveUp")],
      ["reorder", localizer.message("ui.apply.tutorial.moveDown")],
      ["toggle", localizer.message("ui.apply.bundleTutorial.optional")],
      ["menu", localizer.message("ui.apply.tutorial.patchDetails")],
    ],
    body: localizer.message("ui.apply.bundleTutorial.patches.body"),
    openMenu: true,
    target: "#rom-weaver-row-patch-stack",
    title: localizer.message("ui.apply.bundleTutorial.patches.title"),
  },
  {
    actions: [["package", localizer.message("ui.apply.bundleTutorial.bundlePatches")]],
    body: localizer.message("ui.apply.bundleTutorial.safeBundle.body"),
    openDrawers: true,
    placement: "top",
    target: "#rom-weaver-bundle-job",
    title: localizer.message("ui.apply.bundleTutorial.safeBundle.title"),
  },
  {
    actions: [["package", localizer.message("ui.bundleExport.share")]],
    body: localizer.message("ui.apply.bundleTutorial.download.body"),
    cta: "#rom-weaver-button-export-bundle",
    openDrawers: true,
    placement: "top",
    target: "#rom-weaver-bundle-job",
    title: localizer.message("ui.apply.bundleTutorial.download.title"),
  },
];

/**
 * Purely presentational apply-workflow view: renders the step layout from the
 * ui/patchStack/output/notice/dialog controllers ApplyPatchForm wires up.
 */

/** Full registry support, listed in the 0x01 info popover. */
const getApplySupportedFiles = (localizer: ReturnType<typeof useUiLocalizer>) =>
  [
    { extensions: ROM_FILE_EXTENSIONS, label: localizer.message("ui.apply.fileTypes.roms") },
    { extensions: PATCH_FILE_EXTENSIONS, label: localizer.message("ui.apply.fileTypes.patches") },
    { extensions: ARCHIVE_FILE_EXTENSIONS, label: localizer.message("ui.apply.fileTypes.archives") },
  ] as const;

/** Patch On/Off plumbing from the form: stable-id toggle set + index toggle. */
type PatchEnablement = {
  disabledIds: ReadonlySet<string>;
  getPatchIds: () => string[];
  onToggle: (index: number) => void;
};

// The apply view is a singleton in the webapp; a stable per-workflow key keeps
// its activity slot separate from the create/trim forms in the shared store.
const APPLY_ACTIVITY_KEY = "react-apply-view";

const renderApplyTimingMeta = (
  applyDone: boolean,
  localizer: ReturnType<typeof useUiLocalizer>,
  applyTiming?: string,
  compressTiming?: string,
): ReactNode => {
  if (applyDone) {
    return (
      <>
        {applyTiming ? (
          <span className="rb mono done-chip">
            <span className="k">{localizer.message("ui.step.apply")}</span>
            <span className="t">{applyTiming}</span>
          </span>
        ) : null}
        {compressTiming ? (
          <span className="rb mono done-chip" style={{ animationDelay: "0.19s" }}>
            <span className="k">{localizer.message("ui.apply.compress")}</span>
            <span className="t">{compressTiming}</span>
          </span>
        ) : null}
      </>
    );
  }
  if (!applyTiming) return undefined;
  return (
    <span className="rb mono">
      <span className="k">{localizer.message("ui.step.apply")}</span>
      <span className="t">{applyTiming}</span>
    </span>
  );
};

/**
 * The "ROM header" select only exists when the staged ROM has a strippable copier
 * header (the checksum variants carry the detection). Auto uses the engine's
 * `retainOnOutput` metadata to label whether the header will be kept.
 */
const resolveOutputHeaderOptions = (romInputs: RomInputRowState[]) => {
  const variant = romInputs
    .flatMap((row) => row.info.checksumVariants || [])
    .find(
      (candidate) =>
        candidate.applyCompatibility?.removeHeader === true || candidate.applyCompatibility?.strip_header === true,
    );
  const transform = variant?.transforms?.removeHeader as
    | { headeredExtension?: string; headerlessExtension?: string; retainOnOutput?: boolean }
    | undefined;
  return {
    headeredExtension: transform?.headeredExtension,
    headerlessExtension: transform?.headerlessExtension,
    retained: transform?.retainOnOutput !== false,
    visible: !!variant,
  };
};

/** Fetches the bundled sample and hands it to the drop path, for both guided tutorials. */
const useGuidedSampleLoader = (input: {
  assetBaseUrl: string | undefined;
  mode: "apply" | "bundle";
  onDrop: (files: File[]) => void;
  onStartBundle: () => void;
}) => {
  const localizer = useUiLocalizer();
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState("");
  const [sampleTutorial, setSampleTutorial] = useState<"apply" | "bundle" | null>(null);
  const loadFirstWeave = async () => {
    setSampleLoading(true);
    setSampleError("");
    try {
      const response = await fetch(resolveAssetUrl(input.assetBaseUrl, FIRST_WEAVE_ASSET));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const sample = new File([blob], "first-weave.zip", { type: "application/zip" });
      // The generated homebrew ROM is not in the public identify database. The
      // tutorial MUST become ready without downloading and staging that data.
      skipSourceIdentification(sample);
      input.onDrop([sample]);
    } catch {
      setSampleTutorial(null);
      setSampleError(localizer.message("ui.apply.tutorial.sampleLoadFailed"));
    } finally {
      setSampleLoading(false);
    }
  };
  const startApplySample = () => {
    setSampleTutorial("apply");
    void loadFirstWeave();
  };
  const startBundleSample = () => {
    input.onStartBundle();
    setSampleTutorial("bundle");
    void loadFirstWeave();
  };
  useGuidedSampleStart("apply", startApplySample, () => setSampleTutorial(null), input.mode === "apply");
  useGuidedSampleStart("bundle", startBundleSample, () => setSampleTutorial(null), input.mode === "bundle");
  const closeSampleTutorial = () => setSampleTutorial(null);
  return { closeSampleTutorial, sampleError, sampleLoading, sampleTutorial, startApplySample, startBundleSample };
};

/** The selvage status strip mirrors the apply job's lifecycle, newest state first. */
const resolveApplyActivity = (input: {
  applyDone: boolean;
  applyFailed: boolean;
  applyStage: string;
  doneStage: string;
  inputsStaging: boolean;
  running: boolean;
  stagingStage: string;
}) => {
  if (input.running) return { stage: input.applyStage, state: "running" as const };
  if (input.applyFailed) return { state: "failed" as const };
  if (input.applyDone) return { stage: input.doneStage, state: "done" as const };
  if (input.inputsStaging) return { stage: input.stagingStage, state: "staging" as const };
  return { state: "idle" as const };
};

/**
 * The expected-ROM group describes THE base ROM, so it only travels to the rows on
 * an unambiguous single-ROM bench.
 */
const buildRomRowDeps = (input: {
  bundleRomExpectation: BundleRomExpectation | undefined;
  expectedRomChecks: ParsedBundleChecks | undefined;
  expectedDatabaseChecksums: Record<string, string> | undefined;
  identificationStates: ReadonlyMap<string, RomIdentificationState>;
  localizer: ReturnType<typeof useUiLocalizer>;
  romInputs: RomInputRowState[];
  romVerificationStates: RomRowDeps["verificationStates"];
  singleRom: boolean;
  uiController: PatcherUiController;
}): RomRowDeps => {
  const { expectedRomChecks, singleRom } = input;
  return {
    identificationStates: input.identificationStates,
    localizer: input.localizer,
    romInputs: input.romInputs,
    ui: input.uiController,
    verificationStates: input.romVerificationStates,
    ...(singleRom && expectedRomChecks ? { expectedChecks: expectedRomChecks } : {}),
    ...(singleRom && input.bundleRomExpectation?.name ? { expectedName: input.bundleRomExpectation.name } : {}),
    ...(singleRom && input.expectedDatabaseChecksums
      ? { expectedDatabaseChecksums: input.expectedDatabaseChecksums }
      : {}),
  };
};

function ApplyWorkflowFormView({
  cheats,
  cheatsOn,
  controllers,
  emulatorOutput,
  bundleExpectedRomChecks,
  bundleExport,
  bundleMetaById,
  bundleSessionMatches,
  bundleRomExpectation,
  bundleTools,
  onBundleMetaChange,
  onBundleMetaBulkChange,
  onSelectTab,
  onSelectView,
  onUnifiedDrop,
  mode = "apply",
  patchEnablement,
  patchInputBasis,
  onPatchInputBasisChange,
  pendingDrops = [],
  romLookupRequest,
  startup = { message: "", status: "ready" },
}: {
  /**
   * The optional cheat patch card attached to the ROM step. It receives the
   * header-strip guard the patch controls derive.
   */
  cheats?: (state: {
    headerStripConflict: string;
    renderStack: (stack: CheatStackRenderState) => ReactNode;
  }) => ReactNode;
  /** At least one cheat card's switch is On. */
  cheatsOn?: boolean;
  controllers: {
    output: PatcherOutputController;
    patchStack: PatcherStackController;
    ui: PatcherUiController;
    notice?: NoticeController;
  };
  emulatorOutput?: BrowserApplyResult["output"] | null;
  /** Bundle export controls live in the separate sharing job after Apply. */
  bundleExport?: BundleExportState;
  /** Bundle notices + the export reveal state. */
  bundleTools?: BundleToolsState;
  /** The bundle's expected base-ROM checks, folded into the staged ROM card. */
  bundleExpectedRomChecks?: ParsedBundleChecks;
  /** Per-patch bundle metadata (label/description chips), keyed by stable source id. */
  bundleMetaById?: ReadonlyMap<string, BundlePatchMeta>;
  /** A loaded bundle's delivered patch names match the current patch list. */
  bundleSessionMatches?: boolean;
  /** Shown while the bundle session waits for the user to supply the expected ROM. */
  bundleRomExpectation?: BundleRomExpectation;
  onBundleMetaChange?: (id: string, updates: Partial<BundlePatchMeta>) => void;
  onBundleMetaBulkChange?: (ids: readonly string[], updates: Partial<BundlePatchMeta>) => void;
  /** The nav's own tab-switch handler, threaded down for the result's related-links strip. */
  onSelectTab?: (id: string) => void;
  onSelectView?: (view: "test") => void;
  onTrace?: (message: string, details?: Record<string, unknown>) => void;
  onUnifiedDrop?: (files: File[], onSettled?: () => void) => void;
  mode?: "apply" | "bundle";
  patchEnablement?: PatchEnablement;
  patchInputBasis?: PatchInputBasis;
  onPatchInputBasisChange?: (index: number, basis: PatchInputBasis) => void;
  pendingDrops?: PendingDrop[];
  romLookupRequest?: RomLookupResultRequest;
  startup?: StartupState;
}) {
  const uiController = controllers.ui;
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
  const localizer = useUiLocalizer();
  const bundlePage = mode === "bundle";
  const unifiedInputId = mode === "bundle" ? "rom-weaver-input-file-unified-bundle" : "rom-weaver-input-file-unified";

  const romInputs: RomInputRowState[] = uiState.romInputs;
  const patches = patchState.items;
  // Per-index disabled flags for the loom On/Off switches.
  const patchIds = patchEnablement ? patchEnablement.getPatchIds() : [];
  const disabledPatchFlags = patches.map((_, index) => {
    const id = patchIds[index];
    return !!patchEnablement && id !== undefined && patchEnablement.disabledIds.has(id);
  });
  // Card metadata is resolved by stable id so reorders keep the right annotations.
  const bundleMeta = patches.map((_, index) => {
    const id = patchIds[index];
    const metadata = bundleMetaById && id !== undefined ? bundleMetaById.get(id) : undefined;
    return id ? { id, ...metadata } : metadata;
  });
  const bundleVerificationError =
    getBundleVerificationError(bundleMeta, patches, localizer) ||
    validatePatchDependencies(
      bundleMeta.map((meta, index) => ({
        enabled: !disabledPatchFlags[index],
        id: meta?.id || `patch-${index + 1}`,
        input: meta?.input,
        target: meta?.target,
      })),
    ) ||
    null;
  // The per-patch header state in 0x03 decides the cheat guard; neither the
  // cheat card nor the header select keeps a copy of it. The output header in
  // 0x04 is applied after the cheats bake, so it never moves a write.
  // The request sends a decided auto resolution as an explicit mode, so the
  // guard reads the same value the controller will send.
  const cheatHeaderStripConflict = getCheatHeaderStripConflict({
    cheatsOn: !!cheatsOn,
    patchHeaderModes: patches.map(
      (item) => item.headerChoice ?? (item.headerAutoDecided ? item.headerAutoMode : undefined),
    ),
  });
  const disabledPatchCount = disabledPatchFlags.filter(Boolean).length;
  const enabledPatchCount = patches.length - disabledPatchCount;
  const settings = useRomWeaverSettings();
  // Inputs/patches still resolving - surfaced only on the selvage status strip.
  const inputsStaging =
    romInputs.some((row) => !!row.progress) || patches.some((item) => !!item.progress) || uiState.patchInput.loading;
  // The selvage status strip mirrors the apply job's lifecycle.
  const applyProgress = outputState.applyButton.progress;
  const applyStage = applyProgress ? String(applyProgress.label || applyProgress.message || "") : "";
  const applyFailed = !!errorNotice?.visible && errorNotice.level !== "warning";
  const applyDone = !!outputState.pendingDownloadFileName;
  const applyTotalTime = outputState.totalTiming;
  const stagingStage = localizer.message("ui.drop.staging");
  const doneStage = applyTotalTime ? localizer.message("ui.status.doneMsg", { t: applyTotalTime }) : "";
  useEffect(() => {
    setWorkbenchActivity(
      APPLY_ACTIVITY_KEY,
      resolveApplyActivity({
        applyDone,
        applyFailed,
        applyStage,
        doneStage,
        inputsStaging,
        running: !!applyProgress,
        stagingStage,
      }),
    );
  }, [applyProgress, applyStage, applyFailed, applyDone, doneStage, inputsStaging, stagingStage]);
  const running = !!applyProgress;
  const wovenSteps = running || applyDone;

  const romVerificationStates = buildRomVerificationStates(patches, romInputs, disabledPatchFlags);
  const romIdentificationStates = buildRomIdentificationStates(patches, disabledPatchFlags);
  // Each ROM's computed identity, keyed by id, for patch-card check verification.
  // Disc-track rows are targeted by FILE NAME (their row id is not what the
  // target select resolves), so those alias their actuals under the file name too.
  const romActualsById = buildRomActualsById(romInputs);
  // The expected-ROM group describes THE base ROM, so it only renders for an
  // unambiguous single-ROM bench. Plan base-basis verdicts feed it; without plan
  // evidence the bundle expectation, then the chain-input patch's checks, stand in.
  const singleRom = romInputs.length === 1;
  const planBaseExpectation = singleRom
    ? buildPlanBaseExpectation(patches, disabledPatchFlags, bundleMeta, bundleExpectedRomChecks, romInputs[0]?.info)
    : null;
  const expectedRomChecks =
    planBaseExpectation?.expected ?? bundleExpectedRomChecks ?? parseChainInputExpectation(patches, disabledPatchFlags);
  const baseConflict = !!planBaseExpectation?.conflict;
  // Any rom check with no ROM behind it yet raises the expectation card - the
  // bundle's own entry, the plan's base verdict, or the chain-input patch's
  // declared source. The identify lookup is what turns the check into a title.
  const hasExpectedChecks = !!(
    Object.keys(expectedRomChecks?.checksums || {}).length || typeof expectedRomChecks?.size === "number"
  );
  const expectedRomIdentification = useExpectedRomIdentification(
    hasExpectedChecks ? expectedRomChecks : undefined,
    romInputs.length === 0,
  );
  // The search-by-checksum-or-name path only exists to fill the gap the
  // derived checks leave: nothing here says which ROM the run needs. A bundle
  // or patch that already declares one answers the question, so the search
  // stays out of the way and its own result is dropped.
  const romLookup = useRomLookup(ROM_LOOKUP_MESSAGES(localizer));
  const applyRomLookupRequestRef = useRef({ clear: romLookup.clear, selectResult: romLookup.selectResult });
  applyRomLookupRequestRef.current = { clear: romLookup.clear, selectResult: romLookup.selectResult };
  useEffect(() => {
    if (!romLookupRequest) return;
    if (romLookupRequest.result) applyRomLookupRequestRef.current.selectResult(romLookupRequest.result);
    else applyRomLookupRequestRef.current.clear();
  }, [romLookupRequest]);
  const canSearchRom = romInputs.length === 0 && !hasExpectedChecks;
  const { clear: clearManualRomLookup } = romLookup;
  const staleRomLookup = !canSearchRom && !!(romLookup.text || romLookup.result);
  useEffect(() => {
    if (staleRomLookup) clearManualRomLookup();
  }, [clearManualRomLookup, staleRomLookup]);
  const manualRomLookup = canSearchRom ? romLookup.result : undefined;
  const romExpectation: RomExpectation | undefined =
    romInputs.length === 0 && hasExpectedChecks
      ? {
          ...(expectedRomChecks ? { checks: expectedRomChecks } : {}),
          ...(bundleRomExpectation?.name ? { name: bundleRomExpectation.name } : {}),
          source: bundleRomExpectation ? "bundle" : "patch",
        }
      : manualRomLookup
        ? { checks: manualRomLookup.checks, source: romLookupSource(manualRomLookup.foundBy) }
        : undefined;
  const romRowDeps = buildRomRowDeps({
    bundleRomExpectation,
    expectedDatabaseChecksums: databaseOnlyChecks(expectedRomChecks, expectedRomIdentification)?.checksums,
    expectedRomChecks,
    identificationStates: romIdentificationStates,
    localizer,
    romInputs,
    romVerificationStates,
    singleRom,
    uiController,
  });
  const compressHeaderFormat = getOutputCompressionFormatLabel(outputState.compressionFormat, outputState.options);
  const compressionTypeOptions = createCompressionTypeOptions(outputState.options, "none");
  const outputDisabled = outputState.disabled || bundleExport?.busy === true;
  const header = resolveOutputHeaderOptions(romInputs);
  const renderOutputHeaderField = (id?: string) => (
    <OutputHeaderField
      disabled={outputDisabled}
      headeredExtension={header.headeredExtension}
      headerlessExtension={header.headerlessExtension}
      id={id}
      onChange={(value) => controllers.output.setOutputHeader?.(value)}
      retained={header.retained}
      value={outputState.outputHeader}
      visible={header.visible}
    />
  );
  const emulatorInput = romInputs[0];
  const emulatorPlatform = emulatorInput?.info.romType?.platform?.trim() || undefined;
  const emulatorFileName =
    emulatorInput?.info.fileName || emulatorInput?.info.archiveName || outputState.pendingDownloadFileName || undefined;
  const emulatorCore = getEmulatorJsCore(emulatorPlatform, emulatorFileName);
  // "Share bundle" until an export exists, then "Download ...".
  const bundleCreateLabel = getBundleActionLabel(bundleExport, localizer, false);
  const bundleActionLabel = bundleExport?.downloadable
    ? getBundleActionLabel(bundleExport, localizer, true)
    : bundleCreateLabel;
  const outputExtraFields = (
    <>
      {renderOutputHeaderField()}
      <PostApplyBehaviorFields
        disabled={outputDisabled}
        downloadSetting={settings.postApplyDownloadBehavior}
        testSetting={settings.postApplyTestBehavior}
      />
    </>
  );

  // Unified drop: bare files stage immediately; each archive shows an
  // "identifying" placeholder until its ROM-vs-patch bucket is classified.
  const handleUnifiedDrop = onUnifiedDrop ?? (() => undefined);
  const handleUnifiedDropFiles = (files: File[]) => {
    handleUnifiedDrop(files, () => setDropStarted(false));
  };
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  const { closeSampleTutorial, sampleError, sampleLoading, sampleTutorial, startApplySample, startBundleSample } =
    useGuidedSampleLoader({
      assetBaseUrl,
      mode,
      onDrop: handleUnifiedDrop,
      onStartBundle: () => bundleTools?.setBundlePackage("patches"),
    });
  // Start the hero morph at the gesture, not after a large input finishes enough
  // staging to publish its first row. This is presentation-only; Rust ingestion
  // continues on its existing schedule behind the transition.
  const [dropStarted, setDropStarted] = useState(false);
  const workflowHasContent = romInputs.length > 0 || patches.length > 0 || pendingDrops.length > 0 || inputsStaging;
  const sampleTutorialReady =
    romInputs.length > 0 &&
    patches.length > 0 &&
    pendingDrops.length === 0 &&
    !inputsStaging &&
    romInputs.every((input) => !input.progress) &&
    patches.every((patch) => !patch.progress);
  const formReady = pendingDrops.length === 0 && (romInputs.length > 0 || patches.length > 0 || inputsStaging);
  useEffect(() => {
    if (dropStarted && workflowHasContent) setDropStarted(false);
  }, [dropStarted, workflowHasContent]);
  // The empty bench fills (or clears) inside a flat crossfade - the 0x01 hero
  // shrinking into the add-row otherwise snaps. A drop-start signal makes that
  // crossfade begin before input staging publishes its first row.
  // A checksum match fills the bench the way a patches-only bundle does: 0x02
  // already knows which ROM it wants, so the whole run is laid out around it.
  const workflowActuallyEmpty = !(workflowHasContent || dropStarted || manualRomLookup);
  const workflowEmpty = useFlatTransitionFlag(workflowActuallyEmpty);
  usePendingCardMorph(pendingDrops.length, romInputs.length + patches.length);
  // "Needs input" directives forward to the unified picker.
  const openUnifiedPicker = () => document.getElementById(unifiedInputId)?.click();
  // Each section keeps its empty fixture whenever its own list is empty - not
  // just when the whole workflow is - so loading only a ROM (or only patches)
  // still shows the other section's prompt instead of a bare
  // header.
  /* Patches without a ROM leave 0x02 empty and the hero gone, so the search
     the hero carried follows the gap here as an island: the ROM can still be
     named before it exists. It leaves once a match or a derived check answers. */
  const romNeedsInput = (
    <>
      <NeedsInput onClick={openUnifiedPicker}>{localizer.message("ui.apply.needsRom")}</NeedsInput>
      {canSearchRom && !manualRomLookup ? (
        <RomSearch localizer={localizer} lookup={romLookup} variant="section" />
      ) : null}
    </>
  );
  const patchesNeedsInput = (
    <NeedsInput onClick={openUnifiedPicker}>{localizer.message("ui.apply.needsPatches")}</NeedsInput>
  );
  const renderOutputAction = (
    <ApplyOutputAction
      applyTotalTime={applyTotalTime}
      bundleTools={bundleTools}
      bundleVerificationError={bundleVerificationError}
      cheatHeaderStripConflict={cheatHeaderStripConflict}
      controllers={{ output: controllers.output }}
      disabledPatchCount={disabledPatchCount}
      enabledPatchCount={enabledPatchCount}
      emulatorCore={emulatorCore}
      emulatorFileName={emulatorFileName}
      emulatorPlatform={emulatorPlatform}
      emulatorOutput={emulatorOutput}
      errorNotice={errorNotice}
      localizer={localizer}
      noticeController={noticeController}
      onSelectView={onSelectView}
      outputState={outputState}
      patches={patches}
      uiController={uiController}
      uiState={uiState}
    />
  );
  // Keep the optional sharing job available after Apply once the bench has content.
  const showBundleJob = bundleExport && bundleTools && (romInputs.length > 0 || patches.length > 0 || applyDone);
  const bundleSecondaryJob =
    showBundleJob && !bundlePage ? (
      <BundleSecondaryJob
        bundleActionLabel={bundleActionLabel}
        bundleExport={bundleExport}
        bundleTools={bundleTools}
        disabled={outputState.disabled || !bundleExport.ready || !romInputs.length || !patches.length}
      />
    ) : null;

  const applyOutputProps: OutputCardProps = {
    action: renderOutputAction,
    compress: buildOutputCompressionPanel({
      disabled: outputDisabled,
      extraChildren: outputExtraFields,
      fields: outputState.compress?.fields,
      format: compressHeaderFormat,
      formatId: "rom-weaver-select-output-format-compress",
      formatLabel: localizer.message("ui.apply.compressionType"),
      formatOptions: compressionTypeOptions,
      formatValue: outputState.compressionFormat,
      note: outputState.compress?.note,
      onFieldChange: (key, value, updates) => controllers.output.setOutputCompressOption?.(key, value, updates),
      onFormatChange: (value) => controllers.output.setOutputCompression(value),
      readouts: null,
      timing: outputState.compressTiming || undefined,
    }),
    disabled: outputDisabled,
    fileName: outputState.displayFileName,
    fileNameId: "rom-weaver-input-output-file-name",
    fileNamePlaceholder: localizer.message("ui.apply.outputFilename"),
    format: outputState.compressionFormat,
    formatId: "rom-weaver-select-output-format",
    formatOptions: outputState.options,
    nameSource: outputState.identifiedName
      ? {
          identifiedName: outputState.identifiedName.name,
          on: outputState.identifiedName.on,
          onChange: (on) => controllers.output.setUseIdentifiedName(on),
        }
      : null,
    onFileNameChange: (value) => controllers.output.setDisplayFileName(value),
    onFormatChange: (value) => controllers.output.setOutputCompression(value),
  };
  const outputNotice = (
    <SectionNotice
      id="rom-weaver-output-notice-message"
      onDismiss={dismissSectionNotice("outputNotice")}
      state={uiState.outputNotice}
    />
  );
  const applySecondaryJob = bundlePage ? (
    <ApplySecondaryJob>
      <OutputCard {...applyOutputProps} />
      {outputNotice}
    </ApplySecondaryJob>
  ) : null;

  if (startup.status === "error") {
    return (
      <section className="panel" id="rom-weaver-container">
        <div className="step-body">
          <Notice level="error">{startup.message || localizer.message("ui.apply.loadFailed")}</Notice>
        </div>
      </section>
    );
  }

  return (
    <section className={formReady ? "panel form-ready" : "panel"} id="rom-weaver-container">
      <UnifiedDropZone
        accept={fileInputAccept.unifiedApply}
        addLabel={localizer.message(romInputs.length ? "ui.apply.add.replaceOrPatches" : "ui.apply.add.romOrPatches")}
        afterDropZone={
          <>
            <ApplyDropAfter
              bundlePage={bundlePage}
              downloadHref={resolveAssetUrl(assetBaseUrl, FIRST_WEAVE_ASSET)}
              onLoadApplySample={startApplySample}
              onLoadBundleSample={startBundleSample}
              pendingDrops={pendingDrops}
              sampleError={sampleError}
              sampleLoading={sampleLoading}
              workflowEmpty={workflowEmpty}
            />
            {/* Apply keeps the search available without competing with the
                primary file-drop action. The form moves to 0x02 after a match. */}
            {canSearchRom && workflowEmpty ? <RomSearch localizer={localizer} lookup={romLookup} /> : null}
          </>
        }
        big={workflowEmpty}
        heroLabel={localizer.message("ui.apply.drop.hero")}
        heroLabelCoarse={localizer.message("ui.apply.drop.heroCoarse")}
        id="rom-weaver-row-unified-drop"
        info={
          <ul className="info-list">
            <li>{localizer.message("ui.apply.drop.info.nested")}</li>
            <li>{localizer.message("ui.apply.drop.info.compressed")}</li>
            <li>{localizer.message("ui.apply.drop.info.bundle")}</li>
            <li>{localizer.message("ui.apply.drop.info.retroArch")}</li>
          </ul>
        }
        inputId={unifiedInputId}
        lead={
          bundlePage
            ? {
                line1: "ui.hero.bundleThesis",
                line2: "ui.hero.bundleThesis2",
                description: "ui.hero.bundleDescription",
              }
            : {
                line1: "ui.hero.thesis",
                line2: "ui.hero.thesis2",
                description: "ui.hero.applyDescription",
              }
        }
        onDropStart={() => setDropStarted(true)}
        onFiles={handleUnifiedDropFiles}
        supported={getApplySupportedFiles(localizer)}
      />
      {workflowEmpty ? (
        <GhostSteps
          steps={[
            { num: "0x02", title: localizer.message("ui.step.rom") },
            {
              num: "0x03",
              title: localizer.message(bundlePage ? "ui.step.patches" : "ui.step.patchesCheats"),
            },
            ...(bundlePage
              ? [{ num: "0x04", title: localizer.message("ui.step.bundle") }]
              : [{ num: "0x04", title: localizer.message("ui.step.apply") }]),
          ]}
        />
      ) : (
        <>
          <WorkflowRomInputStep
            beforeItems={
              romExpectation ? (
                <>
                  <RomExpectationCard
                    expectation={romExpectation}
                    identification={manualRomLookup?.identification ?? expectedRomIdentification}
                    {...(manualRomLookup
                      ? { onRemove: clearManualRomLookup, removeLabel: localizer.message("ui.apply.clearExpectedRom") }
                      : {})}
                  />
                  {/* A searched-for ROM is the user's guess, so the search stays
                      one line away until a real ROM makes the expectation
                      concrete. A bundle's or patch's check is not up for
                      revision, so those get no refine row. */}
                  {manualRomLookup ? <RomSearch localizer={localizer} lookup={romLookup} variant="compact" /> : null}
                </>
              ) : null
            }
            emptyState={romNeedsInput}
            fault={applyFailed}
            id="rom-weaver-row-file-rom"
            info={
              <InfoPopover title={localizer.message("ui.apply.inputHandling.title")}>
                <strong>{localizer.message("ui.apply.inputHandling.title")}</strong>
                <ul>
                  <li>{localizer.message("ui.apply.inputHandling.archives")}</li>
                  <li>{localizer.message("ui.apply.inputHandling.compressed")}</li>
                  <li>{localizer.message("ui.apply.inputHandling.nested")}</li>
                  <li>{localizer.message("ui.apply.inputHandling.bundleIndex")}</li>
                  <li>{localizer.message("ui.apply.inputHandling.patchEntries")}</li>
                  <li>{localizer.message("ui.apply.inputHandling.bundleContents")}</li>
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
                {baseConflict ? (
                  <Notice id="rom-weaver-rom-expected-conflict" level="warn">
                    {localizer.message("ui.rom.baseConflict")}
                  </Notice>
                ) : null}
                <SectionNotice
                  id="rom-weaver-input-notice-message"
                  onDismiss={dismissSectionNotice("inputNotice")}
                  state={uiState.inputNotice}
                />
              </>
            }
            num="0x02"
            title={localizer.message("ui.step.rom")}
            woven={wovenSteps}
          />

          {(() => {
            const renderPatchStep = (stack?: CheatStackRenderState) => (
              <ApplyPatchListStep
                cheats={stack}
                bundleMeta={bundleMeta}
                bundleOutputCheckHint={!!bundleTools?.hasOptionalEntries}
                bundleSessionMatches={bundleSessionMatches}
                disabledFlags={disabledPatchFlags}
                emptyState={patchesNeedsInput}
                fault={applyFailed}
                onBundleMetaChange={(index, updates) => {
                  const id = patchIds[index];
                  if (id) onBundleMetaChange?.(id, updates);
                }}
                onBundleMetaBulkChange={(updates) => onBundleMetaBulkChange?.(patchIds, updates)}
                onTogglePatch={patchEnablement?.onToggle}
                overrideAvailable={uiState.checksumOverride.visible}
                patches={patches}
                patchKeys={patchIds}
                patchStack={controllers.patchStack}
                patchInputBasis={patchInputBasis}
                patchInputBasisDisabled={bundleExport?.busy}
                onPatchInputBasisChange={onPatchInputBasisChange}
                romActualsById={romActualsById}
                sharedRomChecks={singleRom ? expectedRomChecks : undefined}
                stripDisabled={!!cheatsOn}
                notice={
                  <SectionNotice
                    id="rom-weaver-patch-notice-message"
                    onDismiss={dismissSectionNotice("patchNotice")}
                    state={uiState.patchNotice}
                  />
                }
                woven={wovenSteps}
              />
            );
            return !bundlePage && romInputs.length === 1 && cheats
              ? cheats({ headerStripConflict: cheatHeaderStripConflict, renderStack: renderPatchStep })
              : renderPatchStep();
          })()}

          {bundleExport && bundleTools && showBundleJob && bundlePage ? (
            <BundleOutputStep
              bundleActionLabel={bundleActionLabel}
              bundleExport={bundleExport}
              bundleTools={bundleTools}
              disabled={outputDisabled || !bundleExport.ready || !romInputs.length || !patches.length}
              fileName={outputState.displayFileName}
              headerField={
                header.visible ? renderOutputHeaderField("rom-weaver-select-bundle-output-header") : undefined
              }
              onFileNameChange={(value) => controllers.output.setDisplayFileName(value)}
              onFormatChange={(value) => {
                bundleExport.setFormat(value);
                controllers.output.setOutputCompression(value);
              }}
              secondary={applySecondaryJob}
            />
          ) : null}

          {bundlePage ? null : (
            <WorkflowOutputStep
              {...applyOutputProps}
              fault={applyFailed}
              id="rom-weaver-row-output-file-name"
              info={
                <InfoPopover title={localizer.message("ui.apply.outputOptions.title")}>
                  <strong>{localizer.message("ui.apply.outputOptions.output")}</strong>
                  <ul>
                    <li>{localizer.message("ui.apply.outputOptions.filename")}</li>
                    <li>{localizer.message("ui.apply.outputOptions.containers")}</li>
                    <li>{localizer.message("ui.apply.outputOptions.compression")}</li>
                  </ul>
                </InfoPopover>
              }
              meta={renderApplyTimingMeta(applyDone, localizer, outputState.applyTiming, outputState.compressTiming)}
              notice={outputNotice}
              num="0x04"
              secondary={bundleSecondaryJob}
              title={localizer.message("ui.step.apply")}
              woven={applyDone || running}
            />
          )}
          {applyDone && onSelectTab ? <RelatedStrip entryKey="patcher" onSelectTab={onSelectTab} /> : null}
        </>
      )}

      {sampleTutorial ? (
        <SampleTutorial
          loadingBody={localizer.message("ui.apply.tutorial.loading")}
          onClose={closeSampleTutorial}
          ready={sampleTutorialReady}
          steps={
            sampleTutorial === "bundle"
              ? getBundleSampleTutorialSteps(localizer)
              : getApplySampleTutorialSteps(localizer)
          }
        />
      ) : null}
    </section>
  );
}

export { ApplyWorkflowFormView };
