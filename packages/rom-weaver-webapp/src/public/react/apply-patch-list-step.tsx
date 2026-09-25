import { Pencil, TriangleAlert } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import { DropdownSelect } from "./components/ds/dropdown-select.tsx";
import { InfoPopover, StepSection } from "./components/ds/layout.tsx";
import { reorder, useListReorder } from "./components/ds/use-list-reorder.ts";
import type { PatcherStackController } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";
import type { PatchInputBasis } from "./patch-input-basis.ts";
import type { CheatStackRenderState } from "./components/cheat-database-section.tsx";
import { chainChipText } from "./apply-patch-chain-labels.tsx";
import type { RomCheckActuals } from "./apply-patch-input-checks.ts";
import { PatchCard } from "./apply-patch-card.tsx";
import { EditableCheckRow } from "./apply-patch-check-row.tsx";

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

export { ApplyPatchListStep, EditableCheckRow };
