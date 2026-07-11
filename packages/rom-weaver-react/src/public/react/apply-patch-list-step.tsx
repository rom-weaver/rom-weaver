import Check from "lucide-react/dist/esm/icons/check.js";
import Crosshair from "lucide-react/dist/esm/icons/crosshair.js";
import GripVertical from "lucide-react/dist/esm/icons/grip-vertical.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { type ReactNode, useState } from "react";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { createTiming, formatTiming } from "../../storage/shared/timing.ts";
import { ChecksumList, ChecksumRow } from "./components/ds/checksum-list.tsx";
import { Drawer, DrawerMark, DrawerReadout } from "./components/ds/drawer.tsx";
import { ExtractDrawer, ExtractName } from "./components/ds/extraction-tree.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { InfoPopover, StepSection } from "./components/ds/layout.tsx";
import { StageStatus, stageBarValue, stagePercent, stageStatusLabel } from "./components/ds/staging-meta.tsx";
import { useListReorder } from "./components/ds/use-list-reorder.ts";
import type { PatcherStackController, PatcherUiController } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import type { NoticeState, PatcherUiState } from "./patcher-ui-state.ts";
import type { ManifestPatchMeta } from "./use-manifest-apply-session.ts";
import { toWorkflowFileProgressProps } from "./workflow-run-hooks.ts";

const TIMING_LABEL = (ms?: number) =>
  typeof ms === "number" && Number.isFinite(ms) ? formatTiming(createTiming(ms)) : "";
const CHECKSUM_TIMING_LABEL = (timing?: string, prefix = "Checksum") => (timing ? `${prefix} ${timing}` : undefined);

const PATCH_INPUT_VERIFICATION_LABELS: Record<string, string> = {
  "in crc32": "CRC32",
  "in md5": "MD5",
  "in min size": "MIN BYTES",
  "in sha-1": "SHA-1",
  "in sha1": "SHA-1",
  "in size": "BYTES",
};

const PATCH_OUTPUT_VERIFICATION_LABELS: Record<string, string> = {
  "out crc32": "CRC32",
  "out md5": "MD5",
  "out sha-1": "SHA-1",
  "out sha1": "SHA-1",
  "out size": "BYTES",
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

/** Requirement rows this patch will actually verify, per side: embedded/declared
 * hashes, sizes, and free-form validation notes. */
const getPatchVerificationRows = (item: PatchStackItemState) => {
  const inputRows: Array<{ label: string; value: string }> = [];
  const outputRows: Array<{ label: string; value: string }> = [];
  for (const entry of item.validationValues) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
      // "dry-run apply" marks scratch-copy validation - every patch gets it, so it never
      // renders as a per-type row; the drawer-header verdict already covers it.
      if (/dry-?run/i.test(entry)) continue;
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

/** Read-only Checks drawer for a patch that declares real requirements: the
 * INPUT / OUTPUT rows it will verify, with the dry-run verdict + timing riding
 * the drawer header. Requirement-less patches render no drawer - their verdict
 * rides the Options header instead. Authoring (editable check fields) stays in
 * the Options drawer. */
const PatchInfo = ({ item }: { item: PatchStackItemState }) => {
  const { inputRows, outputRows } = getPatchVerificationRows(item);
  if (!(inputRows.length || outputRows.length)) return null;
  const verifying = item.validationState === "verifying";
  const bad = item.validationState === "invalid";
  const ok = item.validationState === "valid";
  const match = ok ? { label: null, ok: true } : bad ? { label: null, ok: false } : undefined;
  return (
    <ChecksumList
      defaultOpen
      label="Checks"
      match={match}
      timing={CHECKSUM_TIMING_LABEL(item.checksumTiming, "Checks")}
      verifying={verifying}
    >
      {inputRows.length ? (
        <div className="ck-group">
          <div className="ck-group-head">
            <span>Input</span>
          </div>
          {inputRows.map((row) => (
            <ChecksumRow key={`input:${row.label}:${row.value}`} label={row.label} value={row.value} />
          ))}
        </div>
      ) : null}
      {outputRows.length ? (
        <div className="ck-group">
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

const CHECK_ALGORITHMS = ["crc32", "md5", "sha1"] as const;
const CHECK_LABELS = { crc32: "CRC32", md5: "MD5", sha1: "SHA-1" } as const;
const CHECK_HEX_LENGTHS = { crc32: 8, md5: 32, sha1: 40 } as const;

const normalizeCheckInput = (raw: string) => raw.trim().toLowerCase().replace(/^0x/, "");

const isValidCheckValue = (algorithm: (typeof CHECK_ALGORITHMS)[number], value: string) =>
  value.length === CHECK_HEX_LENGTHS[algorithm] && /^[0-9a-f]+$/.test(value);

/** Grow a textarea to its content (`field-sizing: content` isn't in every
 * target browser yet); runs on mount and on every input. */
const autosizeTextarea = (element: HTMLTextAreaElement | null) => {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight + 2}px`;
};

const getEmbeddedChecks = (item: PatchStackItemState, side: "input" | "output") => {
  const prefix = side === "input" ? "in " : "out ";
  const checks: Partial<Record<(typeof CHECK_ALGORITHMS)[number], string>> = {};
  for (const entry of item.validationValues) {
    const [rawLabel, rawValue] = entry.split("=", 2);
    const label = rawLabel?.trim().toLowerCase();
    const value = rawValue?.trim();
    if (!(label?.startsWith(prefix) && value)) continue;
    const algorithm = label.slice(prefix.length).replace("sha-1", "sha1");
    if (CHECK_ALGORITHMS.includes(algorithm as (typeof CHECK_ALGORITHMS)[number])) {
      checks[algorithm as (typeof CHECK_ALGORITHMS)[number]] = value;
    }
  }
  return checks;
};

const PatchOptions = ({
  disabled,
  index,
  isChainInput,
  isChainOutput,
  item,
  meta,
  onMetaChange,
  patchStack,
  showVerdict,
}: {
  /** The patch is toggled out of the run: verification state is not part of the
   * plan, so the header verdict/timing readouts stay off - the drawer remains
   * editable for manifest authors. */
  disabled?: boolean;
  index: number;
  /** First/last enabled patch in the stack: user-entered input checks on the chain
   * input verify the ROM live (and gate the apply); output checks on the chain
   * output verify the run's result. Mid-chain checks are metadata only - they
   * describe intermediates that cannot be verified before applying. */
  isChainInput?: boolean;
  isChainOutput?: boolean;
  item: PatchStackItemState;
  meta?: ManifestPatchMeta;
  onMetaChange?: (updates: Partial<ManifestPatchMeta>) => void;
  patchStack: PatcherStackController;
  /** Carry the dry-run verdict/timing on this header - off when the card renders
   * a Checks drawer, which owns the verdict instead. */
  showVerdict?: boolean;
}) => {
  const setOption = patchStack.setPatchOption;
  const [invalidChecks, setInvalidChecks] = useState<Record<string, boolean>>({});
  const stripHeaderChecked = item.headerChoice === "strip";
  const headerLabel = item.headerStrippedBytes
    ? `Strip ${item.headerStrippedBytes}-byte ROM header before patching`
    : "Strip ROM header before patching";
  const embeddedInput = getEmbeddedChecks(item, "input");
  const embeddedOutput = getEmbeddedChecks(item, "output");
  const commitCheck = (side: "input" | "output", algorithm: (typeof CHECK_ALGORITHMS)[number], raw: string) => {
    const value = normalizeCheckInput(raw);
    const fieldKey = `${side}:${algorithm}`;
    const invalid = !!value && !isValidCheckValue(algorithm, value);
    setInvalidChecks((previous) => (previous[fieldKey] === invalid ? previous : { ...previous, [fieldKey]: invalid }));
    if (invalid) return;
    const field = side === "input" ? "inputChecks" : "outputChecks";
    const checksums = { ...(meta?.[field]?.checksums || {}), [algorithm]: value };
    onMetaChange?.({ [field]: { ...(meta?.[field] || {}), checksums } });
    // A valid check on a chain endpoint feeds the run's validation option so the
    // ROM re-verifies immediately (card coloring) and the apply enforces it.
    const preferred = checksums.sha1 || checksums.md5 || checksums.crc32 || "";
    if (side === "input" && isChainInput) void setOption?.(index, { validateInputChecksum: preferred });
    if (side === "output" && isChainOutput) void setOption?.(index, { validateOutputChecksum: preferred });
  };
  // The dry-run verdict rides this drawer's header (pass/fail mark + timing, or a
  // "Verifying…" readout while the deferred dry-run runs) ONLY when the patch has no
  // Checks drawer of its own - a patch with real requirements carries the verdict
  // on that drawer instead.
  const verifying = !!showVerdict && !disabled && item.validationState === "verifying";
  const bad = !!showVerdict && !disabled && item.validationState === "invalid";
  const ok = !!showVerdict && !disabled && item.validationState === "valid";
  const timing = showVerdict && !disabled ? CHECKSUM_TIMING_LABEL(item.checksumTiming, "Checks") : undefined;
  return (
    <Drawer
      bodyClassName="optsbody"
      className="optsblock"
      label="Options"
      readouts={
        <>
          {item.format ? <DrawerReadout>{item.format}</DrawerReadout> : null}
          {verifying ? (
            <DrawerReadout muted>Verifying…</DrawerReadout>
          ) : (
            <>
              {timing ? <DrawerReadout time>{timing}</DrawerReadout> : null}
              {ok || bad ? (
                <DrawerMark
                  className={ok ? "cks-match" : "cks-match bad"}
                  ok={ok}
                  title={ok ? "Verified" : "Verification failed"}
                >
                  {ok ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
                </DrawerMark>
              ) : null}
            </>
          )}
        </>
      }
    >
      <div className="optsgrid">
        <div className="ofld patch-name-field">
          <label className="ofld-l" htmlFor={`rom-weaver-patch-name-${index}`}>
            Patch name
          </label>
          <input
            className="input popt-input"
            defaultValue={meta?.name || ""}
            id={`rom-weaver-patch-name-${index}`}
            key={`patch-name:${item.key ?? index}:${meta?.name || ""}`}
            onBlur={(event) => onMetaChange?.({ name: event.currentTarget.value.trim() || undefined })}
            placeholder={item.fileName.replace(/\.[^.]+$/, "")}
            type="text"
          />
        </div>
        <div className="ofld patch-description-field">
          <label className="ofld-l" htmlFor={`rom-weaver-patch-description-${index}`}>
            Description
          </label>
          <textarea
            className="input popt-input"
            defaultValue={meta?.description || ""}
            id={`rom-weaver-patch-description-${index}`}
            key={`patch-description:${item.key ?? index}:${meta?.description || ""}`}
            onBlur={(event) => onMetaChange?.({ description: event.currentTarget.value.trim() || undefined })}
            onInput={(event) => autosizeTextarea(event.currentTarget)}
            placeholder="What this patch changes"
            ref={autosizeTextarea}
            rows={1}
          />
        </div>
      </div>
      <div className="verification-pair">
        {(["input", "output"] as const).map((side) => {
          const embedded = side === "input" ? embeddedInput : embeddedOutput;
          const field = side === "input" ? "inputChecks" : "outputChecks";
          return (
            <div className="patch-check-group" key={side}>
              <div className="ck-group-head">
                <span>{side === "input" ? "Input verification" : "Output verification"}</span>
              </div>
              <div className="verification-list">
                {CHECK_ALGORITHMS.map((algorithm) => {
                  const builtIn = embedded[algorithm];
                  const value = builtIn || meta?.[field]?.checksums?.[algorithm] || "";
                  const invalid = !builtIn && !!invalidChecks[`${side}:${algorithm}`];
                  return (
                    <div className="verification-row" key={`${side}:${algorithm}`}>
                      <label className="ofld-l" htmlFor={`rom-weaver-patch-${side}-${algorithm}-${index}`}>
                        {CHECK_LABELS[algorithm]}
                        {builtIn ? <span className="built-in">Built in</span> : null}
                      </label>
                      <input
                        aria-invalid={invalid || undefined}
                        className="input mono popt-input"
                        defaultValue={value}
                        id={`rom-weaver-patch-${side}-${algorithm}-${index}`}
                        key={`${side}:${algorithm}:${item.key ?? index}:${value}`}
                        onBlur={
                          builtIn ? undefined : (event) => commitCheck(side, algorithm, event.currentTarget.value)
                        }
                        readOnly={!!builtIn}
                        spellCheck={false}
                        title={invalid ? `Expected ${CHECK_HEX_LENGTHS[algorithm]} hex characters` : value || undefined}
                        type="text"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {item.showHeaderOption ? (
        <div className="optschecks">
          <label
            className="popt"
            title="Patch the headerless bytes when this patch was authored against a ROM without its copier header. Whether the header appears on the final output is the output card's separate ROM header setting (auto keeps emulator-required headers, drops copier junk)."
          >
            <input
              checked={stripHeaderChecked}
              disabled={item.optionsDisabled}
              onChange={(event) => setOption?.(index, { header: event.currentTarget.checked ? "strip" : "keep" })}
              type="checkbox"
            />
            <span>{headerLabel}</span>
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

/** The patch's track/target on the meta line - inline select when there is a choice. */
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
  internalDescription,
  manifestMeta,
  onManifestMetaChange,
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
  /** Embedded description fallback for the first patch; manifest metadata wins. */
  internalDescription?: string;
  /** Per-index editable manifest metadata. */
  manifestMeta?: readonly (ManifestPatchMeta | undefined)[];
  onManifestMetaChange?: (index: number, updates: Partial<ManifestPatchMeta>) => void;
  onTogglePatch?: (index: number) => void;
  patchInput: PatcherUiState["patchInput"];
  patchNotice: NoticeState;
  patches: PatchStackItemState[];
  patchStack: PatcherStackController;
  ui: PatcherUiController;
  woven?: boolean;
}) => {
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
  // Chain endpoints among the ENABLED patches: the first one's input checks
  // describe the base ROM, the last one's output checks describe the run's
  // final result - the only two states verifiable without applying.
  const enabledIndexes = patches
    .map((_, patchIndex) => patchIndex)
    .filter((patchIndex) => !disabledFlags?.[patchIndex]);
  const chainInputIndex = enabledIndexes[0] ?? -1;
  const chainOutputIndex = enabledIndexes[enabledIndexes.length - 1] ?? -1;
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
          const description = manifestMeta?.[index]?.description || (index === 0 ? internalDescription : "");
          // Mirrors the ROM card: the resolved card structure (collapsed Extract +
          // Options drawers) stays mounted through staging - a determinate bar on the
          // top edge + a "Reading…" status in the meta line carry progress - so the
          // stack doesn't jump when the result lands.
          // The bar stays full once finished. Staging a patch is extract
          // (if archived) + parse - the patch is never hashed - so this reads "Reading",
          // not "Checksumming" (a ROM-only phase) or "Validating" (the deferred dry-run).
          const staging = !!item.progress;
          const stagingProps = staging ? toWorkflowFileProgressProps(item.progress) : null;
          const percent = stagePercent(stagingProps);
          // A patch pulled from a container archive extracts before it is parsed; the
          // runtime labels that stage "extracting …". (Patch rows have no validationPhase,
          // so the label is the available signal here - unlike ROM inputs.)
          const patchExtracting = /extract/i.test(String(stagingProps?.label ?? ""));
          const rowProps = reorderList.rowProps(index);
          const isDisabled = !!disabledFlags?.[index];
          const disabledClass = isDisabled ? "is-disabled" : undefined;
          // A disabled patch is out of the run: its (stale) verification verdict
          // stays off the card, and the body keeps only the Options drawer so
          // manifest authors can still edit name/description/checks.
          let verdict: "bad" | "ok" | undefined;
          if (item.validationState === "invalid") verdict = "bad";
          else if (item.validationState === "valid") verdict = "ok";
          if (isDisabled) verdict = undefined;
          // Verification is the second phase: once the ROM is ready, the deferred dry-run runs while
          // the card already shows its full body (Extract + Options). A top-edge bar carries
          // that async work - a later phase following the "Reading…" staging bar.
          const verifying = !(staging || isDisabled) && item.validationState === "verifying";
          // A read-only Checks drawer appears once the patch declares real requirements
          // (embedded hashes, sizes, validation notes) - it owns the dry-run verdict, so
          // the Options header only carries it for requirement-less patches. Disabled
          // patches keep just the Options drawer.
          const checksRows = getPatchVerificationRows(item);
          const hasChecksDrawer = !isDisabled && !!(checksRows.inputRows.length || checksRows.outputRows.length);
          return (
            <FileCard
              key={item.key ?? `${index}:${item.fileName}`}
              {...rowProps}
              className={[rowProps.className, disabledClass].filter(Boolean).join(" ") || undefined}
              description={
                description ? (
                  <p className="patch-desc" id={`rom-weaver-patch-card-description-${index}`}>
                    {description}
                  </p>
                ) : undefined
              }
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
                  {manifestMeta?.[index]?.label ? (
                    <span className="meta-fmt mono">{manifestMeta[index]?.label}</span>
                  ) : null}
                  {staging ? (
                    <StageStatus
                      id={`rom-weaver-progress-patch-${index}`}
                      label={stageStatusLabel("Reading", patchExtracting)}
                      percent={percent}
                    />
                  ) : null}
                </>
              }
              name={
                <ExtractName
                  displayName={manifestMeta?.[index]?.name}
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
              verifyBar={verifying}
            >
              <div className="patch-body">
                <div className="patch-body-inner">
                  {verdict === "bad" ? (
                    <div className="pverdict dryrun-verdict bad">
                      <X aria-hidden="true" />
                      <span>{item.validationMessage || "Patch validation failed"}</span>
                    </div>
                  ) : null}
                  {isDisabled ? null : (
                    <ExtractDrawer
                      always={!!manifestMeta?.[index]}
                      fileName={item.fileName}
                      fileSize={item.fileSize}
                      parentCompressions={item.archivePathEntries}
                      timing={TIMING_LABEL(item.decompressionTimeMs)}
                    />
                  )}
                  <PatchOptions
                    disabled={isDisabled}
                    index={index}
                    isChainInput={index === chainInputIndex}
                    isChainOutput={index === chainOutputIndex}
                    item={item}
                    meta={manifestMeta?.[index]}
                    onMetaChange={onManifestMetaChange ? (updates) => onManifestMetaChange(index, updates) : undefined}
                    patchStack={patchStack}
                    showVerdict={!hasChecksDrawer}
                  />
                  {hasChecksDrawer ? <PatchInfo item={item} /> : null}
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
