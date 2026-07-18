import ArrowLeftRight from "lucide-react/dist/esm/icons/arrow-left-right.js";
import Check from "lucide-react/dist/esm/icons/check.js";
import Crosshair from "lucide-react/dist/esm/icons/crosshair.js";
import EllipsisVertical from "lucide-react/dist/esm/icons/ellipsis-vertical.js";
import Pencil from "lucide-react/dist/esm/icons/pencil.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Scissors from "lucide-react/dist/esm/icons/scissors.js";
import Tag from "lucide-react/dist/esm/icons/tag.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import UserRound from "lucide-react/dist/esm/icons/user-round.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Localizer } from "../../presentation/localization/index.ts";
import { InfoToggle } from "../../presentation/react/info-toggle.tsx";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { createTiming, formatTiming } from "../../storage/shared/timing.ts";
import {
  CHECK_ALGORITHMS,
  type CHECK_FIELDS,
  CHECK_FIELDS_PAIRED,
  CHECK_HEX_LENGTHS,
  CHECK_LABELS,
  type CheckAlgorithm,
  type CheckField,
  isValidCheckValue,
  normalizeCheckInput,
} from "./components/ds/check-fields.ts";
import { ChecksumList, ChecksumRow } from "./components/ds/checksum-list.tsx";
import { ExtractDrawer, ExtractName } from "./components/ds/extraction-tree.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { InfoPopover, StepSection } from "./components/ds/layout.tsx";
import { StageStatus, stageBarValue, stagePercent, stageStatusLabel } from "./components/ds/staging-meta.tsx";
import { useListReorder } from "./components/ds/use-list-reorder.ts";
import type { PatcherStackController, PatcherUiController } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import type { NoticeState, PatcherUiState } from "./patcher-ui-state.ts";
import { useUiLocalizer } from "./settings-context.tsx";
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
      // The generic preflight marker never renders as a per-type row; the drawer-header verdict
      // already covers it.
      if (/preflight|dry-?run/i.test(entry)) continue;
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
        ? "Pick the ROM this patch was made for, or use “Weave anyway despite patch & ROM check mismatch” in 0x04."
        : "Pick the ROM this patch was made for."}
    </p>
  </div>
);

const PreflightSuccess = () => (
  <InfoToggle
    ariaLabel="Preflight passed"
    className="dry-apply-info"
    icon={<Check aria-hidden="true" />}
    panelClassName="dry-apply-pop"
    portalPanel
    title="Preflight passed"
  >
    <strong>Preflight passed</strong>
    <p>rom-weaver verified this patch against the current input.</p>
    <p>The real output has not been created yet.</p>
  </InfoToggle>
);

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

/** A single-line commit input for the meta form: trims on blur, Enter commits. */
const PatchMetaTextField = ({
  field,
  index,
  item,
  label,
  meta,
  onMetaChange,
  onSubmit,
  placeholder,
}: PatchMetaFieldProps & {
  field: "name" | "version" | "author";
  label: string;
  onSubmit: () => void;
  placeholder: string;
}) => (
  <div className={`ofld patch-meta-field patch-${field}-meta-field`}>
    <label className="ofld-l" htmlFor={`rom-weaver-patch-${field}-${index}`}>
      {label}
    </label>
    <input
      className="input popt-input"
      defaultValue={meta?.[field] || ""}
      id={`rom-weaver-patch-${field}-${index}`}
      key={`patch-${field}:${item.key ?? index}:${meta?.[field] || ""}`}
      onBlur={(event) => onMetaChange({ [field]: event.currentTarget.value.trim() || undefined })}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
          onSubmit();
        }
      }}
      placeholder={placeholder}
      spellCheck={false}
      type="text"
    />
  </div>
);

/** Pencil-editing a card: ONE form holding every editable patch field - name,
 * description, version, author - in place of the static description line.
 * Each field commits on blur; Enter commits and closes the form (Shift+Enter
 * keeps a newline in the description). */
const PatchMetaFields = ({
  index,
  item,
  meta,
  onMetaChange,
  onSubmit,
}: PatchMetaFieldProps & { onSubmit: () => void }) => (
  <div className="patch-meta-inline">
    <PatchMetaTextField
      field="name"
      index={index}
      item={item}
      label="Name"
      meta={meta}
      onMetaChange={onMetaChange}
      onSubmit={onSubmit}
      placeholder={item.fileName.replace(/\.[^.]+$/, "")}
    />
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
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.blur();
            onSubmit();
          }
        }}
        placeholder="What this patch changes"
        ref={autosizeTextarea}
        rows={1}
      />
    </div>
    <div className="patch-meta-cols">
      <PatchMetaTextField
        field="version"
        index={index}
        item={item}
        label="Version"
        meta={meta}
        onMetaChange={onMetaChange}
        onSubmit={onSubmit}
        placeholder="1.0"
      />
      <PatchMetaTextField
        field="author"
        index={index}
        item={item}
        label="Author"
        meta={meta}
        onMetaChange={onMetaChange}
        onSubmit={onSubmit}
        placeholder="Who made it"
      />
    </div>
  </div>
);

/** The ROM-header handling select on the patch card's meta line (beside the
 * On/Off switch): Auto (the engine's checksum-driven decision,
 * labeled with its outcome when it decided), or an explicit Keep/Strip pin.
 * Only rendered when the target ROM actually has a strippable header. */
const PatchHeaderModeSelect = ({
  index,
  item,
  patchStack,
}: {
  index: number;
  item: PatchStackItemState;
  patchStack: PatcherStackController;
}) => {
  if (!item.showHeaderOption) return null;
  const headerNoun = item.headerStrippedBytes ? `${item.headerStrippedBytes} B header` : "header";
  const autoLabel = `header auto (${item.headerAutoDecided ? item.headerAutoMode || "keep" : "keep"})`;
  return (
    <span className="target-grp header-grp">
      <Scissors aria-hidden="true" />
      <label className="sr-only" htmlFor={`rom-weaver-patch-header-mode-${index}`}>
        ROM header handling before patching
      </label>
      <select
        className="meta-target-select mono ptgt-sel"
        disabled={item.optionsDisabled}
        id={`rom-weaver-patch-header-mode-${index}`}
        onChange={(event) => {
          const next = event.currentTarget.value;
          // Auto clears the pin - the engine's checksum-driven decision applies again.
          void patchStack.setPatchOption?.(index, {
            header: next === "keep" || next === "strip" ? next : undefined,
            revalidate: true,
          });
        }}
        title="Strip patches the headerless bytes when the patch was authored against a ROM without its copier header. Whether the header appears on the final output is the output card's separate ROM header setting."
        value={item.headerChoice ?? "auto"}
      >
        <option value="auto">{autoLabel}</option>
        <option value="keep">keep {headerNoun}</option>
        <option value="strip">strip {headerNoun}</option>
      </select>
    </span>
  );
};

const N64_ORDER_LABELS = {
  "big-endian": "big endian (.z64)",
  "byte-swapped": "byte-swapped (.v64)",
  "little-endian": "little endian (.n64)",
  keep: "keep current",
} as const;

const PatchN64ByteOrderSelect = ({
  index,
  item,
  patchStack,
}: {
  index: number;
  item: PatchStackItemState;
  patchStack: PatcherStackController;
}) => {
  if (!item.showN64ByteOrderOption) return null;
  const autoMode = item.n64AutoMode || "keep";
  const autoLabel = `byte order auto (${N64_ORDER_LABELS[autoMode]})`;
  const sourceLabel = item.n64SourceOrder ? N64_ORDER_LABELS[item.n64SourceOrder] : "current order";
  return (
    <span className="target-grp header-grp">
      <ArrowLeftRight aria-hidden="true" />
      <label className="sr-only" htmlFor={`rom-weaver-patch-n64-byte-order-${index}`}>
        N64 byte order before patching
      </label>
      <select
        className="meta-target-select mono ptgt-sel"
        disabled={item.optionsDisabled}
        id={`rom-weaver-patch-n64-byte-order-${index}`}
        onChange={(event) => {
          const next = event.currentTarget.value;
          void patchStack.setPatchOption?.(index, {
            n64ByteOrder:
              next === "keep" || next === "big-endian" || next === "little-endian" || next === "byte-swapped"
                ? next
                : undefined,
            revalidate: true,
          });
        }}
        title="Auto matches the patch's required source checksum against all three N64 byte orders. The original ROM order is restored on output."
        value={item.n64ByteOrderChoice ?? "auto"}
      >
        <option value="auto">{autoLabel}</option>
        <option value="keep">keep current ({sourceLabel})</option>
        <option value="big-endian">{N64_ORDER_LABELS["big-endian"]}</option>
        <option value="byte-swapped">{N64_ORDER_LABELS["byte-swapped"]}</option>
        <option value="little-endian">{N64_ORDER_LABELS["little-endian"]}</option>
      </select>
    </span>
  );
};

/** A ROM's computed identity values, used to verify user-entered input checks. */
type RomCheckActuals = { crc32?: string; md5?: string; sha1?: string; bytes?: number };

/** Compare a committed (already-valid) input check to the real ROM value.
 * Returns undefined when there is nothing to compare against (the ROM value has
 * not been computed, or the field is empty). */
const matchInputCheck = (field: CheckField, value: string, actuals?: RomCheckActuals): "bad" | "ok" | undefined => {
  if (!(actuals && value)) return undefined;
  if (field === "bytes") {
    if (typeof actuals.bytes !== "number") return undefined;
    return Number(value) === actuals.bytes ? "ok" : "bad";
  }
  const actual = (actuals[field] || "").trim().toLowerCase();
  if (!actual) return undefined;
  return normalizeCheckInput(value) === actual ? "ok" : "bad";
};

/** Why a committed check value failed validation - shown inline under the field
 * and as its title. */
const checkErrorMessage = (field: CheckField): string =>
  field === "bytes"
    ? "Expected a whole number of bytes"
    : `Expected ${CHECK_HEX_LENGTHS[field as CheckAlgorithm]} hex characters`;

/** An editable expected-check field (user-specified, not built into the patch):
 * commits on blur, removable via the trailing X. A malformed value shows an
 * inline error; a well-formed value that was compared to the real ROM shows a
 * match/mismatch mark. */
const EditableCheckRow = ({
  focusOnMount,
  field,
  id,
  invalid,
  mark,
  onCommit,
  onRemove,
  value,
}: {
  /** A field just opened via "Add check": move focus into it (a user-gesture
   * focus handoff, not a page-load autofocus). */
  focusOnMount?: boolean;
  field: CheckField;
  id: string;
  invalid: boolean;
  /** Verdict of comparing this (valid) value to the real ROM value; undefined
   * when there is nothing to compare against yet. */
  mark?: "bad" | "ok";
  onCommit: (raw: string) => void;
  onRemove: () => void;
  value: string;
}) => {
  const errorId = `${id}-err`;
  return (
    <div className="verification-row" key={`${id}:${value}`}>
      <label className="ofld-l" htmlFor={id}>
        {CHECK_LABELS[field]}
      </label>
      <input
        aria-describedby={invalid ? errorId : undefined}
        aria-invalid={invalid || undefined}
        className="input mono popt-input"
        defaultValue={value}
        id={id}
        onBlur={(event) => onCommit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        ref={focusOnMount ? (element) => element?.focus() : undefined}
        spellCheck={false}
        title={invalid ? checkErrorMessage(field) : value || undefined}
        type="text"
      />
      <span className="vrow-tail">
        {mark && !invalid ? (
          <span className={`ck-mark ${mark}`} title={mark === "ok" ? "Matches the ROM" : "Does not match the ROM"}>
            {mark === "ok" ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
            <span className="sr-only">{mark === "ok" ? "matches the ROM" : "does not match the ROM"}</span>
          </span>
        ) : null}
        <button
          aria-label={`Remove ${CHECK_LABELS[field]} check`}
          className="ck-remove"
          onClick={onRemove}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </span>
      {invalid ? (
        <p className="ck-err" id={errorId}>
          {checkErrorMessage(field)}
        </p>
      ) : null}
    </div>
  );
};

/**
 * The one Checks drawer every patch card carries: the requirements built into
 * the patch file (read-only rows), the user's own expected checks (editable,
 * addable per side), and the ROM-header handling when the target has a
 * strippable header. The dry-run verdict + timing ride the drawer header.
 * User checks always export with the bundle; on the chain endpoints they also
 * gate the live run (input checks verify the ROM, output checks the result).
 */
/** The chain chip: one plain-language line for what this patch's input was matched against.
 * Positions in the verdict are 0-based ENABLED-chain positions; `enabledIndexes` maps them to
 * the list numbering the drag handles use. Quiet by design: single-patch stacks show only the
 * identity verdicts. */
const chainChipText = (
  item: PatchStackItemState,
  enabledIndexes: readonly number[],
  localizer: Localizer,
): { text: string; warn?: boolean } | null => {
  const verdict = item.chainVerdict;
  if (!verdict) return null;
  const displayNumber = (enabledPosition: number) => (enabledIndexes[enabledPosition] ?? enabledPosition) + 1;
  if (item.validationState === "invalid" && verdict.matched.kind === "none" && verdict.basisSource !== "default") {
    return { text: localizer.message("ui.chain.differentRom"), warn: true };
  }
  if (verdict.expectedPredecessor !== undefined) {
    return {
      text: localizer.message("ui.chain.expectsFirst", { n: displayNumber(verdict.expectedPredecessor) }),
      warn: true,
    };
  }
  if (verdict.matched.kind === "patch_output") {
    return { text: localizer.message("ui.chain.appliesAfter", { n: displayNumber(verdict.matched.index) }) };
  }
  if (enabledIndexes.length < 2) return null;
  if (verdict.matched.kind === "base") {
    return {
      text:
        verdict.matched.variant === "raw"
          ? localizer.message("ui.chain.matchesRom")
          : localizer.message("ui.chain.matchesRomVariant", { variant: verdict.matched.variant }),
    };
  }
  if (item.validationState === "deferred") return { text: localizer.message("ui.chain.verifiedDuringWeave") };
  return null;
};

/** The auto option names what inference resolved so pinning is a conscious
 * override; with a pin active (or no plan yet) it stays a plain "auto". */
const autoBasisLabel = (item: PatchStackItemState, localizer: Localizer, meta?: BundlePatchMeta): string => {
  const verdict = item.chainVerdict;
  if (meta?.basis || !verdict || verdict.basisSource === "declared") return localizer.message("ui.basis.auto");
  return verdict.basis === "base" ? localizer.message("ui.basis.autoBase") : localizer.message("ui.basis.autoPrevious");
};

const PatchChecksDrawer = ({
  basisSelectVisible,
  chainChip,
  disabled,
  index,
  isChainInput,
  isChainOutput,
  item,
  meta,
  onMetaChange,
  outputCheckHint,
  patchStack,
  romActuals,
}: {
  /** Show the author's input-basis select in the Input group head (a stack of
   * two or more enabled patches, or an existing pin to surface). */
  basisSelectVisible?: boolean;
  /** Plain-language chain verdict rendered in the drawer header readout. */
  chainChip?: { text: string; warn?: boolean } | null;
  /** The patch is toggled out of the run: verification state is not part of the
   * plan, so the header verdict/timing readouts stay off - the drawer remains
   * editable. */
  disabled?: boolean;
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
  /** Chain-output card of a run with optional/skipped patches: remind that the
   * expected output only describes the full chain. */
  outputCheckHint?: boolean;
  patchStack: PatcherStackController;
  /** The chain-input patch's target ROM computed checks - the actual values a
   * user-entered INPUT check is compared against for its per-row match mark. */
  romActuals?: RomCheckActuals;
}) => {
  const setOption = patchStack.setPatchOption;
  const localizer = useUiLocalizer();
  const [invalidChecks, setInvalidChecks] = useState<Record<string, boolean>>({});
  // Fields opened via "Add check" that have no committed value yet.
  const [draftFields, setDraftFields] = useState<Record<string, boolean>>({});
  const { inputRows, outputRows } = getPatchVerificationRows(item);
  const setInvalid = (fieldKey: string, invalid: boolean) =>
    setInvalidChecks((previous) => (previous[fieldKey] === invalid ? previous : { ...previous, [fieldKey]: invalid }));
  // A valid check on a chain endpoint feeds the run's validation option so the
  // ROM re-verifies immediately (card coloring) and the apply enforces it.
  const syncEndpointValidation = (side: "input" | "output", checksums: Record<string, string>) => {
    const preferred = checksums.sha1 || checksums.md5 || checksums.crc32 || "";
    if (side === "input" && isChainInput)
      void setOption?.(index, { revalidate: true, validateInputChecksum: preferred });
    if (side === "output" && isChainOutput)
      void setOption?.(index, { revalidate: true, validateOutputChecksum: preferred });
  };
  const commitCheck = (side: "input" | "output", algorithm: CheckAlgorithm, raw: string) => {
    const value = normalizeCheckInput(raw);
    const invalid = !!value && !isValidCheckValue(algorithm, value);
    setInvalid(`${side}:${algorithm}`, invalid);
    if (invalid) return;
    const field = side === "input" ? "inputChecks" : "outputChecks";
    const checksums = { ...meta?.[field]?.checksums };
    if (value) checksums[algorithm] = value;
    else delete checksums[algorithm];
    onMetaChange?.({ [field]: { ...meta?.[field], checksums } });
    syncEndpointValidation(side, checksums);
  };
  // The bytes field carries the endpoint's exact size into the bundle metadata
  // (inputChecks/outputChecks.size); it is descriptive, not a live run gate.
  const commitSize = (side: "input" | "output", raw: string) => {
    const value = raw.trim();
    const invalid = !!value && !/^\d+$/.test(value);
    setInvalid(`${side}:bytes`, invalid);
    if (invalid) return;
    const field = side === "input" ? "inputChecks" : "outputChecks";
    onMetaChange?.({ [field]: { ...meta?.[field], size: value ? Number(value) : undefined } });
  };
  const removeCheck = (side: "input" | "output", field: CheckField) => {
    setDraftFields((previous) => ({ ...previous, [`${side}:${field}`]: false }));
    setInvalid(`${side}:${field}`, false);
    if (field === "bytes") {
      commitSize(side, "");
      return;
    }
    commitCheck(side, field, "");
  };
  const sides = (["input", "output"] as const).map((side) => {
    const builtInRows = side === "input" ? inputRows : outputRows;
    const embedded = getEmbeddedChecks(item, side);
    const metaField = side === "input" ? ("inputChecks" as const) : ("outputChecks" as const);
    const userSize = meta?.[metaField]?.size;
    const userChecks = meta?.[metaField]?.checksums || {};
    const userValue = (field: CheckField): string => {
      if (field === "bytes") return typeof userSize === "number" ? String(userSize) : "";
      return userChecks[field] || "";
    };
    const editableFields = CHECK_FIELDS_PAIRED.filter(
      (field) => !embedded[field] && (!!userValue(field) || !!draftFields[`${side}:${field}`]),
    );
    const addableFields = CHECK_FIELDS_PAIRED.filter((field) => !(embedded[field] || editableFields.includes(field)));
    // Only the chain-input side's checks describe the ROM we actually hold, so
    // only those can be matched against a real value; every other side stays
    // metadata-only (no mark).
    const markFor = (field: CheckField): "bad" | "ok" | undefined =>
      side === "input" && isChainInput && !invalidChecks[`${side}:${field}`]
        ? matchInputCheck(field, userValue(field), romActuals)
        : undefined;
    return { addableFields, builtInRows, editableFields, markFor, side, userValue };
  });
  const hasUserChecks = sides.some((entry) => entry.editableFields.length > 0);
  // A user-entered input check that disagrees with the real ROM fails the drawer
  // verdict even when the patch itself dry-applies (the ROM just isn't the one
  // the check describes).
  const userMismatch = sides.some((entry) => entry.editableFields.some((field) => entry.markFor(field) === "bad"));
  const verifying = !disabled && item.validationState === "verifying";
  const bad = !disabled && (item.validationState === "invalid" || userMismatch);
  const ok = !disabled && item.validationState === "valid" && !userMismatch;
  const match = ok ? { label: null, ok: true } : bad ? { label: null, ok: false } : undefined;
  const hasBuiltIn = !!(inputRows.length || outputRows.length);
  const compact =
    !hasUserChecks &&
    inputRows.length > 0 &&
    outputRows.length > 0 &&
    [...inputRows, ...outputRows].every((row) => String(row.value).length < 16);
  return (
    <ChecksumList
      action={ok ? <PreflightSuccess /> : undefined}
      bodyClassName={compact ? "ckrows patch-check-columns" : "ckrows patch-checks-body"}
      defaultOpen={hasBuiltIn || hasUserChecks}
      label="Checks"
      match={ok ? undefined : match}
      sublabel={
        !(disabled || verifying) && chainChip ? (
          <span id={`rom-weaver-patch-chain-chip-${index}`}>
            {chainChip.warn ? "⚠ " : ""}
            {chainChip.text}
          </span>
        ) : undefined
      }
      timing={disabled ? undefined : CHECKSUM_TIMING_LABEL(item.checksumTiming, "Checks")}
      verifying={verifying}
    >
      {sides.map(({ addableFields, builtInRows, editableFields, markFor, side, userValue }) => (
        <div className="ck-group" key={side}>
          <div className="ck-group-head">
            <span>{side === "input" ? "Input" : "Output"}</span>
            {side === "input" && onMetaChange && basisSelectVisible ? (
              <>
                <label className="sr-only" htmlFor={`rom-weaver-patch-basis-${index}`}>
                  Which ROM the input checks describe
                </label>
                <select
                  className="meta-target-select mono ck-basis-select"
                  id={`rom-weaver-patch-basis-${index}`}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    // Auto clears the pin - checksum inference decides again. The basis
                    // feeds the chain plan, so re-resolve the verdicts either way.
                    onMetaChange({ basis: next === "base" || next === "previous" ? next : undefined });
                    void setOption?.(index, { revalidate: true });
                  }}
                  title="Which ROM this patch's input checks describe: the base ROM (verified once up front) or the previous patch's output."
                  value={meta?.basis || ""}
                >
                  <option value="">{autoBasisLabel(item, localizer, meta)}</option>
                  <option value="base">{localizer.message("ui.basis.base")}</option>
                  <option value="previous">{localizer.message("ui.basis.previous")}</option>
                </select>
              </>
            ) : null}
          </div>
          {builtInRows.map((row) => (
            <ChecksumRow key={`${side}:${row.label}:${row.value}`} label={row.label} value={row.value} />
          ))}
          {editableFields.map((field) => (
            <EditableCheckRow
              field={field}
              focusOnMount={!!draftFields[`${side}:${field}`] && !userValue(field)}
              id={`rom-weaver-patch-${side}-${field}-${index}`}
              invalid={!!invalidChecks[`${side}:${field}`]}
              key={`${side}:${field}:${item.key ?? index}:${userValue(field)}`}
              mark={markFor(field)}
              onCommit={(raw) => (field === "bytes" ? commitSize(side, raw) : commitCheck(side, field, raw))}
              onRemove={() => removeCheck(side, field)}
              value={userValue(field)}
            />
          ))}
          {onMetaChange && addableFields.length ? (
            <label className="ck-add">
              <Plus aria-hidden="true" />
              <span className="sr-only">Add {side} check</span>
              <select
                className="ck-add-select"
                id={`rom-weaver-patch-${side}-add-check-${index}`}
                onChange={(event) => {
                  const field = event.currentTarget.value as CheckField;
                  event.currentTarget.value = "";
                  if (field) setDraftFields((previous) => ({ ...previous, [`${side}:${field}`]: true }));
                }}
                value=""
              >
                <option disabled value="">
                  Add check
                </option>
                {addableFields.map((field) => (
                  <option key={field} value={field}>
                    {CHECK_LABELS[field]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ))}
      {outputCheckHint ? (
        <p className="patch-off-note" id={`rom-weaver-patch-output-check-hint-${index}`}>
          <TriangleAlert aria-hidden="true" />
          <span>The expected output is verified only when every patch in the bundle is woven.</span>
        </p>
      ) : null}
    </ChecksumList>
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
        Weave patch into
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

/** The check that closes the patch-details form; it takes the menu's slot in
 * the action column while editing (commit happens on each field's blur; the
 * check just closes the form). Carries the same id as the menu's Edit item so
 * open/close drive one control identity. */
const PatchMetaDoneButton = ({ index, onToggle }: { index: number; onToggle: () => void }) => (
  <button
    aria-expanded
    aria-label="Done editing patch details"
    className="rm patch-menu-btn is-editing"
    id={`rom-weaver-patch-meta-edit-${index}`}
    onClick={onToggle}
    title="Done"
    type="button"
  >
    <Check aria-hidden="true" />
  </button>
);

/** Three-dot menu in the card's top-right action column: Edit (opens the
 * patch-details form), Replace (swap the file in place), Remove. Present
 * through staging too. The item list stays mounted (visibility via [hidden])
 * so its actions keep stable, always-queryable ids. */
const PatchActionsMenu = ({
  index,
  onEdit,
  onRemove,
  onReplace,
}: {
  index: number;
  /** Absent while the details form cannot be edited (no bundle meta channel). */
  onEdit?: () => void;
  onRemove: () => void;
  onReplace?: (file: File) => void;
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  return (
    <div className="patch-menu" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Patch actions"
        className={open ? "rm patch-menu-btn is-open" : "rm patch-menu-btn"}
        id={`rom-weaver-patch-menu-${index}`}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        title="Patch actions"
        type="button"
      >
        <EllipsisVertical aria-hidden="true" />
      </button>
      <div
        aria-label="Patch actions"
        className="patch-menu-list"
        hidden={!open}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        role="menu"
      >
        {onEdit ? (
          <button
            className="patch-menu-item"
            id={`rom-weaver-patch-meta-edit-${index}`}
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
            role="menuitem"
            type="button"
          >
            <Pencil aria-hidden="true" />
            Edit details
          </button>
        ) : null}
        {onReplace ? (
          <button
            className="patch-menu-item"
            id={`rom-weaver-patch-replace-${index}`}
            onClick={() => fileRef.current?.click()}
            role="menuitem"
            type="button"
          >
            <RefreshCw aria-hidden="true" />
            Replace file…
          </button>
        ) : null}
        <button
          aria-label="Remove patch"
          className="patch-menu-item is-danger"
          id={`rom-weaver-patch-menu-remove-${index}`}
          onClick={() => {
            setOpen(false);
            onRemove();
          }}
          role="menuitem"
          type="button"
        >
          <Trash2 aria-hidden="true" />
          Remove
        </button>
      </div>
      {onReplace ? (
        <input
          accept=".aps,.bps,.bsdiff,.dcp,.ebp,.gdiff,.hdiff,.hpatchz,.ips,.ips32,.ppf,.rup,.solid,.ups,.vcdiff,.xdelta"
          aria-label="Replacement patch file"
          className="sr-only"
          id={`rom-weaver-patch-replace-input-${index}`}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            setOpen(false);
            if (file) onReplace(file);
          }}
          ref={fileRef}
          tabIndex={-1}
          type="file"
        />
      ) : null}
    </div>
  );
};

/** One patch card: staging presentation, a three-dot actions menu (edit
 * details / replace file / remove) at the head of the name line, the Extract
 * drawer, and the unified Checks drawer (which owns the dry-run verdict). */
const PatchCard = ({
  basisSelectVisible,
  canReorder,
  chainChip,
  handleProps,
  index,
  internalDescription,
  isChainInput,
  isChainOutput,
  isDisabled,
  item,
  meta,
  onMetaChange,
  onReorder,
  onTogglePatch,
  outputCheckHint,
  overrideAvailable,
  patchStack,
  position,
  romActuals,
  rowProps,
  total,
}: {
  /** Show the input-basis select in the card's Checks drawer. */
  basisSelectVisible?: boolean;
  canReorder: boolean;
  /** Plain-language chain verdict for the Checks drawer header readout. */
  chainChip?: { text: string; warn?: boolean } | null;
  handleProps: ReorderHandleProps;
  index: number;
  /** Embedded description fallback (first patch only); edited metadata wins. */
  internalDescription?: string;
  isChainInput: boolean;
  isChainOutput: boolean;
  isDisabled: boolean;
  item: PatchStackItemState;
  meta?: BundlePatchMeta;
  onMetaChange?: (updates: Partial<BundlePatchMeta>) => void;
  onReorder: (from: number, to: number) => void;
  onTogglePatch?: (index: number) => void;
  outputCheckHint?: boolean;
  overrideAvailable?: boolean;
  patchStack: PatcherStackController;
  position: number;
  /** This patch's target ROM computed checks, for verifying input checks. */
  romActuals?: RomCheckActuals;
  rowProps: ReturnType<ReturnType<typeof useListReorder>["rowProps"]>;
  total: number;
}) => {
  // Pencil edit state: the name and description editors open/close together.
  const [metaEditing, setMetaEditing] = useState(false);
  const editing = metaEditing && !!onMetaChange;
  const description = meta?.description || internalDescription || "";
  // Mirrors the ROM card: the resolved card structure (collapsed Extract +
  // Checks drawers) stays mounted through staging - a determinate bar on the
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
  const disabledClass = isDisabled ? "is-disabled" : undefined;
  // A disabled patch is out of the run: its (stale) verification verdict
  // stays off the card; the Checks drawer stays editable (metadata only).
  let verdict: "bad" | "ok" | undefined;
  if (item.validationState === "invalid") verdict = "bad";
  else if (item.validationState === "valid") verdict = "ok";
  if (isDisabled) verdict = undefined;
  // Verification is the second phase: once the ROM is ready, the deferred dry-run runs while
  // the card already shows its full body (Extract + Checks). A top-edge bar carries
  // that async work - a later phase following the "Reading…" staging bar.
  const verifying = !(staging || isDisabled) && item.validationState === "verifying";
  const checksRows = getPatchVerificationRows(item);
  const hasKnownChecks =
    !!(checksRows.inputRows.length || checksRows.outputRows.length) || !!meta?.inputChecks || !!meta?.outputChecks;
  return (
    <FileCard
      {...rowProps}
      className={[rowProps.className, disabledClass].filter(Boolean).join(" ") || undefined}
      description={
        editing && onMetaChange ? (
          <div className="patch-desc-line is-editing">
            <PatchMetaFields
              index={index}
              item={item}
              meta={meta}
              onMetaChange={onMetaChange}
              onSubmit={() => setMetaEditing(false)}
            />
          </div>
        ) : description ? (
          <p className="patch-desc" id={`rom-weaver-patch-card-description-${index}`}>
            {description}
          </p>
        ) : undefined
      }
      handle={
        <PatchDragHandle
          disabled={!canReorder}
          handleProps={handleProps}
          index={index}
          onReorder={onReorder}
          position={position}
          total={total}
        />
      }
      meta={
        <>
          {onTogglePatch ? (
            <PatchEnableToggle disabled={isDisabled} fileName={item.fileName} onToggle={() => onTogglePatch(index)} />
          ) : null}
          {item.fileSize ? <span className="fsize mono">{formatByteSize(item.fileSize)}</span> : null}
          {item.format ? <span className="meta-fmt mono">{item.format.toLowerCase()}</span> : null}
          {meta?.label ? <span className="meta-fmt mono">{meta.label}</span> : null}
          {/* Icon chips mark these as authored metadata (release tag, credit)
              among the plain file-fact chips. */}
          {meta?.version ? (
            <span className="meta-fmt mono meta-ic" id={`rom-weaver-patch-card-version-${index}`}>
              <Tag aria-hidden="true" />
              <span className="sr-only">Version </span>
              {meta.version}
            </span>
          ) : null}
          {meta?.author ? (
            <span className="meta-fmt meta-ic meta-author" id={`rom-weaver-patch-card-author-${index}`}>
              <UserRound aria-hidden="true" />
              <span className="sr-only">Author </span>
              {meta.author}
            </span>
          ) : null}
          {/* The patch's single contextual control (target OR header OR byte
              order - never more than one applies) closes the meta line, in
              the same slot after size and format. */}
          {staging ? null : <PatchTarget index={index} item={item} patchStack={patchStack} />}
          {staging || isDisabled ? null : <PatchHeaderModeSelect index={index} item={item} patchStack={patchStack} />}
          {staging || isDisabled ? null : <PatchN64ByteOrderSelect index={index} item={item} patchStack={patchStack} />}
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
          displayName={meta?.name}
          fileName={item.fileName}
          fileSize={item.fileSize}
          // The first archive-path entry is the source archive itself (shown
          // in the Files drawer / picker); the rest is the folder path
          // within it, surfaced inline on the name.
          // A custom display name replaces the whole title, folder prefix included.
          folderPath={
            meta?.name
              ? undefined
              : (item.archivePathEntries || [])
                  .slice(1)
                  .map((entry) => entry.fileName)
                  .filter(Boolean)
                  .join(" › ") || undefined
          }
          legacyFileClassName="rom-weaver-patch-stack-file"
          parentCompressions={item.archivePathEntries}
        />
      }
      menu={
        editing ? (
          <PatchMetaDoneButton index={index} onToggle={() => setMetaEditing(false)} />
        ) : (
          <PatchActionsMenu
            index={index}
            onEdit={onMetaChange ? () => setMetaEditing(true) : undefined}
            onRemove={() => patchStack.removeItem(index)}
            onReplace={(file) => patchStack.replaceItem(index, file)}
          />
        )
      }
      patch
      stageBar={stageBarValue(staging, percent)}
      state={staging ? undefined : verdict}
      verifyBar={verifying}
    >
      <div className="patch-body">
        <div className="patch-body-inner">
          {verdict === "bad" ? (
            <PatchFaultWell message={item.validationMessage} overrideAvailable={overrideAvailable} />
          ) : null}
          {isDisabled ? null : (
            <ExtractDrawer
              always={!!meta || (staging && patchExtracting)}
              fileName={item.fileName}
              fileSize={item.fileSize}
              parentCompressions={item.archivePathEntries}
              timing={TIMING_LABEL(item.decompressionTimeMs)}
            />
          )}
          {/* A patch still staging usually has no parsed requirements or header
              choice yet - the (empty) Checks drawer joins the card once the
              parse lands. Requirements already known (eager parse, bundle
              metadata) keep their drawer through staging. */}
          {staging && !hasKnownChecks ? null : (
            <PatchChecksDrawer
              basisSelectVisible={basisSelectVisible}
              chainChip={chainChip}
              disabled={isDisabled}
              index={index}
              isChainInput={isChainInput}
              isChainOutput={isChainOutput}
              item={item}
              meta={meta}
              onMetaChange={onMetaChange}
              outputCheckHint={outputCheckHint}
              patchStack={patchStack}
              romActuals={romActuals}
            />
          )}
        </div>
      </div>
    </FileCard>
  );
};

const ApplyPatchListStep = ({
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
  romActualsById,
  ui,
  woven,
}: {
  /** The run has optional/skipped patches: hint on the chain-output card that its
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
  /** The 0x04 "Weave anyway…" override toggle is on offer - fault hints name it. */
  overrideAvailable?: boolean;
  patchInput: PatcherUiState["patchInput"];
  /** ROM id → its computed checks, for verifying user-entered input checks against
   * the real ROM (the chain-input patch's target). */
  romActualsById?: ReadonlyMap<string, RomCheckActuals>;
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
  const chainOutputIndex = enabledIndexes.at(-1) ?? -1;
  const localizer = useUiLocalizer();
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
            <li>NINJA1 headers are recognized, but NINJA1 weaving is not supported.</li>
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
        {patches.map((item, index) => (
          <PatchCard
            basisSelectVisible={enabledIndexes.length >= 2 || !!bundleMeta?.[index]?.basis}
            canReorder={canReorder}
            chainChip={chainChipText(item, enabledIndexes, localizer)}
            handleProps={reorderList.handleProps(index)}
            index={index}
            internalDescription={index === 0 ? internalDescription : undefined}
            isChainInput={index === chainInputIndex}
            isChainOutput={index === chainOutputIndex}
            isDisabled={!!disabledFlags?.[index]}
            item={item}
            key={item.key ?? `${index}:${item.fileName}`}
            meta={bundleMeta?.[index]}
            onMetaChange={onBundleMetaChange ? (updates) => onBundleMetaChange(index, updates) : undefined}
            onReorder={patchStack.reorder}
            onTogglePatch={onTogglePatch}
            outputCheckHint={!!bundleOutputCheckHint && index === chainOutputIndex}
            overrideAvailable={overrideAvailable}
            patchStack={patchStack}
            position={reorderList.displayIndex(index) + 1}
            romActuals={item.targetValue ? romActualsById?.get(item.targetValue) : undefined}
            rowProps={reorderList.rowProps(index)}
            total={total}
          />
        ))}
      </div>
      {(() => {
        // One list-level order warning: the first enabled patch whose input matches a patch it
        // does not follow. Fixing one link re-plans the chain; any remaining break surfaces next.
        const outOfOrder = patches.findIndex(
          (item, index) => !disabledFlags?.[index] && item.chainVerdict?.expectedPredecessor !== undefined,
        );
        if (outOfOrder < 0 || !canReorder) return null;
        const predecessorPosition = patches[outOfOrder]?.chainVerdict?.expectedPredecessor ?? -1;
        const predecessorIndex = enabledIndexes[predecessorPosition] ?? -1;
        if (predecessorIndex < 0) return null;
        const patchName = patches[outOfOrder]?.fileName || `patch ${outOfOrder + 1}`;
        const predecessorName = patches[predecessorIndex]?.fileName || `patch ${predecessorIndex + 1}`;
        const destination = outOfOrder < predecessorIndex ? predecessorIndex : predecessorIndex + 1;
        return (
          <p aria-live="polite" className="patch-off-note" id="rom-weaver-patch-order-note">
            <TriangleAlert aria-hidden="true" />
            <span>
              {localizer.message("ui.chain.orderNote", { patch: patchName, predecessor: predecessorName })}{" "}
              <button
                className="btn ghost slim"
                id="rom-weaver-button-fix-patch-order"
                onClick={() => patchStack.reorder(outOfOrder, destination)}
                type="button"
              >
                {localizer.message("ui.chain.fixOrder")}
              </button>
            </span>
          </p>
        );
      })()}
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

export { ApplyPatchListStep, type RomCheckActuals };
