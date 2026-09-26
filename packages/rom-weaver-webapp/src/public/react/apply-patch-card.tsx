import { Tag, UserRound } from "lucide-react";
import { useState } from "react";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import { ExtractDrawer, ExtractName } from "./components/ds/extraction-tree.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { StageStatus, stageBarValue, stagePercent, stageStatusLabel } from "./components/ds/staging-meta.tsx";
import { useListReorder } from "./components/ds/use-list-reorder.ts";
import type { PatcherStackController } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import { useRomWeaverSettings, useUiLocalizer } from "./settings-context.tsx";
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";
import type { PatchInputBasis } from "./patch-input-basis.ts";
import { toWorkflowFileProgressProps } from "./workflow-run-hooks.ts";
import { TIMING_LABEL, PatchFaultWell } from "./apply-patch-list-helpers.tsx";
import {
  type ReorderHandleProps,
  PatchDragHandle,
  PatchEnableToggle,
  PatchMetaDoneButton,
  PatchActionsMenu,
} from "./apply-patch-card-controls.tsx";
import type { RomCheckActuals } from "./apply-patch-input-checks.ts";
import { PatchMetaFields } from "./apply-patch-meta-fields.tsx";
import {
  PatchHeaderModeSelect,
  PatchTrackSelect,
  PatchN64ByteOrderSelect,
  PatchRunsOnSelect,
} from "./apply-patch-selects.tsx";
import { PatchChecksDrawer } from "./apply-patch-checks-drawer.tsx";

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
  const { detailedViewEnabled = false } = useRomWeaverSettings();
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
          {!detailedViewEnabled ||
          isDisabled ||
          (staging && !patchExtracting && !meta) ||
          (bundleSessionMatches && !meta) ? null : (
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
            patchType={detailedViewEnabled ? undefined : item.format?.trim().toUpperCase() || undefined}
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

export { PatchCard };
