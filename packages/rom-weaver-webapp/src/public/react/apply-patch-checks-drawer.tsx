import { Plus, TriangleAlert } from "lucide-react";
import { Fragment, useState } from "react";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import {
  CHECK_FIELDS_PAIRED,
  CHECK_LABELS,
  type CheckAlgorithm,
  type CheckField,
  isValidCheckValue,
  normalizeCheckInput,
} from "./components/ds/check-fields.ts";
import { ChecksumList, ChecksumRow } from "./components/ds/checksum-list.tsx";
import { DrawerReadout } from "./components/ds/drawer.tsx";
import { DropdownSelect } from "./components/ds/dropdown-select.tsx";
import type { PatcherStackController } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";
import type { PatchInputBasis } from "./patch-input-basis.ts";
import {
  CHECKSUM_TIMING_LABEL,
  getPatchVerificationRows,
  PreflightSuccess,
  getEmbeddedChecks,
  bundleCheckRows,
} from "./apply-patch-list-helpers.tsx";
import { checkInputBasisLabel, IdentifiedCheckTitle } from "./apply-patch-chain-labels.tsx";
import { type RomCheckActuals, matchInputCheck } from "./apply-patch-input-checks.ts";
import { EditableCheckRow } from "./apply-patch-check-row.tsx";

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
  patchType,
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
  patchType?: string;
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
      summary={patchType ? <DrawerReadout>{patchType}</DrawerReadout> : undefined}
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

export { PatchChecksDrawer };
