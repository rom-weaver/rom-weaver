import type { ReactNode } from "react";

/**
 * Candidate-selection tree (prototype `.seltree`). Presentational list of files
 * found inside an archive; selectable rows invoke `onSelect`, non-selectable
 * rows render dimmed with an explanatory note. Used inside the selection modal.
 */

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

type SelectionItem = {
  id: string;
  name: ReactNode;
  sizeLabel?: ReactNode;
  note?: ReactNode;
  matches?: boolean;
  selectable: boolean;
};

const SelectionRowBody = ({ item }: { item: SelectionItem }) => (
  <div className="selmain">
    <span className="fnm">{item.name}</span>
    <span className="selmeta">
      {item.matches ? <span className="matches">matches patch</span> : null}
      {item.note ? <span className="seldim">{item.note}</span> : null}
      {item.sizeLabel ? <span className="selsize">{item.sizeLabel}</span> : null}
    </span>
  </div>
);

const SelectionTree = ({ items, onSelect }: { items: SelectionItem[]; onSelect: (id: string) => void }) => (
  // Selectable entries are real buttons (native keyboard + focus); the rest are
  // inert dimmed rows.
  <div className="seltree">
    {items.map((item) =>
      item.selectable ? (
        <button className={join("selnode", "selrow")} key={item.id} onClick={() => onSelect(item.id)} type="button">
          <SelectionRowBody item={item} />
        </button>
      ) : (
        <div className={join("selnode", "selrow", "off")} key={item.id}>
          <SelectionRowBody item={item} />
        </div>
      ),
    )}
  </div>
);

export { type SelectionItem, SelectionTree };
