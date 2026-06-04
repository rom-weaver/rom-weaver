import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.js";
import X from "lucide-react/dist/esm/icons/x.js";
import type { ReactNode } from "react";

/**
 * Resolved-file card for every workflow's input rows: ROM/original/modified
 * (index badge + clear button) and patches (reorder controls + remove + target
 * pill). The name area and collapsible sections (extraction tree, checksums,
 * fixes) are supplied as children.
 */

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

type FileState = "ok" | "bad";

type PatchReorderProps = {
  index: number;
  total: number;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
};

const PatchReorder = ({ index, total, onUp, onDown, onRemove }: PatchReorderProps) => {
  const title = `Patch ${index + 1} of ${total} — applied in order`;
  const up = (
    <button aria-label="Move patch up" className="po-btn po-up" disabled={index === 0} onClick={onUp} type="button">
      <ChevronUp aria-hidden="true" />
    </button>
  );
  const down = (
    <button
      aria-label="Move patch down"
      className="po-btn po-down"
      disabled={index === total - 1}
      onClick={onDown}
      type="button"
    >
      <ChevronDown aria-hidden="true" />
    </button>
  );
  return (
    <>
      <div className="preorder">
        {up}
        <span className="po-num" title={title}>
          {index + 1}
        </span>
        {down}
      </div>
      <div className="preorder po-right">
        {up}
        <button aria-label="Remove patch" className="po-mid po-x rm" onClick={onRemove} type="button">
          <X aria-hidden="true" />
        </button>
        {down}
      </div>
    </>
  );
};

/** Clear/remove button pinned to the card's right gutter (non-patch cards). */
const RemoveButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button aria-label={label} className="rm" onClick={onClick} title={label} type="button">
    <X aria-hidden="true" />
  </button>
);

/** "Apply patch to" target selector pill shown beneath a patch's name. */
const FileTargetPill = ({ label, bad, onClick }: { label: ReactNode; bad?: boolean; onClick?: () => void }) => (
  <div className={join("ptgt-row", bad && "bad")}>
    <button
      aria-label="Apply patch to"
      className={join("ptgt-sel", bad && "bad")}
      disabled={!onClick}
      onClick={onClick}
      type="button"
    >
      <span className="ptgt-name">{label}</span>
      <ChevronDown aria-hidden="true" className="ptgt-chev" />
    </button>
  </div>
);

const FileCard = ({
  state,
  inputMatch,
  index,
  hideName = false,
  onRemove,
  removeLabel = "Remove",
  patch,
  name,
  target,
  children,
}: {
  state?: FileState;
  inputMatch?: boolean;
  index?: number;
  hideName?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
  patch?: PatchReorderProps;
  name: ReactNode;
  target?: ReactNode;
  children?: ReactNode;
}) => (
  <div className={join("file", state, inputMatch && "im", patch && "patch")}>
    {hideName ? null : (
      <div className="file-name">
        {patch ? <PatchReorder {...patch} /> : typeof index === "number" ? <span className="fidx">{index}</span> : null}
        {name}
        {target}
      </div>
    )}
    {!patch && onRemove ? <RemoveButton label={removeLabel} onClick={onRemove} /> : null}
    {children}
  </div>
);

export { FileCard, type FileState, FileTargetPill, RemoveButton };
