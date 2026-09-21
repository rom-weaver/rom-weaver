import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  Crosshair,
  Disc3,
  EllipsisVertical,
  GitBranch,
  Pencil,
  Plus,
  RefreshCw,
  Scissors,
  Tag,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { CHEAT_HEADER_STRIP_HINT } from "../../lib/cheats/header-guard.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
import { InfoToggle } from "../../presentation/react/info-toggle.tsx";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { createTiming, formatTiming } from "../../storage/shared/timing.ts";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import {
  CHECK_ALGORITHMS,
  type CHECK_FIELDS,
  CHECK_FIELDS_PAIRED,
  CHECK_HEX_LENGTHS,
  CHECK_LABELS,
  type CheckAlgorithm,
  type CheckField,
  isHalfRowField,
  isHashRowField,
  isValidCheckValue,
  normalizeCheckInput,
} from "./components/ds/check-fields.ts";
import { ChecksumList, ChecksumRow, FIT_VALUE_MIN_CHARS } from "./components/ds/checksum-list.tsx";
import { join } from "./components/ds/cx.ts";
import { DropdownSelect } from "./components/ds/dropdown-select.tsx";
import { ExtractDrawer, ExtractName } from "./components/ds/extraction-tree.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { InfoPopover, StepSection } from "./components/ds/layout.tsx";
import { StageStatus, stageBarValue, stagePercent, stageStatusLabel } from "./components/ds/staging-meta.tsx";
import { useExpectedRomIdentification } from "./use-expected-rom-identification.ts";
import { reorder, useListReorder } from "./components/ds/use-list-reorder.ts";
import { getFileInputAcceptAttributes } from "./file-input-accept.ts";
import type { PatcherStackController } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import { formatHeaderAutoLabel } from "./patcher-view-models.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";
import type { PatchInputBasis } from "./patch-input-basis.ts";
import type { CheatStackRenderState } from "./components/cheat-database-section.tsx";
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
  "in rom": "ROM",
};

const PATCH_OUTPUT_VERIFICATION_LABELS: Record<string, string> = {
  "out crc32": "CRC32",
  "out md5": "MD5",
  "out sha-1": "SHA-1",
  "out sha1": "SHA-1",
  "out size": "BYTES",
};

const BUNDLE_CHECK_LABELS: Record<string, string> = {
  crc32: CHECK_LABELS.crc32,
  md5: CHECK_LABELS.md5,
  sha1: CHECK_LABELS.sha1,
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
const toFaultDetail = (message: string, localizer: Localizer): string => {
  const detail = message.replace(/^\s*validation failed:?\s*/i, "").trim();
  if (!detail) return localizer.message("ui.patch.validationMismatch");
  return detail.charAt(0).toUpperCase() + detail.slice(1);
};

/** Failed dry-run verdict: an inset fault well with the verdict, the detail,
 * and what to do next (naming the 0x04 override toggle when it is offered). */
const PatchFaultWell = ({ message, overrideAvailable }: { message: string; overrideAvailable?: boolean }) => {
  const localizer = useUiLocalizer();
  return (
    <div className="pverdict pfault">
      <div className="pfault-title">
        <X aria-hidden="true" />
        <span>{localizer.message("ui.patch.validationFailed")}</span>
      </div>
      <p className="pfault-detail">{toFaultDetail(message, localizer)}</p>
      <p className="pfault-hint">
        {overrideAvailable
          ? localizer.message("ui.patch.validationMismatchOverride")
          : localizer.message("ui.patch.validationMismatchHint")}
      </p>
    </div>
  );
};

const PreflightSuccess = () => {
  const localizer = useUiLocalizer();
  return (
    <InfoToggle
      ariaLabel={localizer.message("ui.patch.preflightPassed")}
      className="dry-apply-info"
      icon={<Check aria-hidden="true" />}
      panelClassName="dry-apply-pop"
      portalPanel
      title={localizer.message("ui.patch.preflightPassed")}
    >
      <strong>{localizer.message("ui.patch.preflightPassed")}</strong>
      <p>{localizer.message("ui.patch.preflightVerified")}</p>
      <p>{localizer.message("ui.patch.preflightOutputPending")}</p>
    </InfoToggle>
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

const bundleCheckRows = (checks: ParsedBundleChecks | undefined) => {
  const rows: Array<{ label: string; value: string }> = [];
  for (const [algorithm, value] of Object.entries(checks?.checksums || {})) {
    const normalized = algorithm.toLowerCase().replace("sha-1", "sha1");
    const label = BUNDLE_CHECK_LABELS[normalized];
    if (label && value.trim()) rows.push({ label, value: value.trim() });
  }
  if (typeof checks?.size === "number") rows.push({ label: "BYTES", value: String(checks.size) });
  return rows;
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
  <PatchMetaFieldsContent index={index} item={item} meta={meta} onMetaChange={onMetaChange} onSubmit={onSubmit} />
);

const PatchMetaFieldsContent = ({
  index,
  item,
  meta,
  onMetaChange,
  onSubmit,
}: PatchMetaFieldProps & {
  onSubmit: () => void;
}) => {
  const localizer = useUiLocalizer();
  return (
    <div className="patch-meta-inline">
      <PatchMetaTextField
        field="name"
        index={index}
        item={item}
        label={localizer.message("ui.patch.name")}
        meta={meta}
        onMetaChange={onMetaChange}
        onSubmit={onSubmit}
        placeholder={item.fileName.replace(/\.[^.]+$/, "")}
      />
      <div className="ofld patch-description-field">
        <label className="ofld-l" htmlFor={`rom-weaver-patch-description-${index}`}>
          {localizer.message("ui.patch.description")}
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
          placeholder={localizer.message("ui.patch.descriptionPlaceholder")}
          ref={autosizeTextarea}
          rows={1}
        />
      </div>
      <div className="patch-meta-cols">
        <PatchMetaTextField
          field="version"
          index={index}
          item={item}
          label={localizer.message("ui.patch.version")}
          meta={meta}
          onMetaChange={onMetaChange}
          onSubmit={onSubmit}
          placeholder="1.0"
        />
        <PatchMetaTextField
          field="author"
          index={index}
          item={item}
          label={localizer.message("ui.patch.author")}
          meta={meta}
          onMetaChange={onMetaChange}
          onSubmit={onSubmit}
          placeholder={localizer.message("ui.patch.authorPlaceholder")}
        />
      </div>
    </div>
  );
};

/** The ROM-header handling select on the patch card's meta line (beside the
 * On/Off switch): Auto (the engine's checksum-driven decision,
 * labeled with its outcome when it decided), or an explicit Keep/Strip pin.
 * Only rendered when the target ROM actually has a strippable header. */
const PatchHeaderModeSelect = ({
  index,
  item,
  patchStack,
  stripDisabled,
}: {
  index: number;
  item: PatchStackItemState;
  patchStack: PatcherStackController;
  /** The cheat stack has a card switched On, so stripping is not on offer. */
  stripDisabled?: boolean;
}) => {
  const localizer = useUiLocalizer();
  if (!item.showHeaderOption) return null;
  const headerNoun = item.headerStrippedBytes
    ? localizer.message("ui.patch.headerWithSize", { bytes: item.headerStrippedBytes })
    : localizer.message("ui.patch.header");
  const autoLabel = formatHeaderAutoLabel(item.headerAutoDecided, item.headerAutoMode, localizer);
  return (
    <span className="target-grp header-grp">
      <Scissors aria-hidden="true" />
      <label className="sr-only" htmlFor={`rom-weaver-patch-header-mode-${index}`}>
        {localizer.message("ui.patch.headerHandling")}
      </label>
      <DropdownSelect
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
        title={localizer.message("ui.patch.headerHandlingHelp")}
        value={item.headerChoice ?? "auto"}
      >
        <option value="auto">{autoLabel}</option>
        <option value="keep">{localizer.message("ui.patch.keepHeader", { header: headerNoun })}</option>
        <option disabled={stripDisabled} title={stripDisabled ? CHEAT_HEADER_STRIP_HINT : undefined} value="strip">
          {localizer.message("ui.patch.stripHeader", { header: headerNoun })}
        </option>
      </DropdownSelect>
    </span>
  );
};

const PatchInputBasisSelect = ({
  basis,
  disabled,
  index,
  item,
  onChange,
  patchStack,
  previousBasisAvailable,
}: {
  basis: PatchInputBasis;
  disabled?: boolean;
  index: number;
  item: PatchStackItemState;
  onChange?: (basis: PatchInputBasis) => void;
  patchStack: PatcherStackController;
  previousBasisAvailable: boolean;
}) => {
  const localizer = useUiLocalizer();
  return (
    <span className="target-grp patch-basis-grp">
      <GitBranch aria-hidden="true" />
      <label className="sr-only" htmlFor={`rom-weaver-patch-basis-${index}`}>
        Authored for patch {index + 1}
      </label>
      <select
        className="meta-target-select mono ptgt-sel"
        disabled={disabled || item.optionsDisabled}
        id={`rom-weaver-patch-basis-${index}`}
        onChange={(event) => {
          if (disabled || item.optionsDisabled) return;
          const next = event.currentTarget.value as PatchInputBasis;
          onChange?.(next);
          void patchStack.setPatchOption?.(index, {
            basis: next === "base" || next === "previous" ? next : undefined,
            revalidate: true,
          });
        }}
        title="Choose the state these checks describe. This does not change the stack input used when the patch runs."
        value={basis}
      >
        <option value="auto">{resolvedBasisLabel("auto", localizer, item.chainVerdict?.basis)}</option>
        <option value="base">{localizer.message("ui.patchInputs.original")}</option>
        <option disabled={!previousBasisAvailable} value="previous">
          {localizer.message("ui.patchInputs.previous")}
        </option>
      </select>
    </span>
  );
};
/**
 * The patch's patchable tracks, as a select. Shown only when the resolved
 * source offers a real choice, because a single track (or a plain ROM) needs no
 * decision; the value is the member locator the engine resolves the leaf by.
 */
const PatchTrackSelect = ({
  disabled,
  index,
  meta,
  onMetaChange,
  sourceMembers,
}: {
  disabled?: boolean;
  index: number;
  meta?: BundlePatchMeta;
  onMetaChange?: (updates: Partial<BundlePatchMeta>) => void;
  sourceMembers: readonly { value: string; label: string }[];
}) => {
  const localizer = useUiLocalizer();
  if (!onMetaChange || sourceMembers.length <= 1) return null;
  const input = meta?.input;
  return (
    <span className="target-grp patch-track-grp">
      <Disc3 aria-hidden="true" />
      <label className="sr-only" htmlFor={`rom-weaver-patch-track-${index}`}>
        {localizer.message("ui.patch.track")}
      </label>
      <DropdownSelect
        className="meta-target-select mono ptgt-sel"
        disabled={disabled}
        id={`rom-weaver-patch-track-${index}`}
        onChange={(event) => {
          const member = event.currentTarget.value || undefined;
          if (!input) {
            onMetaChange({ input: member ? { member, rom: true } : undefined });
            return;
          }
          if ("rom" in input) {
            onMetaChange({ input: member ? { member, rom: true } : { rom: true } });
            return;
          }
          onMetaChange({ input: member ? { member, patch: input.patch } : { patch: input.patch } });
        }}
        value={input?.member || ""}
      >
        <option disabled value="">
          {localizer.message("ui.patch.selectTrack")}
        </option>
        {sourceMembers.map((member) => (
          <option key={member.value} value={member.value}>
            {member.label}
          </option>
        ))}
      </DropdownSelect>
    </span>
  );
};

const n64OrderLabel = (order: "big-endian" | "byte-swapped" | "little-endian" | "keep", localizer: Localizer) =>
  localizer.message(`ui.patch.n64Order.${order}`);

const PatchN64ByteOrderSelect = ({
  index,
  item,
  patchStack,
}: {
  index: number;
  item: PatchStackItemState;
  patchStack: PatcherStackController;
}) => {
  const localizer = useUiLocalizer();
  if (!item.showN64ByteOrderOption) return null;
  const autoMode = item.n64AutoMode || "keep";
  const autoLabel = localizer.message("ui.patch.n64Auto", { order: n64OrderLabel(autoMode, localizer) });
  const sourceLabel = item.n64SourceOrder
    ? n64OrderLabel(item.n64SourceOrder, localizer)
    : localizer.message("ui.patch.n64CurrentOrder");
  return (
    <span className="target-grp header-grp">
      <ArrowLeftRight aria-hidden="true" />
      <label className="sr-only" htmlFor={`rom-weaver-patch-n64-byte-order-${index}`}>
        {localizer.message("ui.patch.n64ByteOrder")}
      </label>
      <DropdownSelect
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
        title={localizer.message("ui.patch.n64ByteOrderHelp")}
        value={item.n64ByteOrderChoice ?? "auto"}
      >
        <option value="auto">{autoLabel}</option>
        <option value="keep">{localizer.message("ui.patch.n64KeepCurrent", { order: sourceLabel })}</option>
        <option value="big-endian">{n64OrderLabel("big-endian", localizer)}</option>
        <option value="byte-swapped">{n64OrderLabel("byte-swapped", localizer)}</option>
        <option value="little-endian">{n64OrderLabel("little-endian", localizer)}</option>
      </DropdownSelect>
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
const checkErrorMessage = (field: CheckField, localizer: Localizer): string =>
  field === "bytes"
    ? localizer.message("ui.patch.expectedWholeBytes")
    : localizer.message("ui.patch.expectedHexCharacters", { count: CHECK_HEX_LENGTHS[field as CheckAlgorithm] });

/** An editable expected-check field (user-specified, not built into the patch):
 * commits on blur, removable via the trailing X. A malformed value shows an
 * inline error; a well-formed value that was compared to the real ROM shows a
 * match/mismatch mark.
 *
 * Edit-in-place, and the indirection is load-bearing on iOS: a text field whose
 * text is under 16px makes Safari zoom the page in when it takes focus, and no
 * phone is wide enough to show a 40-character SHA-1 at 16px. At rest the value is
 * therefore a button holding plain text at a read-only row's size and typeface
 * (it keeps the user-check colour, so a user value still reads apart from an
 * embedded one), and tapping it mounts the real field at the 16px floor before
 * focus lands - so the field is never focused while it is small. Sizing the field
 * on `:focus` cannot work: Safari decides whether to zoom as focus arrives, before
 * that style applies. */
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
  const localizer = useUiLocalizer();
  const errorId = `${id}-err`;
  /* The ref callback is a fresh identity every render, so React detaches and
     reattaches it each time. Without this latch the handoff would re-focus on
     every render, and two freshly added rows would then trade focus forever -
     each steal blurs the other, and the blur commits, which renders again. */
  const handedOff = useRef(false);
  if (!focusOnMount) handedOff.current = false;
  /* One-shot: the field mounted because the user just opened it, so it takes focus
     once. Separate from the `focusOnMount` latch above so opening a row by hand
     never re-arms the add-a-check handoff. */
  const openedByUser = useRef(false);
  /* An empty row has no value to display, so it opens as a field either way. */
  const [editing, setEditing] = useState(!!focusOnMount || !value);
  /* A malformed value keeps its field no matter what: collapsing to text would hide
     both the `aria-invalid` state and the only means of correcting it. */
  const showField = editing || invalid;
  const label = CHECK_LABELS[field];
  return (
    <div
      className={join(
        "verification-row",
        showField && "is-editing",
        invalid && "bad",
        isHalfRowField(field) && "ck-half",
        isHashRowField(field) && "ck-hash",
      )}
      key={`${id}:${value}`}
    >
      {showField ? (
        <label className="ofld-l" htmlFor={id}>
          {label}
        </label>
      ) : (
        <span className="ofld-l">{label}</span>
      )}
      {showField ? (
        <input
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid || undefined}
          className="input mono popt-input"
          defaultValue={value}
          id={id}
          onBlur={(event) => {
            const raw = event.currentTarget.value;
            /* Keep an unfillable row open rather than collapsing to a blank button. */
            if (raw) setEditing(false);
            onCommit(raw);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          ref={(element) => {
            if (!element) return;
            if (openedByUser.current) {
              openedByUser.current = false;
              element.focus();
              return;
            }
            if (!focusOnMount || handedOff.current) return;
            handedOff.current = true;
            element.focus();
          }}
          spellCheck={false}
          title={invalid ? checkErrorMessage(field, localizer) : value || undefined}
          type="text"
        />
      ) : (
        <button
          aria-describedby={invalid ? errorId : undefined}
          aria-label={localizer.message("ui.patch.editCheck", { check: label })}
          className="ck-open mono"
          /* Derived from the field's own id so either state of the row is addressable. */
          id={`${id}-open`}
          onClick={() => {
            openedByUser.current = true;
            setEditing(true);
          }}
          title={invalid ? checkErrorMessage(field, localizer) : value}
          type="button"
        >
          <span className={join("ck-v", value.length >= FIT_VALUE_MIN_CHARS && "ck-fit")}>{value}</span>
        </button>
      )}
      <span className="vrow-tail">
        {mark && !invalid ? (
          <span
            className={`ck-mark ${mark}`}
            title={localizer.message(mark === "ok" ? "ui.patch.matchesRom" : "ui.patch.doesNotMatchRom")}
          >
            {mark === "ok" ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
            <span className="sr-only">
              {localizer.message(mark === "ok" ? "ui.patch.matchesRom" : "ui.patch.doesNotMatchRom")}
            </span>
          </span>
        ) : null}
        <button
          aria-label={localizer.message("ui.patch.removeCheck", { check: CHECK_LABELS[field] })}
          className="ck-remove"
          onClick={onRemove}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </span>
      {invalid ? (
        <p className="ck-err" id={errorId}>
          {checkErrorMessage(field, localizer)}
        </p>
      ) : null}
    </div>
  );
};

/** The chain chip: one plain-language line for what this patch's input was matched against.
 * Positions in the verdict are 0-based ENABLED-chain positions; `enabledIndexes` maps them to
 * the list numbering the drag handles use. Quiet by design: single-patch stacks show only the
 * identity verdicts. */
const chainChipText = (
  item: PatchStackItemState,
  hasImplicitPredecessor: boolean,
  enabledIndexes: readonly number[],
  localizer: Localizer,
  patchLabels: readonly string[],
): { text: string; warn?: boolean } | null => {
  const verdict = item.chainVerdict;
  const targetLabel = item.targetOptions?.find((option) => option.value === item.targetValue)?.label;
  const checkedTarget =
    targetLabel ||
    localizer.message(hasImplicitPredecessor ? "ui.patchChecks.precedingPatchOutput" : "ui.patchInputs.original");
  if (!verdict) {
    if (item.validationState === "deferred") {
      return { text: localizer.message("ui.patchChecks.deferred", { input: checkedTarget }) };
    }
    if (item.validationState === "valid") {
      return { text: localizer.message("ui.patchChecks.verified") };
    }
    return { text: localizer.message("ui.patchChecks.unknown", { input: checkedTarget }) };
  }
  const displayNumber = (enabledPosition: number) => (enabledIndexes[enabledPosition] ?? enabledPosition) + 1;
  const displayPatch = (enabledPosition: number) => {
    const index = enabledIndexes[enabledPosition] ?? enabledPosition;
    return patchLabels[index] || localizer.message("ui.patchChecks.patchNumber", { n: displayNumber(enabledPosition) });
  };
  if (item.validationState === "invalid" && verdict.matched.kind === "none" && verdict.basisSource !== "default") {
    return { text: localizer.message("ui.chain.differentRom"), warn: true };
  }
  if (verdict.expectedPredecessor !== undefined) {
    return {
      text: localizer.message("ui.patchChecks.expects", { patch: displayPatch(verdict.expectedPredecessor) }),
      warn: true,
    };
  }
  if (verdict.matched.kind === "patch_output") {
    const predecessor = displayPatch(verdict.matched.index);
    return item.validationState === "deferred"
      ? { text: localizer.message("ui.patchChecks.deferred", { input: predecessor }) }
      : { text: localizer.message("ui.patchChecks.verified") };
  }
  if (verdict.matched.kind === "base") {
    return item.validationState === "deferred"
      ? { text: localizer.message("ui.patchChecks.deferred", { input: checkedTarget }) }
      : { text: localizer.message("ui.patchChecks.verified") };
  }
  if (item.validationState === "deferred") {
    return { text: localizer.message("ui.patchChecks.deferred", { input: checkedTarget }) };
  }
  if (item.validationState === "valid") {
    return { text: localizer.message("ui.patchChecks.verified") };
  }
  return { text: localizer.message("ui.patchChecks.unknown", { input: checkedTarget }) };
};

const resolvedBasisLabel = (
  basis: PatchInputBasis,
  localizer: Localizer,
  verdictBasis?: "base" | "previous",
): string => {
  if (basis === "auto") {
    if (verdictBasis === "base") return localizer.message("ui.basis.autoBase");
    if (verdictBasis === "previous") return localizer.message("ui.basis.autoPrevious");
    return localizer.message("ui.patchInputs.auto");
  }
  return basis === "base" ? localizer.message("ui.patchInputs.original") : localizer.message("ui.patchInputs.previous");
};

const checkInputBasisLabel = (
  basis: PatchInputBasis,
  localizer: Localizer,
  verdictBasis?: "base" | "previous",
): string => {
  if (basis === "auto") {
    if (verdictBasis === "base") return localizer.message("ui.patchChecks.autoBase");
    if (verdictBasis === "previous") return localizer.message("ui.patchChecks.autoPrevious");
    return localizer.message("ui.patchChecks.automatic");
  }
  return basis === "base" ? localizer.message("ui.patchInputs.original") : localizer.message("ui.patchInputs.previous");
};

const PatchChecksDrawer = ({
  basisChoice,
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
  sharedInputChecks,
  sharedInputLabel,
}: {
  /** The selected or resolved state that the authored input checks describe. */
  basisChoice: PatchInputBasis;
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
  /** Checks declared by the predecessor for the same explicit input state. */
  sharedInputChecks?: ParsedBundleChecks;
  sharedInputLabel?: string;
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
    // A blur that did not change the value must not publish new metadata: the
    // fresh object would re-render the card and, with focus still moving, blur
    // again.
    if ((checksums[algorithm] || "") === value) return;
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
    const size = value ? Number(value) : undefined;
    if ((meta?.[field]?.size ?? undefined) === size) return;
    onMetaChange?.({ [field]: { ...meta?.[field], size } });
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
    return { addableFields, builtInRows, editableFields, markFor, metaField, side, userValue };
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
  const sharedInputRows = bundleCheckRows(sharedInputChecks);
  const compact =
    !hasUserChecks &&
    inputRows.length > 0 &&
    outputRows.length > 0 &&
    [...inputRows, ...outputRows].every((row) => String(row.value).length < 16);
  return (
    <ChecksumList
      action={ok ? <PreflightSuccess /> : undefined}
      className="patch-checks"
      bodyClassName={compact ? "ckrows patch-check-columns" : "ckrows patch-checks-body"}
      defaultOpen={hasBuiltIn || hasUserChecks}
      label={localizer.message("ui.patch.checks")}
      match={ok ? undefined : match}
      sublabel={
        !(disabled || verifying) && chainChip ? (
          <span id={`rom-weaver-patch-chain-chip-${index}`}>
            {chainChip.warn ? "⚠ " : ""}
            {chainChip.text}
          </span>
        ) : undefined
      }
      timing={disabled ? undefined : CHECKSUM_TIMING_LABEL(item.checksumTiming, localizer.message("ui.patch.checks"))}
      verifying={verifying}
    >
      {sides.map(({ addableFields, builtInRows, editableFields, markFor, metaField, side, userValue }) => {
        const inputHeading =
          side === "input"
            ? localizer.message("ui.patchChecks.input", {
                basis: checkInputBasisLabel(basisChoice, localizer, item.chainVerdict?.basis),
              })
            : undefined;
        const addControl =
          onMetaChange && addableFields.length ? (
            <label className="ck-add" htmlFor={`rom-weaver-patch-${side}-add-check-${index}`}>
              <Plus aria-hidden="true" />
              <span className="sr-only">
                {localizer.message("ui.patch.addCheck", {
                  side: localizer.message(side === "input" ? "ui.patch.input" : "ui.patch.output").toLowerCase(),
                })}
              </span>
              <DropdownSelect
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
                  {localizer.message("ui.patch.addCheckLabel")}
                </option>
                {addableFields.map((field) => (
                  <option key={field} value={field}>
                    {CHECK_LABELS[field]}
                  </option>
                ))}
              </DropdownSelect>
            </label>
          ) : null;
        return (
          <Fragment key={side}>
            {side === "output" && builtInRows.length ? (
              <div className="ck-group">
                <div className="ck-group-head">
                  <span>{localizer.message("ui.patchChecks.embeddedOutput")}</span>
                </div>
                {builtInRows.map((row) => (
                  <ChecksumRow key={`${side}:embedded:${row.label}:${row.value}`} label={row.label} value={row.value} />
                ))}
              </div>
            ) : null}
            <div className="ck-group">
              <div className="ck-group-head">
                <span>{side === "output" ? localizer.message("ui.patchChecks.stackOutput") : inputHeading}</span>
              </div>
              <IdentifiedCheckTitle checks={meta?.[metaField]} enabled={!disabled} />
              {side === "input"
                ? builtInRows.map((row) => (
                    <ChecksumRow key={`${side}:${row.label}:${row.value}`} label={row.label} value={row.value} />
                  ))
                : null}
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
              {addControl}
            </div>
          </Fragment>
        );
      })}
      {sharedInputRows.length && sharedInputLabel ? (
        <div className="ck-group" id={`rom-weaver-patch-shared-input-checks-${index}`}>
          <div className="ck-group-head">
            <span>{localizer.message("ui.patchChecks.sharedInput", { input: sharedInputLabel })}</span>
          </div>
          <IdentifiedCheckTitle checks={sharedInputChecks} enabled={!disabled} />
          {sharedInputRows.map((row) => (
            <ChecksumRow key={`shared:${row.label}:${row.value}`} label={row.label} value={row.value} />
          ))}
        </div>
      ) : null}
      {outputCheckHint ? (
        <p className="patch-off-note" id={`rom-weaver-patch-output-check-hint-${index}`}>
          <TriangleAlert aria-hidden="true" />
          <span>{localizer.message("ui.patch.outputCheckHint")}</span>
        </p>
      ) : null}
    </ChecksumList>
  );
};

/**
 * The database title behind a declared check state, so a drawer group names the
 * ROM its checksums describe. A per-track check matches a multi-track record
 * only partially, and the title is still the right one, so any `matched`
 * resolution is shown.
 */
const IdentifiedCheckTitle = ({ checks, enabled }: { checks?: ParsedBundleChecks; enabled: boolean }) => {
  const localizer = useUiLocalizer();
  const hasChecksums = !!Object.keys(checks?.checksums || {}).length;
  const identification = useExpectedRomIdentification(hasChecksums ? checks : undefined, enabled && hasChecksums);
  const match = identification?.status === "matched" ? identification.matches[0] : undefined;
  if (!match) return null;
  // Redump-style names already carry the region as its own word or bracketed
  // tag, so it is only appended when the name has no such word.
  const region = match.region?.trim();
  const carriesRegion =
    !!region &&
    new RegExp(`(^|[\\s(,])${region.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s),])`, "i").test(match.name);
  const title = region && !carriesRegion ? `${match.name} (${region})` : match.name;
  return (
    <span className="ck-group-title">
      {localizer.message("ui.patchChecks.identified", { platform: match.platform, title })}
    </span>
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
  const localizer = useUiLocalizer();
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
        aria-label={localizer.message("ui.patch.editPosition", { position, total })}
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
          ? localizer.message("ui.patch.reorderUnavailable", { position, total })
          : localizer.message("ui.patch.reorderHelp", { position, total })
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
      title={localizer.message(disabled ? "ui.patch.position" : "ui.patch.reorderTitle")}
      type="button"
    >
      <span aria-hidden="true" className="phandle-number mono">
        {position}
      </span>
    </button>
  );
};

/**
 * The patch's target on the meta line: the stack state it runs on. The stored
 * value is the explicit choice only, so an unset target keeps following the
 * checksum-resolved default (the ROM input, or the previous patch's output when
 * one is enabled ahead of this patch).
 */
const PatchTarget = ({
  disabled,
  hasImplicitPredecessor,
  hasTarget,
  index,
  meta,
  onMetaChange,
  predecessors,
}: {
  disabled?: boolean;
  hasImplicitPredecessor: boolean;
  /** False when the run has no patchable input at all, so there is nothing to target. */
  hasTarget: boolean;
  index: number;
  meta?: BundlePatchMeta;
  onMetaChange?: (updates: Partial<BundlePatchMeta>) => void;
  predecessors: readonly { id?: string; label: string }[];
}) => {
  const localizer = useUiLocalizer();
  if (!(onMetaChange && hasTarget)) return null;
  const input = meta?.input;
  const currentValue = input ? ("rom" in input ? "rom" : `patch:${input.patch}`) : "auto";
  const knownReference = !!input && "patch" in input && predecessors.some((entry) => entry.id === input.patch);
  // A member can select a leaf from either the ROM or a generated patch output.
  // Preserve it when the source changes so an imported bundle keeps its exact
  // source instead of silently broadening the reference.
  const member = input?.member;
  const romReference = (): { rom: true; member?: string } => (member ? { member, rom: true } : { rom: true });
  return (
    <span className="target-grp patch-target-grp">
      <Crosshair aria-hidden="true" />
      <label className="sr-only" htmlFor={`rom-weaver-select-patch-target-${index}`}>
        {localizer.message("ui.patch.target")}
      </label>
      <DropdownSelect
        className="meta-target-select mono ptgt-sel"
        disabled={disabled}
        id={`rom-weaver-select-patch-target-${index}`}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "auto") {
            onMetaChange({ input: undefined });
            return;
          }
          if (value === "rom") {
            onMetaChange({ input: romReference() });
            return;
          }
          const patch = value.slice("patch:".length);
          onMetaChange({ input: member ? { member, patch } : { patch } });
        }}
        value={currentValue}
      >
        <option value="auto">
          {localizer.message(
            hasImplicitPredecessor ? "ui.patchChecks.precedingPatchOutput" : "ui.patchInputs.original",
          )}
        </option>
        {/* The explicit option must stay for every state: a select whose value is
            `rom` renders the first option when no matching one exists, which would
            display the automatic label for a pinned ROM. */}
        <option value="rom">{localizer.message("ui.patchInputs.original")}</option>
        {predecessors.map((predecessor) =>
          predecessor.id ? (
            <option key={predecessor.id} value={`patch:${predecessor.id}`}>
              {localizer.message("ui.patchChecks.patchOutput", { patch: predecessor.label })}
            </option>
          ) : null,
        )}
        {input && "patch" in input && !knownReference ? (
          <option value={`patch:${input.patch}`}>
            {localizer.message("ui.patchChecks.unknownPatchOutput", { patch: input.patch })}
          </option>
        ) : null}
      </DropdownSelect>
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
}) => {
  const localizer = useUiLocalizer();
  return (
    <label className="patch-enable">
      <input
        aria-label={localizer.message("ui.patch.include", { name: fileName.replace(/\.[^.]+$/, "") })}
        checked={!disabled}
        onChange={onToggle}
        type="checkbox"
      />
      <span aria-hidden="true" className="switch-state">
        <b className="on">{localizer.message("ui.patch.on")}</b>
        <b className="off">{localizer.message("ui.patch.off")}</b>
      </span>
    </label>
  );
};

/** The check that closes the patch-details form; it takes the menu's slot in
 * the action column while editing (commit happens on each field's blur; the
 * check just closes the form). Carries the same id as the menu's Edit item so
 * open/close drive one control identity. */
const PatchMetaDoneButton = ({ index, onToggle }: { index: number; onToggle: () => void }) => {
  const localizer = useUiLocalizer();
  return (
    <button
      aria-expanded
      aria-label={localizer.message("ui.patch.doneEditing")}
      className="rm patch-menu-btn is-editing"
      id={`rom-weaver-patch-meta-edit-${index}`}
      onClick={onToggle}
      title={localizer.message("ui.patch.done")}
      type="button"
    >
      <Check aria-hidden="true" />
    </button>
  );
};

const PatchActionsMenu = ({
  canMoveDown,
  canMoveUp,
  index,
  onMoveDown,
  onMoveUp,
  onReplace,
  onOpenChange,
  onEdit,
  onRemove,
  open,
}: {
  canMoveDown: boolean;
  canMoveUp: boolean;
  index: number;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onReplace: (file: File) => void;
  onOpenChange: (open: boolean) => void;
  /** Absent while the details form cannot be edited (no bundle meta channel). */
  onEdit?: () => void;
  onRemove: () => void;
  open: boolean;
}) => {
  const localizer = useUiLocalizer();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const close = () => {
    onOpenChange(false);
    buttonRef.current?.focus();
  };
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onOpenChange, open]);
  return (
    <div className="patch-menu" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={localizer.message("ui.patch.actions")}
        className={open ? "rm patch-menu-btn is-open" : "rm patch-menu-btn"}
        id={`rom-weaver-patch-menu-${index}`}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
        ref={buttonRef}
        title={localizer.message("ui.patch.actions")}
        type="button"
      >
        <EllipsisVertical aria-hidden="true" />
      </button>
      <div
        aria-label={localizer.message("ui.patch.actions")}
        className="patch-menu-list"
        hidden={!open}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
        role="menu"
      >
        <button
          className="patch-menu-item"
          disabled={!canMoveUp}
          id={`rom-weaver-patch-move-up-${index}`}
          onClick={() => {
            close();
            onMoveUp();
          }}
          role="menuitem"
          type="button"
        >
          <ArrowUp aria-hidden="true" />
          {localizer.message("ui.patch.moveUp")}
        </button>
        <button
          className="patch-menu-item"
          disabled={!canMoveDown}
          id={`rom-weaver-patch-move-down-${index}`}
          onClick={() => {
            close();
            onMoveDown();
          }}
          role="menuitem"
          type="button"
        >
          <ArrowDown aria-hidden="true" />
          {localizer.message("ui.patch.moveDown")}
        </button>
        <button
          className="patch-menu-item"
          id={`rom-weaver-patch-replace-${index}`}
          onClick={() => fileRef.current?.click()}
          title={localizer.message("ui.patch.replaceHelp")}
          role="menuitem"
          type="button"
        >
          <RefreshCw aria-hidden="true" />
          {localizer.message("ui.patch.replace")}
        </button>
        {onEdit ? (
          <button
            className="patch-menu-item"
            id={`rom-weaver-patch-meta-edit-${index}`}
            onClick={() => {
              onOpenChange(false);
              onEdit();
            }}
            role="menuitem"
            type="button"
          >
            <Pencil aria-hidden="true" />
            {localizer.message("ui.patch.editDetails")}
          </button>
        ) : null}
        <button
          aria-label={localizer.message("ui.patch.remove")}
          className="patch-menu-item is-danger"
          id={`rom-weaver-patch-menu-remove-${index}`}
          onClick={() => {
            onOpenChange(false);
            onRemove();
          }}
          role="menuitem"
          type="button"
        >
          <Trash2 aria-hidden="true" />
          {localizer.message("ui.patch.remove")}
        </button>
      </div>
      <input
        accept={getFileInputAcceptAttributes().patchReplace}
        aria-label={localizer.message("ui.patch.replacementInput")}
        className="sr-only"
        id={`rom-weaver-patch-replace-input-${index}`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          close();
          if (file) onReplace(file);
        }}
        ref={fileRef}
        tabIndex={-1}
        type="file"
      />
    </div>
  );
};

const getPatchCardVerdict = (validationState: string | undefined, isDisabled: boolean): "bad" | "ok" | undefined => {
  if (isDisabled) return undefined;
  if (validationState === "invalid") return "bad";
  if (validationState === "valid") return "ok";
  return undefined;
};

const PatchCard = ({
  basisChoice,
  basisDisabled,
  bundleSessionMatches,
  canReorder,
  chainChip,
  handleProps,
  hasImplicitPredecessor,
  index,
  orderIndex = index,
  isChainInput,
  isChainOutput,
  isDisabled,
  item,
  meta,
  onBasisChange,
  onMetaChange,
  onReorder,
  onTogglePatch,
  outputCheckHint,
  overrideAvailable,
  patchStack,
  predecessors,
  previousBasisAvailable,
  position,
  romActuals,
  rowProps,
  sharedRomChecks,
  stripDisabled,
  total,
}: {
  basisChoice: PatchInputBasis;
  basisDisabled?: boolean;
  /** A loaded bundle's patch list matches this card list; metadata may still be landing. */
  bundleSessionMatches?: boolean;
  canReorder: boolean;
  /** Plain-language chain verdict for the Checks drawer header readout. */
  chainChip?: { text: string; warn?: boolean } | null;
  handleProps: ReorderHandleProps;
  /** An earlier enabled patch writes to this patch's implicit target lane. */
  hasImplicitPredecessor: boolean;
  index: number;
  orderIndex?: number;
  isChainInput: boolean;
  isChainOutput: boolean;
  isDisabled: boolean;
  item: PatchStackItemState;
  meta?: BundlePatchMeta;
  onBasisChange?: (basis: PatchInputBasis) => void;
  onMetaChange?: (updates: Partial<BundlePatchMeta>) => void;
  onReorder: (from: number, to: number) => void;
  onTogglePatch?: (index: number) => void;
  outputCheckHint?: boolean;
  overrideAvailable?: boolean;
  patchStack: PatcherStackController;
  predecessors: readonly { id?: string; label: string; outputChecks?: ParsedBundleChecks }[];
  previousBasisAvailable: boolean;
  position: number;
  /** This patch's target ROM computed checks, for verifying input checks. */
  romActuals?: RomCheckActuals;
  rowProps: ReturnType<ReturnType<typeof useListReorder>["rowProps"]>;
  /** Checks declared for the one root-ROM state, shown only as read-only evidence. */
  sharedRomChecks?: ParsedBundleChecks;
  /** The cheat stack has a card switched On, so stripping is not on offer. */
  stripDisabled?: boolean;
  total: number;
}) => {
  // Pencil edit state: the name and description editors open/close together.
  const [metaEditing, setMetaEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const editing = metaEditing && !!onMetaChange;
  const description = meta?.description || "";
  // Keep the Extract and Checks drawers mounted to limit layout shifts.
  // The Reading status covers patch extraction and parsing; verification follows.
  const staging = !!item.progress;
  const stagingProps = staging ? toWorkflowFileProgressProps(item.progress) : null;
  const percent = stagePercent(stagingProps);
  // A patch pulled from a container archive extracts before it is parsed; the
  // runtime labels that stage "extracting …". (Patch rows have no validationPhase,
  // so the label is the available signal here - unlike ROM inputs.)
  const patchExtracting = /extract/i.test(String(stagingProps?.label ?? ""));
  const disabledClass = isDisabled ? "is-disabled" : undefined;
  const localizer = useUiLocalizer();
  const selectedInput = meta?.input;
  const sharedPredecessor =
    selectedInput && "patch" in selectedInput
      ? predecessors.find((predecessor) => predecessor.id === selectedInput.patch)
      : undefined;
  const usesRootRom = (!!selectedInput && "rom" in selectedInput) || item.chainVerdict?.matched.kind === "base";
  const sharedInputChecks = sharedPredecessor?.outputChecks || (usesRootRom ? sharedRomChecks : undefined);
  // A member lane names its track so the shared-check heading is unambiguous; the
  // whole-source lanes carry no member, so they read as the plain source name.
  const sharedInputLabel = sharedPredecessor
    ? sharedPredecessor.label + (selectedInput?.member ? ` / ${selectedInput.member}` : "")
    : usesRootRom
      ? localizer.message("ui.patchInputs.original") +
        (selectedInput && "rom" in selectedInput && selectedInput.member ? ` / ${selectedInput.member}` : "")
      : undefined;
  // A disabled patch is out of the run: its (stale) verification verdict
  // stays off the card; the Checks drawer stays editable (metadata only).
  const verdict = getPatchCardVerdict(item.validationState, isDisabled);
  // Verification is the second phase: once the ROM is ready, the deferred dry-run runs while
  // the card already shows its full body (Extract + Checks). A top-edge bar carries
  // that async work - a later phase following the "Reading…" staging bar.
  const verifying = !(staging || isDisabled) && item.validationState === "verifying";
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
          index={orderIndex}
          onReorder={onReorder}
          position={position}
          total={total}
        />
      }
      meta={
        <span className="patch-card-meta-controls" inert={menuOpen}>
          {onTogglePatch ? (
            <PatchEnableToggle disabled={isDisabled} fileName={item.fileName} onToggle={() => onTogglePatch(index)} />
          ) : null}
          {meta?.label ? <span className="meta-fmt mono">{meta.label}</span> : null}
          {/* Icon chips mark authored metadata such as a release tag or credit. */}
          {meta?.version ? (
            <span className="meta-fmt mono meta-ic" id={`rom-weaver-patch-card-version-${index}`}>
              <Tag aria-hidden="true" />
              <span className="sr-only">{localizer.message("ui.patch.version")} </span>
              {meta.version}
            </span>
          ) : null}
          {meta?.author ? (
            <span className="meta-fmt meta-ic meta-author" id={`rom-weaver-patch-card-author-${index}`}>
              <UserRound aria-hidden="true" />
              <span className="sr-only">{localizer.message("ui.patch.author")} </span>
              {meta.author}
            </span>
          ) : null}
          {staging ? null : (
            <PatchInputBasisSelect
              basis={basisChoice}
              disabled={basisDisabled}
              index={index}
              item={item}
              onChange={onBasisChange}
              patchStack={patchStack}
              previousBasisAvailable={previousBasisAvailable}
            />
          )}
          {staging ? null : (
            <PatchTarget
              disabled={!!item.optionsDisabled}
              hasImplicitPredecessor={hasImplicitPredecessor}
              hasTarget={!!item.targetOptions?.length}
              index={index}
              meta={meta}
              onMetaChange={onMetaChange}
              predecessors={predecessors}
            />
          )}
          {staging || isDisabled ? null : (
            <PatchTrackSelect
              disabled={!!item.optionsDisabled}
              index={index}
              meta={meta}
              onMetaChange={onMetaChange}
              sourceMembers={selectedInput && "patch" in selectedInput ? [] : item.targetOptions || []}
            />
          )}
          {staging || isDisabled ? null : (
            <PatchHeaderModeSelect index={index} item={item} patchStack={patchStack} stripDisabled={stripDisabled} />
          )}
          {staging || isDisabled ? null : <PatchN64ByteOrderSelect index={index} item={item} patchStack={patchStack} />}
          {staging ? (
            <StageStatus
              id={`rom-weaver-progress-patch-${index}`}
              label={stageStatusLabel(localizer.message("ui.patch.reading"), patchExtracting, localizer)}
              percent={percent}
            />
          ) : null}
        </span>
      }
      name={
        <ExtractName
          displayName={meta?.name}
          fileName={item.fileName}
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
        />
      }
      menu={
        editing ? (
          <PatchMetaDoneButton index={index} onToggle={() => setMetaEditing(false)} />
        ) : (
          <PatchActionsMenu
            canMoveDown={canReorder && orderIndex < total - 1}
            canMoveUp={canReorder && orderIndex > 0}
            index={index}
            onEdit={onMetaChange ? () => setMetaEditing(true) : undefined}
            onMoveDown={() => onReorder(orderIndex, orderIndex + 1)}
            onMoveUp={() => onReorder(orderIndex, orderIndex - 1)}
            onOpenChange={setMenuOpen}
            onRemove={() => patchStack.removeItem(index)}
            onReplace={(file) => patchStack.replaceItem(index, file)}
            open={menuOpen}
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
          {isDisabled || (staging && !patchExtracting && !meta) || (bundleSessionMatches && !meta) ? null : (
            <ExtractDrawer
              fileName={item.fileName}
              fileSize={item.fileSize}
              parentCompressions={item.archivePathEntries}
              timing={TIMING_LABEL(item.decompressionTimeMs)}
              typeLabel={item.format?.toUpperCase()}
            />
          )}
          {/* Reserve the Checks drawer through staging even before the parse
              lands - a patch still loading has no requirements yet, so it
              renders collapsed and empty (identical to a resolved no-checks
              patch). Mirrors the ROM card: keeping the drawer mounted holds the
              card's resolved height so the patch stack below doesn't jump when
              requirements arrive. */}
          <PatchChecksDrawer
            basisChoice={basisChoice}
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
            sharedInputChecks={sharedInputChecks}
            sharedInputLabel={sharedInputLabel}
          />
        </div>
      </div>
    </FileCard>
  );
};

const commonPatchMetaValue = (
  bundleMeta: readonly (BundlePatchMeta | undefined)[],
  field: "author" | "version",
): string | undefined => {
  const values = bundleMeta.map((meta) => meta?.[field] || "");
  return values.every((value) => value === values[0]) ? values[0] : undefined;
};

const SharedPatchMetaEditor = ({
  bundleMeta,
  onCancel,
  onApply,
}: {
  bundleMeta: readonly (BundlePatchMeta | undefined)[];
  onCancel: () => void;
  onApply: (updates: Partial<BundlePatchMeta>, enabled?: boolean) => void;
}) => {
  const [author, setAuthor] = useState(commonPatchMetaValue(bundleMeta, "author") || "");
  const [authorChanged, setAuthorChanged] = useState(false);
  const [enabled, setEnabled] = useState<"all" | "none" | "unchanged">("unchanged");
  const [version, setVersion] = useState(commonPatchMetaValue(bundleMeta, "version") || "");
  const [versionChanged, setVersionChanged] = useState(false);
  const versionInputRef = useRef<HTMLInputElement>(null);
  const localizer = useUiLocalizer();

  useEffect(() => versionInputRef.current?.focus(), []);

  const apply = () => {
    const updates: Partial<BundlePatchMeta> = {};
    if (authorChanged) updates.author = author.trim() || undefined;
    if (versionChanged) updates.version = version.trim() || undefined;
    onApply(updates, enabled === "unchanged" ? undefined : enabled === "all");
  };

  return (
    <form
      aria-labelledby="rom-weaver-bulk-patch-meta-title"
      className="patch-shared-meta-editor"
      id="rom-weaver-bulk-patch-meta"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <div className="patch-shared-meta-heading" id="rom-weaver-bulk-patch-meta-title">
        <strong>{localizer.message("ui.patch.bulkEdit")}</strong>
        <span>{localizer.message("ui.patch.bulkEditHelp")}</span>
      </div>
      <div className="patch-shared-meta-field">
        <label htmlFor="rom-weaver-shared-patch-version">{localizer.message("ui.patch.version")}</label>
        <input
          className="input popt-input"
          id="rom-weaver-shared-patch-version"
          onChange={(event) => {
            setVersion(event.currentTarget.value);
            setVersionChanged(true);
          }}
          placeholder={localizer.message(
            commonPatchMetaValue(bundleMeta, "version") === undefined ? "ui.patch.multipleValues" : "ui.patch.version",
          )}
          ref={versionInputRef}
          type="text"
          value={version}
        />
      </div>
      <div className="patch-shared-meta-field">
        <label htmlFor="rom-weaver-shared-patch-author">{localizer.message("ui.patch.author")}</label>
        <input
          className="input popt-input"
          id="rom-weaver-shared-patch-author"
          onChange={(event) => {
            setAuthor(event.currentTarget.value);
            setAuthorChanged(true);
          }}
          placeholder={localizer.message(
            commonPatchMetaValue(bundleMeta, "author") === undefined ? "ui.patch.multipleValues" : "ui.patch.author",
          )}
          type="text"
          value={author}
        />
      </div>
      <div className="patch-shared-meta-field">
        <label htmlFor="rom-weaver-shared-patch-enablement">{localizer.message("ui.patch.bulkSelection")}</label>
        <DropdownSelect
          className="input popt-input"
          id="rom-weaver-shared-patch-enablement"
          onChange={(event) => setEnabled(event.currentTarget.value as typeof enabled)}
          value={enabled}
        >
          <option value="unchanged">{localizer.message("ui.patch.bulkSelectionUnchanged")}</option>
          <option value="all">{localizer.message("ui.patch.bulkSelectionAll")}</option>
          <option value="none">{localizer.message("ui.patch.bulkSelectionOptional")}</option>
        </DropdownSelect>
      </div>
      <div className="patch-shared-meta-actions">
        <button className="btn ghost" onClick={onCancel} type="button">
          {localizer.message("ui.common.cancel")}
        </button>
        <button className="btn primary" type="submit">
          {localizer.message("ui.patch.applyToAll")}
        </button>
      </div>
    </form>
  );
};

const ApplyPatchListStep = ({
  bundleOutputCheckHint,
  bundleSessionMatches,
  disabledFlags,
  emptyState,
  fault,
  bundleMeta,
  onBundleMetaChange,
  onBundleMetaBulkChange,
  onTogglePatch,
  notice,
  overrideAvailable,
  patches,
  patchKeys,
  patchStack,
  patchInputBasis = "auto",
  patchInputBasisDisabled = false,
  onPatchInputBasisChange,
  romActualsById,
  sharedRomChecks,
  stripDisabled,
  cheats,
  woven,
}: {
  /** The run has optional/skipped patches: hint on the chain-output card that its
   * expected output only describes the full chain. */
  bundleOutputCheckHint?: boolean;
  /** A loaded bundle's delivered patch names match the current patch list. */
  bundleSessionMatches?: boolean;
  disabledFlags?: readonly boolean[];
  /** Fixture shown when no patches are present. */
  emptyState?: ReactNode;
  fault?: boolean;
  /** Per-index editable bundle metadata. */
  bundleMeta?: readonly (BundlePatchMeta | undefined)[];
  onBundleMetaChange?: (index: number, updates: Partial<BundlePatchMeta>) => void;
  onBundleMetaBulkChange?: (updates: Partial<BundlePatchMeta>) => void;
  onTogglePatch?: (index: number) => void;
  notice?: ReactNode;
  /** The 0x04 "Apply anyway…" override toggle is on offer - fault hints name it. */
  overrideAvailable?: boolean;
  /** ROM id → its computed checks, for verifying user-entered input checks against
   * the real ROM (the chain-input patch's target). */
  romActualsById?: ReadonlyMap<string, RomCheckActuals>;
  /** Checks declared for the single selected ROM, repeated as card evidence. */
  sharedRomChecks?: ParsedBundleChecks;
  patches: PatchStackItemState[];
  patchKeys?: readonly string[];
  patchStack: PatcherStackController;
  patchInputBasis?: PatchInputBasis;
  patchInputBasisDisabled?: boolean;
  onPatchInputBasisChange?: (index: number, basis: PatchInputBasis) => void;
  /** The cheat stack has a card switched On, so stripping is not on offer. */
  stripDisabled?: boolean;
  cheats?: CheatStackRenderState;
  woven?: boolean;
}) => {
  const [bulkEditing, setBulkEditing] = useState(false);
  const [cheatOrder, setCheatOrder] = useState<Array<{ id: string; position: number }>>([]);
  const bulkEditButtonRef = useRef<HTMLButtonElement>(null);
  const closeBulkEditor = () => {
    setBulkEditing(false);
    queueMicrotask(() => bulkEditButtonRef.current?.focus());
  };
  const total = patches.length;
  const cheatCards = cheats?.cards || [];
  const currentCheatIds = new Set(cheatCards.map(({ record }) => record.id));
  const orderedCheatIds = [
    ...cheatOrder.filter(({ id }) => currentCheatIds.has(id)).map(({ id }) => id),
    ...cheatCards.map(({ record }) => record.id).filter((id) => !cheatOrder.some((entry) => entry.id === id)),
  ];
  const cheatPositions = new Map(cheatOrder.map(({ id, position }) => [id, Math.min(position, total)]));
  const mixedEntries: Array<{ kind: "patch"; index: number } | { kind: "cheat"; id: string }> = [];
  for (let position = 0; position <= total; position += 1) {
    for (const id of orderedCheatIds) {
      if ((cheatPositions.get(id) ?? total) === position) mixedEntries.push({ kind: "cheat", id });
    }
    if (position < total) mixedEntries.push({ kind: "patch", index: position });
  }
  const visibleEntries = mixedEntries;
  const canReorder = visibleEntries.length > 1 && patches.every((item) => item.progress || item.canRemove);
  const publishCheatOrder = (entries: typeof mixedEntries) => {
    let patchPosition = 0;
    const nextOrder: Array<{ id: string; position: number }> = [];
    for (const entry of entries) {
      if (entry.kind === "patch") {
        if (!disabledFlags?.[entry.index]) patchPosition += 1;
      } else {
        nextOrder.push({ id: entry.id, position: patchPosition });
      }
    }
    cheats?.onOrderChange(nextOrder);
  };
  const reorderMixed = (from: number, to: number) => {
    const next = reorder(visibleEntries, from, to);
    const moved = visibleEntries[from];
    if (!moved) return;
    if (cheats) {
      let patchPosition = 0;
      const nextOrder: Array<{ id: string; position: number }> = [];
      for (const entry of next) {
        if (entry.kind === "patch") patchPosition += 1;
        else nextOrder.push({ id: entry.id, position: patchPosition });
      }
      setCheatOrder(nextOrder);
      publishCheatOrder(next);
    }
    if (moved.kind === "patch") {
      const nextIndex = next
        .filter((entry) => entry.kind === "patch")
        .findIndex((entry) => entry.index === moved.index);
      if (nextIndex !== moved.index) patchStack.reorder(moved.index, nextIndex);
    }
  };
  const reorderList = useListReorder({ count: visibleEntries.length, disabled: !canReorder, onReorder: reorderMixed });
  const cheatOrderCallbackRef = useRef(cheats?.onOrderChange);
  cheatOrderCallbackRef.current = cheats?.onOrderChange;
  const cheatOrderKey = JSON.stringify({
    hasCheats: !!cheats,
    entries: mixedEntries,
    disabledFlags,
    patchKeys,
  });
  useEffect(() => {
    const snapshot = JSON.parse(cheatOrderKey) as {
      hasCheats: boolean;
      entries: typeof mixedEntries;
      disabledFlags?: readonly boolean[];
    };
    if (!snapshot.hasCheats) return;
    let patchPosition = 0;
    const order: Array<{ id: string; position: number }> = [];
    for (const entry of snapshot.entries) {
      if (entry.kind === "patch") {
        if (!snapshot.disabledFlags?.[entry.index]) patchPosition += 1;
      } else {
        order.push({ id: entry.id, position: patchPosition });
      }
    }
    cheatOrderCallbackRef.current?.(order);
  }, [cheatOrderKey]);
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
        <InfoPopover title={localizer.message("ui.patch.supportedTypes")}>
          <strong>{localizer.message("ui.patch.supportedTypes")}</strong>
          <ul className="info-list">
            <li>{localizer.message("ui.patch.supportedTypesList")}</li>
            <li>{localizer.message("ui.patch.ninjaUnsupported")}</li>
            <li>{localizer.message("ui.patch.pdsUnsupported")}</li>
            <li>{localizer.message("ui.patch.archiveSupport")}</li>
          </ul>
        </InfoPopover>
      }
      headerExtra={
        total > 1 && onBundleMetaBulkChange ? (
          <button
            aria-controls="rom-weaver-bulk-patch-meta"
            aria-expanded={bulkEditing}
            className="patch-bulk-edit-button"
            onClick={() => setBulkEditing((editing) => !editing)}
            ref={bulkEditButtonRef}
            type="button"
          >
            <Pencil aria-hidden="true" />
            {localizer.message("ui.patch.bulkEdit")}
          </button>
        ) : undefined
      }
      meta={
        total > 0 ? (
          <>
            <span className="rb mono">{localizer.messageCount("ui.patch.fileCount", enabledCount)}</span>
            {disabledCount ? (
              <span className="rb mono muted">{localizer.messageCount("ui.patch.disabledCount", disabledCount)}</span>
            ) : null}
            {enabledBytes ? <span className="rb mono">{formatByteSize(enabledBytes)}</span> : null}
          </>
        ) : undefined
      }
      num="0x03"
      title={localizer.message(cheats ? "ui.step.patchesCheats" : "ui.step.patches")}
      woven={woven}
    >
      {bulkEditing && onBundleMetaBulkChange ? (
        <SharedPatchMetaEditor
          key="bulk-patch-meta-editor"
          bundleMeta={bundleMeta || patches.map(() => undefined)}
          onApply={(updates, enabled) => {
            onBundleMetaBulkChange(updates);
            if (enabled !== undefined && onTogglePatch) {
              disabledFlags?.forEach((disabled, index) => {
                if (disabled === enabled) onTogglePatch(index);
              });
            }
            closeBulkEditor();
          }}
          onCancel={closeBulkEditor}
        />
      ) : null}
      {total === 0 ? emptyState : null}
      <div
        className="cards patch-cards workflow-file-list"
        id="rom-weaver-list-patch-stack"
        ref={reorderList.containerRef}
      >
        {visibleEntries.map((entry, orderIndex) => {
          if (entry.kind === "cheat") {
            const cheat = cheatCards.find(({ record }) => record.id === entry.id);
            return cheat ? (
              <Fragment key={`cheat:${entry.id}`}>
                {cheats?.renderCard(
                  cheat,
                  reorderList.displayIndex(orderIndex) + 1,
                  canReorder,
                  reorderList.handleProps(orderIndex),
                  reorderList.rowProps(orderIndex),
                )}
              </Fragment>
            ) : null;
          }
          const index = entry.index;
          const item = patches[index];
          if (!item) return null;
          return (
            <PatchCard
              basisChoice={
                index === chainInputIndex && (bundleMeta?.[index]?.basis || patchInputBasis) === "previous"
                  ? "base"
                  : bundleMeta?.[index]?.basis || patchInputBasis
              }
              basisDisabled={patchInputBasisDisabled}
              bundleSessionMatches={bundleSessionMatches}
              canReorder={canReorder}
              chainChip={chainChipText(
                item,
                !!item.targetValue &&
                  patches.some(
                    (predecessor, predecessorIndex) =>
                      predecessorIndex < index &&
                      !disabledFlags?.[predecessorIndex] &&
                      predecessor.targetValue === item.targetValue,
                  ),
                enabledIndexes,
                localizer,
                patches.map((patch, patchIndex) => bundleMeta?.[patchIndex]?.name || patch.fileName),
              )}
              handleProps={reorderList.handleProps(orderIndex)}
              hasImplicitPredecessor={
                !!item.targetValue &&
                patches.some(
                  (predecessor, predecessorIndex) =>
                    predecessorIndex < index &&
                    !disabledFlags?.[predecessorIndex] &&
                    predecessor.targetValue === item.targetValue,
                )
              }
              index={index}
              orderIndex={orderIndex}
              isChainInput={index === chainInputIndex}
              isChainOutput={index === chainOutputIndex}
              isDisabled={!!disabledFlags?.[index]}
              item={item}
              key={item.key ?? `${index}:${item.fileName}`}
              meta={bundleMeta?.[index]}
              onBasisChange={(basis) => onPatchInputBasisChange?.(index, basis)}
              onMetaChange={onBundleMetaChange ? (updates) => onBundleMetaChange(index, updates) : undefined}
              onReorder={reorderMixed}
              onTogglePatch={onTogglePatch}
              outputCheckHint={!!bundleOutputCheckHint && index === chainOutputIndex}
              overrideAvailable={overrideAvailable}
              patchStack={patchStack}
              predecessors={patches.slice(0, index).map((predecessor, predecessorIndex) => {
                const predecessorMeta = bundleMeta?.[predecessorIndex];
                return {
                  id: predecessorMeta?.id,
                  label: predecessorMeta?.name || predecessor.fileName || `Patch ${predecessorIndex + 1}`,
                  outputChecks: predecessorMeta?.outputChecks,
                };
              })}
              previousBasisAvailable={index !== chainInputIndex}
              position={reorderList.displayIndex(orderIndex) + 1}
              romActuals={item.targetValue ? romActualsById?.get(item.targetValue) : undefined}
              rowProps={reorderList.rowProps(orderIndex)}
              sharedRomChecks={sharedRomChecks}
              stripDisabled={stripDisabled}
              total={visibleEntries.length}
            />
          );
        })}
      </div>
      {cheats?.controls}
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
      {notice}
    </StepSection>
  );
};

export { ApplyPatchListStep, EditableCheckRow, type RomCheckActuals };
