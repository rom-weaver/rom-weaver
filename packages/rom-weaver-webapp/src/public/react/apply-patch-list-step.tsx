import {
  ArrowLeftRight,
  Check,
  Disc3,
  GitBranch,
  Pencil,
  Plus,
  Scissors,
  Tag,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { CHEAT_HEADER_STRIP_HINT } from "../../lib/cheats/header-guard.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import {
  CHECK_FIELDS_PAIRED,
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
import { reorder, useListReorder } from "./components/ds/use-list-reorder.ts";
import type { PatcherStackController } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import { formatHeaderAutoLabel } from "./patcher-view-models.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";
import type { PatchInputBasis } from "./patch-input-basis.ts";
import type { CheatStackRenderState } from "./components/cheat-database-section.tsx";
import { toWorkflowFileProgressProps } from "./workflow-run-hooks.ts";
import {
  TIMING_LABEL,
  CHECKSUM_TIMING_LABEL,
  getPatchVerificationRows,
  PatchFaultWell,
  PreflightSuccess,
  autosizeTextarea,
  getEmbeddedChecks,
  bundleCheckRows,
} from "./apply-patch-list-helpers.tsx";
import {
  type ReorderHandleProps,
  PatchDragHandle,
  PatchEnableToggle,
  PatchMetaDoneButton,
  PatchActionsMenu,
} from "./apply-patch-card-controls.tsx";
import {
  chainChipText,
  resolvedBasisLabel,
  checkInputBasisLabel,
  IdentifiedCheckTitle,
} from "./apply-patch-chain-labels.tsx";
import { type RomCheckActuals, matchInputCheck, checkErrorMessage } from "./apply-patch-input-checks.ts";

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

/**
 * The patch's ROM track, as a select. Shown only when the run offers more than
 * one patchable track. The choice goes through `setPatchTarget`, which resolves
 * the row to its input asset and stores that asset's member locator; a row id or
 * file name is not a member path, so it MUST NOT be written to `input.member`.
 * An imported ROM input member is dropped on a change, because every metadata
 * sync re-resolves the target from that member and would undo the choice.
 */
const PatchTrackSelect = ({
  disabled,
  index,
  item,
  meta,
  onMetaChange,
  patchStack,
}: {
  disabled?: boolean;
  index: number;
  item: PatchStackItemState;
  meta?: BundlePatchMeta;
  onMetaChange?: (updates: Partial<BundlePatchMeta>) => void;
  patchStack: PatcherStackController;
}) => {
  const localizer = useUiLocalizer();
  if (!item.targetOptions || item.targetOptions.length <= 1) return null;
  return (
    <span className="target-grp patch-track-grp">
      <Disc3 aria-hidden="true" />
      <label className="sr-only" htmlFor={`rom-weaver-patch-track-${index}`}>
        {localizer.message("ui.patch.track")}
      </label>
      <DropdownSelect
        className="meta-target-select mono ptgt-sel"
        disabled={disabled || item.targetDisabled}
        id={`rom-weaver-patch-track-${index}`}
        onChange={(event) => {
          const input = meta?.input;
          if (input && "rom" in input && input.member) onMetaChange?.({ input: { rom: true } });
          patchStack.setPatchTarget?.(index, event.currentTarget.value);
        }}
        value={item.targetValue || ""}
      >
        <option disabled value="">
          {localizer.message("ui.patch.selectTrack")}
        </option>
        {item.targetOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
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
 * The one "runs on" choice for a patch: the stack state it applies to. It writes
 * the run input and the matching basis together, because the engine pairs a ROM
 * input with the `base` basis and a patch-output input with `previous`; two
 * separate selects let them disagree. Unset keeps the checksum-resolved default.
 */
const PatchRunsOnSelect = ({
  basis,
  disabled,
  hasImplicitPredecessor,
  index,
  item,
  meta,
  onBasisChange,
  onMetaChange,
  patchStack,
  predecessors,
  previousBasisAvailable,
}: {
  basis: PatchInputBasis;
  disabled?: boolean;
  hasImplicitPredecessor: boolean;
  index: number;
  item: PatchStackItemState;
  meta?: BundlePatchMeta;
  onBasisChange?: (basis: PatchInputBasis) => void;
  onMetaChange?: (updates: Partial<BundlePatchMeta>) => void;
  patchStack: PatcherStackController;
  predecessors: readonly { id?: string; label: string }[];
  previousBasisAvailable: boolean;
}) => {
  const localizer = useUiLocalizer();
  const input = meta?.input;
  const namedPredecessors = onMetaChange ? predecessors.filter((predecessor) => predecessor.id) : [];
  let currentValue = "auto";
  if (input) currentValue = "rom" in input ? "rom" : `patch:${input.patch}`;
  else if (basis === "base") currentValue = "rom";
  else if (basis === "previous") currentValue = "previous";
  const knownReference = !!input && "patch" in input && namedPredecessors.some((entry) => entry.id === input.patch);
  // A member can select a leaf from either the ROM or a generated patch output.
  // Preserve it when the source changes so an imported bundle keeps its exact
  // source instead of silently broadening the reference.
  const member = input?.member;
  const setBasis = (next: PatchInputBasis) => {
    onBasisChange?.(next);
    void patchStack.setPatchOption?.(index, { basis: next === "auto" ? undefined : next, revalidate: true });
  };
  // Clearing an input that is already unset would revalidate every patch for nothing.
  const setInput = (next: BundlePatchMeta["input"]) => {
    if (onMetaChange && (next || input)) onMetaChange({ input: next });
  };
  const verdictBasis = item.chainVerdict?.basis ?? (hasImplicitPredecessor ? "previous" : "base");
  return (
    <span className="target-grp patch-target-grp">
      <GitBranch aria-hidden="true" />
      <label className="sr-only" htmlFor={`rom-weaver-select-patch-target-${index}`}>
        {localizer.message("ui.patch.runsOn", { n: index + 1 })}
      </label>
      <DropdownSelect
        className="meta-target-select mono ptgt-sel"
        disabled={disabled}
        id={`rom-weaver-select-patch-target-${index}`}
        onChange={(event) => {
          if (disabled) return;
          const value = event.currentTarget.value;
          if (value === "auto") {
            setInput(undefined);
            setBasis("auto");
            return;
          }
          if (value === "rom") {
            setInput(member ? { member, rom: true } : { rom: true });
            setBasis("base");
            return;
          }
          if (value === "previous") {
            setInput(undefined);
            setBasis("previous");
            return;
          }
          const patch = value.slice("patch:".length);
          setInput(member ? { member, patch } : { patch });
          setBasis("previous");
        }}
        value={currentValue}
      >
        <option value="auto">{resolvedBasisLabel("auto", localizer, verdictBasis)}</option>
        {/* The explicit option must stay for every state: a select whose value is
            `rom` renders the first option when no matching one exists, which would
            display the automatic label for a pinned ROM. */}
        <option value="rom">{localizer.message("ui.patchInputs.original")}</option>
        <option disabled={!previousBasisAvailable} value="previous">
          {localizer.message("ui.patchInputs.previous")}
        </option>
        {namedPredecessors.map((predecessor) => (
          <option key={predecessor.id} value={`patch:${predecessor.id}`}>
            {localizer.message("ui.patchChecks.patchOutput", { patch: predecessor.label })}
          </option>
        ))}
        {input && "patch" in input && !knownReference ? (
          <option value={`patch:${input.patch}`}>
            {localizer.message("ui.patchChecks.unknownPatchOutput", { patch: input.patch })}
          </option>
        ) : null}
      </DropdownSelect>
    </span>
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
  // Tracks belong to the original ROM, so a patch-output source has none to pick.
  const showTrack = !(staging || isDisabled || (selectedInput && "patch" in selectedInput));
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
            <PatchRunsOnSelect
              basis={basisChoice}
              disabled={basisDisabled || !!item.optionsDisabled}
              hasImplicitPredecessor={hasImplicitPredecessor}
              index={index}
              item={item}
              meta={meta}
              onBasisChange={onBasisChange}
              onMetaChange={onMetaChange}
              patchStack={patchStack}
              predecessors={predecessors}
              previousBasisAvailable={previousBasisAvailable}
            />
          )}
          {showTrack ? (
            <PatchTrackSelect
              disabled={!!item.optionsDisabled}
              index={index}
              item={item}
              meta={meta}
              onMetaChange={onMetaChange}
              patchStack={patchStack}
            />
          ) : null}
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
  // An earlier enabled patch on the same target lane feeds this patch implicitly.
  const implicitPredecessors = patches.map(
    (item, index) =>
      !!item.targetValue &&
      enabledIndexes.some(
        (predecessorIndex) => predecessorIndex < index && patches[predecessorIndex]?.targetValue === item.targetValue,
      ),
  );
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
                implicitPredecessors[index] ?? false,
                enabledIndexes,
                localizer,
                patches.map((patch, patchIndex) => bundleMeta?.[patchIndex]?.name || patch.fileName),
              )}
              handleProps={reorderList.handleProps(orderIndex)}
              hasImplicitPredecessor={implicitPredecessors[index] ?? false}
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
