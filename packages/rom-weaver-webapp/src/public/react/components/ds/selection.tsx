import { type ReactNode, useMemo, useState } from "react";
import { isRomFileName } from "../../file-classification.ts";
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
  /** Checked when the multi-select picker first opens. */
  defaultSelected?: boolean;
  selectable: boolean;
};

/**
 * Past this many rows the list gets `content-visibility: auto` (via `.picklist.long`),
 * so the browser skips layout and paint for rows outside the viewport. That is
 * the platform's own windowing - no scroll maths, no measured row heights, and
 * no dependency - and it keeps the rows variable-height, which hand-rolled
 * windowing here could not.
 */
const VIRTUALIZE_ROW_THRESHOLD = 200;

/** The text a row is matched against - only the string parts a user can read. */
const getSearchText = (item: SelectionItem): string =>
  [typeof item.name === "string" ? item.name : "", item.subheading || "", item.breadcrumb || ""]
    .join(" ")
    .toLowerCase();

/**
 * Filter, then order ROM-extension entries first. A source can expose hundreds
 * of entries and the one the user wants is almost always a ROM; an unfiltered,
 * unordered list made them scroll for it. Every row is ranked by its own name,
 * so a non-ROM-named row (selectable or not) sorts below the ROM-named block in
 * source order.
 */
const prepareSelectionItems = (items: SelectionItem[], query: string): SelectionItem[] => {
  const needle = query.trim().toLowerCase();
  const matched = needle ? items.filter((item) => getSearchText(item).includes(needle)) : items;
  // Stable: Array.prototype.sort is required to be stable, so equal ranks keep
  // the source order the caller chose.
  return matched
    .map((item, index) => ({ index, item }))
    .sort((left, right) => {
      const rank = (entry: SelectionItem) => (typeof entry.name === "string" && isRomFileName(entry.name) ? 0 : 1);
      return rank(left.item) - rank(right.item) || left.index - right.index;
    })
    .map((entry) => entry.item);
};

/** The picker's filter box. Hidden for short lists, where it is only clutter. */
const SelectionFilter = ({
  matchCount,
  onChange,
  totalCount,
  value,
}: {
  matchCount: number;
  onChange: (value: string) => void;
  totalCount: number;
  value: string;
}) => (
  <div className="pick-filter">
    <input
      aria-label="Filter files"
      className="pick-filter-input"
      onChange={(event) => onChange(event.target.value)}
      placeholder="Filter files"
      type="search"
      value={value}
    />
    <span aria-live="polite" className="pick-filter-count mono">
      {matchCount} of {totalCount}
    </span>
  </div>
);

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

const SelectionTree = ({ items, onSelect }: { items: SelectionItem[]; onSelect: (id: string) => void }) => {
  const [query, setQuery] = useState("");
  const visibleItems = useMemo(() => prepareSelectionItems(items, query), [items, query]);
  const filterable = items.length > 8;
  return (
    <>
      {filterable ? (
        <SelectionFilter matchCount={visibleItems.length} onChange={setQuery} totalCount={items.length} value={query} />
      ) : null}
      {/* Selectable entries are real buttons (native keyboard + focus); the rest
          are inert dimmed rows. */}
      <div className={join("seltree", "picklist", visibleItems.length > VIRTUALIZE_ROW_THRESHOLD && "long")}>
        {visibleItems.length === 0 ? <p className="pick-empty">No files match “{query}”</p> : null}
        {visibleItems.map((item) =>
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
    </>
  );
};

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
  const [query, setQuery] = useState("");
  const selectableItems = items.filter((item) => item.selectable);
  const selectableIds = selectableItems.map((item) => item.id);
  const defaultIds = selectableItems.filter((item) => item.defaultSelected).map((item) => item.id);
  const initialSelectedIds = defaultIds;
  // `items` is a fresh array on every parent render, and the hosting form re-renders on every
  // background progress tick, so keying the reset on identity wiped the user's unchecks the instant
  // anything else moved. The candidate set's CONTENT is what decides whether this is a new picker.
  const candidateKey = selectableItems.map((item) => `${item.defaultSelected ? "*" : ""}${item.id}`).join("|");
  const [selection, setSelection] = useState({ ids: initialSelectedIds, key: candidateKey });
  // Documented React "adjust state when props change" pattern: re-seed during render (not in an
  // effect) so a genuinely new candidate set never paints one frame with the old selection.
  if (selection.key !== candidateKey) setSelection({ ids: initialSelectedIds, key: candidateKey });
  const selectedIds = selection.key === candidateKey ? selection.ids : initialSelectedIds;
  const setSelectedIds = (ids: string[]) => setSelection({ ids, key: candidateKey });
  const toggle = (id: string) =>
    setSelectedIds(selectedIds.includes(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id]);
  // Filtering only changes what is DRAWN for individual ticks - a row ticked and
  // then filtered out is still submitted. Select all/Clear all, though, scopes
  // to the filtered rows while a filter is active, so it can never silently tick
  // hundreds of hidden entries.
  const visibleItems = useMemo(() => prepareSelectionItems(items, query), [items, query]);
  const scopeIds = query ? visibleItems.filter((item) => item.selectable).map((item) => item.id) : selectableIds;
  const allSelected = scopeIds.length > 0 && scopeIds.every((id) => selectedIds.includes(id));
  const toggleAll = () =>
    setSelectedIds(
      allSelected
        ? selectedIds.filter((id) => !scopeIds.includes(id))
        : [...selectedIds, ...scopeIds.filter((id) => !selectedIds.includes(id))],
    );
  return (
    <div className="selcheckwrap">
      {items.length > 8 ? (
        <SelectionFilter matchCount={visibleItems.length} onChange={setQuery} totalCount={items.length} value={query} />
      ) : null}
      <div className={join("seltree", "picklist", visibleItems.length > VIRTUALIZE_ROW_THRESHOLD && "long")}>
        {visibleItems.length === 0 ? <p className="pick-empty">No files match “{query}”</p> : null}
        {visibleItems.map((item) =>
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
