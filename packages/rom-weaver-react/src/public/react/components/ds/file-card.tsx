import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import type { CSSProperties, ReactNode, Ref } from "react";

/**
 * Resolved-file card for every workflow's input rows. The left gutter rail
 * carries identity: a static index badge for ROM inputs, or a drag handle
 * (supplied as `handle`) for reorderable patches. The right gutter rail carries
 * the remove button. Both rails sit in the negative section padding so they cost
 * no content width. The name area and collapsible sections (extraction tree,
 * checksums, fixes) are supplied as children.
 */

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

type FileState = "ok" | "bad";

/** Clear/remove button pinned to the card's right gutter rail. */
const RemoveButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button aria-label={label} className="rm" onClick={onClick} title={label} type="button">
    <Trash2 aria-hidden="true" />
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
  patch = false,
  handle,
  rootRef,
  className,
  style,
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
  /** Mark this as a patch row (adjusts gutter-rail extents). */
  patch?: boolean;
  /** Left-rail drag handle for reorderable rows; takes precedence over the index badge. */
  handle?: ReactNode;
  rootRef?: Ref<HTMLDivElement>;
  className?: string;
  style?: CSSProperties;
  name: ReactNode;
  target?: ReactNode;
  children?: ReactNode;
}) => (
  <div className={join("file", state, inputMatch && "im", patch && "patch", className)} ref={rootRef} style={style}>
    {hideName ? null : (
      <div className="file-name">
        {handle ?? (typeof index === "number" ? <span className="fidx">{index}</span> : null)}
        {name}
        {target}
      </div>
    )}
    {onRemove ? <RemoveButton label={removeLabel} onClick={onRemove} /> : null}
    {children}
  </div>
);

export { FileCard, type FileState, FileTargetPill, RemoveButton };
