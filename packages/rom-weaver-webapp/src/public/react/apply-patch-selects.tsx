import { ArrowLeftRight, Disc3, GitBranch, Scissors } from "lucide-react";
import { CHEAT_HEADER_STRIP_HINT } from "../../lib/cheats/header-guard.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
import { DropdownSelect } from "./components/ds/dropdown-select.tsx";
import type { PatcherStackController } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import { formatHeaderAutoLabel } from "./patcher-view-models.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";
import type { PatchInputBasis } from "./patch-input-basis.ts";
import { resolvedBasisLabel } from "./apply-patch-chain-labels.tsx";

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

export { PatchHeaderModeSelect, PatchTrackSelect, PatchN64ByteOrderSelect, PatchRunsOnSelect };
