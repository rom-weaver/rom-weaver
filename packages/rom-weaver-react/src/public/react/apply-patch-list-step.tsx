import Check from "lucide-react/dist/esm/icons/check.js";
import Crosshair from "lucide-react/dist/esm/icons/crosshair.js";
import Pencil from "lucide-react/dist/esm/icons/pencil.js";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { InfoToggle } from "../../presentation/react/info-toggle.tsx";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { createTiming, formatTiming } from "../../storage/shared/timing.ts";
import {
  CHECK_ALGORITHMS,
  type CHECK_FIELDS,
  CHECK_FIELDS_PAIRED,
  CHECK_HEX_LENGTHS,
  CHECK_LABELS,
  isValidCheckValue,
  normalizeCheckInput,
} from "./components/ds/check-fields.ts";
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
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";
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
  const xdeltaSizeOnly = item.validationValues.some((entry) => /^in min size=/i.test(entry));
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
    if (xdeltaSizeOnly && (rawLabel === "in min size" || rawLabel === "out size")) continue;
    if (PATCH_INPUT_VERIFICATION_LABELS[rawLabel]) {
      inputRows.push({ label: PATCH_INPUT_VERIFICATION_LABELS[rawLabel], value });
      continue;
    }
    outputRows.push({ label: PATCH_OUTPUT_VERIFICATION_LABELS[rawLabel] || rawLabel.toUpperCase(), value });
  }
  // BYTES pairs with CRC32 on one grid row, so it rides directly after it;
  // with no CRC32 requirement the size row keeps its end-of-list spot.
  const bytesAfterCrc32 = (rows: typeof inputRows) => {
    const bytes = rows.filter((row) => row.label === "BYTES");
    if (!bytes.length) return rows;
    const rest = rows.filter((row) => row.label !== "BYTES");
    const crcIndex = rest.findIndex((row) => row.label === "CRC32");
    if (crcIndex === -1) return [...rest, ...bytes];
    return [...rest.slice(0, crcIndex + 1), ...bytes, ...rest.slice(crcIndex + 1)];
  };
  return { inputRows: bytesAfterCrc32(inputRows), outputRows: bytesAfterCrc32(outputRows) };
};

/* The dry-run's "validation failed: " lead-in duplicates the well's title -
   strip it and re-capitalize what remains so the detail reads as a sentence. */
const toFaultDetail = (message: string): string => {
  const detail = message.replace(/^\s*validation failed:?\s*/i, "").trim();
  if (!detail) return "The patch's checks did not match this ROM.";
  return detail.charAt(0).toUpperCase() + detail.slice(1);
};

/** Failed dry-run verdict: an inset fault well with the verdict, the detail,
 * and what to do next (naming the 0x04 override toggle when it is offered). */
const PatchFaultWell = ({ message, overrideAvailable }: { message: string; overrideAvailable?: boolean }) => (
  <div className="pverdict pfault">
    <div className="pfault-title">
      <X aria-hidden="true" />
      <span>Validation failed</span>
    </div>
    <p className="pfault-detail">{toFaultDetail(message)}</p>
    <p className="pfault-hint">
      {overrideAvailable
        ? "Pick the ROM this patch was made for, or use “Apply anyway despite patch & ROM check mismatch” in 0x04."
        : "Pick the ROM this patch was made for."}
    </p>
  </div>
);

const DryApplySuccess = () => (
  <InfoToggle
    ariaLabel="Dry apply passed"
    className="dry-apply-info"
    icon={<Check aria-hidden="true" />}
    panelClassName="dry-apply-pop"
    portalPanel
    title="Dry apply passed"
  >
    <strong>Dry apply passed</strong>
    <p>rom-weaver successfully applied this patch to a temporary copy of the current input.</p>
    <p>The real output has not been created yet.</p>
  </InfoToggle>
);

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
  const compact =
    inputRows.length > 0 &&
    outputRows.length > 0 &&
    [...inputRows, ...outputRows].every((row) => String(row.value).length < 16);
  return (
    <ChecksumList
      action={ok ? <DryApplySuccess /> : undefined}
      bodyClassName={compact ? "ckrows patch-check-columns" : undefined}
      defaultOpen
      label="Checks"
      match={ok ? undefined : match}
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

/** Grow a textarea to its content (`field-sizing: content` isn't in every
 * target browser yet); runs on mount and on every input. */
const autosizeTextarea = (element: HTMLTextAreaElement | null) => {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight + 2}px`;
};

const getEmbeddedChecks = (item: PatchStackItemState, side: "input" | "output") => {
  const prefix = side === "input" ? "in " : "out ";
  const checks: Partial<Record<(typeof CHECK_FIELDS)[number], string>> = {};
  for (const entry of item.validationValues) {
    const [rawLabel, rawValue] = entry.split("=", 2);
    const label = rawLabel?.trim().toLowerCase();
    const value = rawValue?.trim();
    if (!(label?.startsWith(prefix) && value)) continue;
    const algorithm = label.slice(prefix.length).replace("sha-1", "sha1");
    // exact byte size only - "min size" is a lower bound, not a bytes value
    if (algorithm === "size") {
      checks.bytes = value;
      continue;
    }
    if (CHECK_ALGORITHMS.includes(algorithm as (typeof CHECK_ALGORITHMS)[number])) {
      checks[algorithm as (typeof CHECK_ALGORITHMS)[number]] = value;
    }
  }
  return checks;
};

type PatchMetaFieldProps = {
  index: number;
  item: PatchStackItemState;
  meta?: BundlePatchMeta;
  onMetaChange: (updates: Partial<BundlePatchMeta>) => void;
};

/** Bundle-edit mode: the card title IS the patch's display name, edited in
 * place (placeholder = the file name it falls back to). */
const PatchNameInline = ({ index, item, meta, onMetaChange }: PatchMetaFieldProps) => (
  <span className="nm-edit">
    <input
      aria-label="Patch name"
      className="nm-input"
      defaultValue={meta?.name || ""}
      id={`rom-weaver-patch-name-${index}`}
      key={`patch-name:${item.key ?? index}:${meta?.name || ""}`}
      onBlur={(event) => onMetaChange({ name: event.currentTarget.value.trim() || undefined })}
      placeholder={item.fileName.replace(/\.[^.]+$/, "")}
      spellCheck={false}
      type="text"
    />
    <Pencil aria-hidden="true" className="nm-edit-glyph" />
  </span>
);

/** Bundle-edit mode: the description sits inline on the card (in place of the
 * static description line), not tucked inside the Options drawer. */
const PatchMetaFields = ({ index, item, meta, onMetaChange }: PatchMetaFieldProps) => (
  <div className="patch-meta-inline">
    <div className="ofld patch-description-field">
      <label className="ofld-l" htmlFor={`rom-weaver-patch-description-${index}`}>
        Description
      </label>
      <textarea
        className="input popt-input"
        defaultValue={meta?.description || ""}
        id={`rom-weaver-patch-description-${index}`}
        key={`patch-description:${item.key ?? index}:${meta?.description || ""}`}
        onBlur={(event) => onMetaChange({ description: event.currentTarget.value.trim() || undefined })}
        onInput={(event) => autosizeTextarea(event.currentTarget)}
        placeholder="What this patch changes"
        ref={autosizeTextarea}
        rows={1}
      />
    </div>
  </div>
);

const PatchOptions = ({
  disabled,
  editMode,
  index,
  isChainInput,
  isChainOutput,
  item,
  meta,
  onMetaChange,
  outputCheckHint,
  patchStack,
  showVerdict,
}: {
  /** The patch is toggled out of the run: verification state is not part of the
   * plan, so the header verdict/timing readouts stay off - the drawer remains
   * editable for bundle authors. */
  disabled?: boolean;
  /** Bundle-edit mode: the authoring fields (name/description + editable check
   * grids) render only inside the editor - the plain apply view keeps the
   * drawer to its functional options. */
  editMode?: boolean;
  index: number;
  /** First/last enabled patch in the stack: user-entered input checks on the chain
   * input verify the ROM live (and gate the apply); output checks on the chain
   * output verify the run's result. Mid-chain checks are metadata only - they
   * describe intermediates that cannot be verified before applying. */
  isChainInput?: boolean;
  isChainOutput?: boolean;
  item: PatchStackItemState;
  meta?: BundlePatchMeta;
  onMetaChange?: (updates: Partial<BundlePatchMeta>) => void;
  /** Chain-output card of a bundle with optional patches: remind the author the
   * expected output only describes the full chain. */
  outputCheckHint?: boolean;
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
  // The bytes field carries the endpoint's exact size into the bundle metadata
  // (inputChecks/outputChecks.size); it is descriptive, not a live run gate.
  const commitSize = (side: "input" | "output", raw: string) => {
    const value = raw.trim();
    const fieldKey = `${side}:bytes`;
    const invalid = !!value && !/^\d+$/.test(value);
    setInvalidChecks((previous) => (previous[fieldKey] === invalid ? previous : { ...previous, [fieldKey]: invalid }));
    if (invalid) return;
    const field = side === "input" ? "inputChecks" : "outputChecks";
    onMetaChange?.({ [field]: { ...(meta?.[field] || {}), size: value ? Number(value) : undefined } });
  };
  // The dry-run verdict rides this drawer's header (pass/fail mark + timing, or a
  // "Verifying…" readout while the deferred dry-run runs) ONLY when the patch has no
  // Checks drawer of its own - a patch with real requirements carries the verdict
  // on that drawer instead.
  const verifying = !!showVerdict && !disabled && item.validationState === "verifying";
  const bad = !!showVerdict && !disabled && item.validationState === "invalid";
  const ok = !!showVerdict && !disabled && item.validationState === "valid";
  const timing = showVerdict && !disabled ? CHECKSUM_TIMING_LABEL(item.checksumTiming, "Checks") : undefined;
  // Outside the bundle editor a patch without a header choice has no options at
  // all - skip the drawer instead of rendering an empty body (the card state /
  // verify bar / fault well already carry the dry-run verdict).
  if (!(editMode || item.showHeaderOption)) return null;
  return (
    <Drawer
      action={ok ? <DryApplySuccess /> : undefined}
      bodyClassName="optsbody"
      className="optsblock"
      label="Options"
      labelIcon={<SlidersHorizontal aria-hidden="true" className="tune" />}
      readouts={
        <>
          {item.format ? <DrawerReadout>{item.format}</DrawerReadout> : null}
          {verifying ? (
            <DrawerReadout muted>Verifying…</DrawerReadout>
          ) : (
            <>
              {timing ? <DrawerReadout time>{timing}</DrawerReadout> : null}
              {bad ? (
                <DrawerMark className="cks-match bad" ok={false} title="Verification failed">
                  <X aria-hidden="true" />
                </DrawerMark>
              ) : null}
            </>
          )}
        </>
      }
    >
      {editMode ? (
        <>
          <div className="verification-pair">
            {(["input", "output"] as const).map((side) => {
              const embedded = side === "input" ? embeddedInput : embeddedOutput;
              const field = side === "input" ? "inputChecks" : "outputChecks";
              return (
                <div className="patch-check-group" key={side}>
                  <div className="ck-group-head">
                    <span>{side === "input" ? "Input verification" : "Output verification"}</span>
                  </div>
                  <div className="verification-list ck-fields-paired">
                    {CHECK_FIELDS_PAIRED.map((checkField) => {
                      const isBytes = checkField === "bytes";
                      const builtIn = embedded[checkField];
                      const metaValue = isBytes
                        ? typeof meta?.[field]?.size === "number"
                          ? String(meta?.[field]?.size)
                          : ""
                        : meta?.[field]?.checksums?.[checkField] || "";
                      const value = builtIn || metaValue;
                      const invalid = !builtIn && !!invalidChecks[`${side}:${checkField}`];
                      return (
                        <div className="verification-row" key={`${side}:${checkField}`}>
                          <label className="ofld-l" htmlFor={`rom-weaver-patch-${side}-${checkField}-${index}`}>
                            {CHECK_LABELS[checkField]}
                            {builtIn ? <span className="built-in">Built in</span> : null}
                          </label>
                          <input
                            aria-invalid={invalid || undefined}
                            className="input mono popt-input"
                            defaultValue={value}
                            id={`rom-weaver-patch-${side}-${checkField}-${index}`}
                            key={`${side}:${checkField}:${item.key ?? index}:${value}`}
                            onBlur={
                              builtIn
                                ? undefined
                                : (event) =>
                                    isBytes
                                      ? commitSize(side, event.currentTarget.value)
                                      : commitCheck(side, checkField, event.currentTarget.value)
                            }
                            readOnly={!!builtIn}
                            spellCheck={false}
                            title={
                              invalid
                                ? isBytes
                                  ? "Expected a whole number of bytes"
                                  : `Expected ${CHECK_HEX_LENGTHS[checkField]} hex characters`
                                : value || undefined
                            }
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
          {outputCheckHint ? (
            <p className="hintline" id={`rom-weaver-patch-output-check-hint-${index}`}>
              The expected output is verified only when every patch in the bundle is applied.
            </p>
          ) : null}
        </>
      ) : null}
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

/** Numbered drag target that turns into a position editor on click. */
const PatchDragHandle = ({
  disabled,
  handleProps,
  index,
  onReorder,
  position,
  total,
}: {
  disabled: boolean;
  handleProps: ReorderHandleProps;
  index: number;
  onReorder: (from: number, to: number) => void;
  position: number;
  total: number;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(position));
  const cancelEditRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.select();

    const keepInputVisible = () => {
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const rect = input.getBoundingClientRect();
      const margin = 24;
      if (rect.top < viewportTop + margin || rect.bottom > viewportBottom - margin) {
        input.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      }
    };
    const frame = window.requestAnimationFrame(keepInputVisible);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", keepInputVisible);
    viewport?.addEventListener("scroll", keepInputVisible);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", keepInputVisible);
      viewport?.removeEventListener("scroll", keepInputVisible);
    };
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (cancelEditRef.current) {
      cancelEditRef.current = false;
      return;
    }
    const position = Number.parseInt(draft, 10);
    if (!Number.isInteger(position)) return;
    const target = Math.max(1, Math.min(total, position)) - 1;
    if (target !== index) onReorder(index, target);
  };

  if (editing) {
    return (
      <input
        aria-label={`Edit patch position, currently ${position} of ${total}`}
        className="handle phandle phandle-input mono"
        max={total}
        min={1}
        onBlur={commit}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelEditRef.current = true;
            event.currentTarget.blur();
          }
        }}
        ref={inputRef}
        type="number"
        value={draft}
      />
    );
  }

  return (
    <button
      aria-label={
        disabled
          ? `Patch ${position} of ${total}. Reordering unavailable.`
          : `Patch ${position} of ${total}. Drag to reorder, click to edit its position, or press the up and down arrow keys.`
      }
      className="handle phandle"
      {...handleProps}
      disabled={disabled}
      onClick={(event) => {
        handleProps.onClick?.(event);
        if (event.defaultPrevented) return;
        setDraft(String(position));
        setEditing(true);
      }}
      title={disabled ? "Patch position" : "Drag to reorder · click to edit position · ↑ / ↓ keys"}
      type="button"
    >
      <span aria-hidden="true" className="phandle-number mono">
        {position}
      </span>
    </button>
  );
};

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
  bundleEditMode,
  bundleOutputCheckHint,
  disabledFlags,
  emptyState,
  fault,
  internalDescription,
  bundleMeta,
  onBundleMetaChange,
  onTogglePatch,
  overrideAvailable,
  patchInput,
  patchNotice,
  patches,
  patchStack,
  ui,
  woven,
}: {
  /** Bundle-edit mode: reveal the per-patch authoring fields. */
  bundleEditMode?: boolean;
  /** The bundle has optional patches: hint on the chain-output card that its
   * expected output only describes the full chain. */
  bundleOutputCheckHint?: boolean;
  disabledFlags?: readonly boolean[];
  /** Fixture shown when no patches (and no embedded/optional patch choices) are present. */
  emptyState?: ReactNode;
  fault?: boolean;
  /** Embedded description fallback for the first patch; bundle metadata wins. */
  internalDescription?: string;
  /** Per-index editable bundle metadata. */
  bundleMeta?: readonly (BundlePatchMeta | undefined)[];
  onBundleMetaChange?: (index: number, updates: Partial<BundlePatchMeta>) => void;
  onTogglePatch?: (index: number) => void;
  /** The 0x04 "Apply anyway…" override toggle is on offer - fault hints name it. */
  overrideAvailable?: boolean;
  patchInput: PatcherUiState["patchInput"];
  patchNotice: NoticeState;
  patches: PatchStackItemState[];
  patchStack: PatcherStackController;
  ui: PatcherUiController;
  woven?: boolean;
}) => {
  const total = patches.length;
  // Reordering only makes sense for a multi-patch stack. A patch may still be
  // moved while it is staging; other busy/locked rows remain non-reorderable.
  const reorderable = total > 1;
  const canReorder = reorderable && patches.every((item) => item.progress || item.canRemove);
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
          const description = bundleMeta?.[index]?.description || (index === 0 ? internalDescription : "");
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
          // bundle authors can still edit name/description/checks.
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
                description && !bundleEditMode ? (
                  <p className="patch-desc" id={`rom-weaver-patch-card-description-${index}`}>
                    {description}
                  </p>
                ) : undefined
              }
              handle={
                <PatchDragHandle
                  disabled={!canReorder}
                  handleProps={reorderList.handleProps(index)}
                  index={index}
                  onReorder={patchStack.reorder}
                  position={reorderList.displayIndex(index) + 1}
                  total={total}
                />
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
                  {bundleMeta?.[index]?.label ? (
                    <span className="meta-fmt mono">{bundleMeta[index]?.label}</span>
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
                  displayName={bundleEditMode ? undefined : bundleMeta?.[index]?.name}
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
                  nameEditor={
                    bundleEditMode && onBundleMetaChange ? (
                      <PatchNameInline
                        index={index}
                        item={item}
                        meta={bundleMeta?.[index]}
                        onMetaChange={(updates) => onBundleMetaChange(index, updates)}
                      />
                    ) : undefined
                  }
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
                    <PatchFaultWell message={item.validationMessage} overrideAvailable={overrideAvailable} />
                  ) : null}
                  {bundleEditMode && onBundleMetaChange ? (
                    <PatchMetaFields
                      index={index}
                      item={item}
                      meta={bundleMeta?.[index]}
                      onMetaChange={(updates) => onBundleMetaChange(index, updates)}
                    />
                  ) : null}
                  {isDisabled ? null : (
                    <ExtractDrawer
                      always={!!bundleMeta?.[index] || (staging && patchExtracting)}
                      fileName={item.fileName}
                      fileSize={item.fileSize}
                      parentCompressions={item.archivePathEntries}
                      timing={TIMING_LABEL(item.decompressionTimeMs)}
                    />
                  )}
                  <PatchOptions
                    disabled={isDisabled}
                    editMode={bundleEditMode}
                    index={index}
                    isChainInput={index === chainInputIndex}
                    isChainOutput={index === chainOutputIndex}
                    item={item}
                    meta={bundleMeta?.[index]}
                    onMetaChange={onBundleMetaChange ? (updates) => onBundleMetaChange(index, updates) : undefined}
                    outputCheckHint={!!bundleOutputCheckHint && index === chainOutputIndex}
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
