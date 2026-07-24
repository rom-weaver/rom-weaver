import { type ReactNode, useState } from "react";
import { join } from "./cx.ts";

/**
 * Candidate-selection tree. Presentational list of files found inside an
 * archive; selectable rows invoke `onSelect`, non-selectable rows render dimmed
 * with an explanatory note. Used inside the selection modal.
 */

type SelectionItem = {
  id: string;
  name: ReactNode;
  sizeLabel?: ReactNode;
  note?: ReactNode;
  /** Archive-nesting path of the entry (e.g. "B_disc1.zip"), rendered as a sub-line for context. */
  breadcrumb?: string;
  /** Full source archive the entry came from, rendered as a sub-heading under the name. */
  subheading?: string;
  matches?: boolean;
  /** Checked when the multi-select picker first opens. When at least one item sets it, only the
   * flagged items start selected; otherwise every selectable item does. */
  defaultSelected?: boolean;
  selectable: boolean;
};

/* The prototype picker row: crumb + name get the full row width (long names
   wrap instead of forcing the dialog wider than the screen) and tag/size ride
   a meta line underneath. */
const SelectionRowBody = ({ item }: { item: SelectionItem }) => (
  <span className="pick-main">
    {item.breadcrumb ? <span className="pick-crumb mono">{item.breadcrumb} ›</span> : null}
    <span className="pick-name mono">{item.name}</span>
    {item.subheading || item.matches || item.note || item.sizeLabel ? (
      <span className="pick-meta">
        {item.subheading ? <span className="pick-archive mono">{item.subheading}</span> : null}
        {item.matches ? <span className="tag fmt matches">matches patch</span> : null}
        {item.note ? <span className="pick-note">{item.note}</span> : null}
        {item.sizeLabel ? <span className="pick-size mono">{item.sizeLabel}</span> : null}
      </span>
    ) : null}
  </span>
);

const SelectionTree = ({ items, onSelect }: { items: SelectionItem[]; onSelect: (id: string) => void }) => (
  // Selectable entries are real buttons (native keyboard + focus); the rest are
  // inert dimmed rows.
  <div className="seltree picklist">
    {items.map((item) =>
      item.selectable ? (
        <button
          className={join("selnode", "selrow", "pick-row")}
          key={item.id}
          onClick={() => onSelect(item.id)}
          type="button"
        >
          <SelectionRowBody item={item} />
        </button>
      ) : (
        <div className={join("selnode", "selrow", "pick-row", "skip", "off")} key={item.id}>
          <SelectionRowBody item={item} />
        </div>
      ),
    )}
  </div>
);

/**
 * Multi-select candidate list: selectable rows are checkboxes (selection order is preserved) and a
 * confirm button submits the chosen ids. Used when a source exposes several patches that may each be
 * added to the patch stack.
 */
const SelectionCheckList = ({
  items,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  items: SelectionItem[];
  onCancel?: () => void;
  onSubmit: (ids: string[]) => void;
  submitLabel?: (count: number) => string;
}) => {
  const selectableItems = items.filter((item) => item.selectable);
  const selectableIds = selectableItems.map((item) => item.id);
  const defaultIds = selectableItems.filter((item) => item.defaultSelected).map((item) => item.id);
  // A picker may nominate default picks (the same-named leaf for a "replace from archive"); when it
  // does, only those start selected. Otherwise every selectable entry starts selected (add-all).
  const initialSelectedIds = defaultIds.length ? defaultIds : selectableIds;
  // `items` is a fresh array on every parent render, and the hosting form re-renders on every
  // background progress tick, so keying the reset on identity wiped the user's unchecks the instant
  // anything else moved. The candidate set's CONTENT is what decides whether this is a new picker.
  const candidateKey = selectableItems.map((item) => `${item.defaultSelected ? "*" : ""}${item.id}`).join("|");
  const [selection, setSelection] = useState({ ids: initialSelectedIds, key: candidateKey });
  // Documented React "adjust state when props change" pattern: re-seed during render (not in an
  // effect) so a genuinely new candidate set never paints one frame with the old selection.
  if (selection.key !== candidateKey) setSelection({ ids: initialSelectedIds, key: candidateKey });
  const selectedIds = selection.key === candidateKey ? selection.ids : initialSelectedIds;
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.includes(id));
  const setSelectedIds = (ids: string[]) => setSelection({ ids, key: candidateKey });
  const toggle = (id: string) =>
    setSelectedIds(selectedIds.includes(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id]);
  const toggleAll = () => setSelectedIds(allSelected ? [] : selectableIds);
  return (
    <div className="selcheckwrap">
      <div className="seltree picklist">
        {items.map((item) =>
          item.selectable ? (
            // The highlighted row IS the selection state - the checkbox stays
            // real but visually hidden (.pick-input) for keyboard + SR.
            <label className={join("selnode", "selrow", "selcheck", "pick-row")} key={item.id}>
              <input
                checked={selectedIds.includes(item.id)}
                className="pick-input"
                onChange={() => toggle(item.id)}
                type="checkbox"
              />
              <SelectionRowBody item={item} />
            </label>
          ) : (
            <div className={join("selnode", "selrow", "pick-row", "skip", "off")} key={item.id}>
              <SelectionRowBody item={item} />
            </div>
          ),
        )}
      </div>
      <div className="selfoot">
        {selectableItems.length > 1 ? (
          <>
            <button className="btn ghost selall" onClick={toggleAll} type="button">
              {allSelected ? "Clear all" : "Select all"}
            </button>
            <span className="selcount">
              {selectedIds.length} of {selectableItems.length} selected
            </span>
          </>
        ) : null}
        {onCancel ? (
          <button className="btn ghost" onClick={onCancel} type="button">
            Cancel
          </button>
        ) : null}
        <button
          className="btn primary selconfirm"
          disabled={!selectedIds.length}
          onClick={() => onSubmit(selectedIds)}
          type="button"
        >
          {submitLabel ? submitLabel(selectedIds.length) : `Add ${selectedIds.length} selected`}
        </button>
      </div>
    </div>
  );
};

export { SelectionCheckList, type SelectionItem, SelectionTree };
