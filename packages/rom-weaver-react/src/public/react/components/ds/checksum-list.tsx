import Check from "lucide-react/dist/esm/icons/check.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { Fragment, type ReactNode } from "react";
import { join } from "./cx.ts";
import { Drawer, DrawerMark, DrawerReadout } from "./drawer.tsx";
import { useClipboardCopy } from "./use-clipboard-copy.ts";

/**
 * Checksum drawer + rows in the loom readout language. The whole row IS the
 * copy control (role=button), with the copy glyph as decoration - no nested
 * interactive elements. Shared by ROM inputs, patch info, and create-output
 * verification so the copy behaviour lives in one place.
 */

/** A single label/value checksum row. Click (or Enter/Space) copies `copyValue`. */
const ChecksumRow = ({
  label,
  value,
  copyValue,
  bad,
}: {
  label: ReactNode;
  value: ReactNode;
  copyValue?: string;
  bad?: boolean;
}) => {
  const text = copyValue ?? (typeof value === "string" ? value : "");
  const { copied, copy } = useClipboardCopy(text);

  return (
    <button
      aria-label={`Copy ${typeof label === "string" ? label : "value"}`}
      className={join("ck mono", bad && "bad")}
      onClick={copy}
      type="button"
    >
      <span className="ck-k">{label}</span>
      <span className="ck-v">{value}</span>
      <span aria-hidden="true" className={join("copy", copied && "copied")}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </span>
    </button>
  );
};

/**
 * Staging placeholder for a {@link ChecksumRow}: the real label with a shimmering
 * bar in the value slot, sized to the eventual value's character length so the
 * row holds the exact height/width the resolved value will occupy (no layout
 * shift when the hash lands). Non-interactive.
 */
const PendingChecksumRow = ({ label, length }: { label: ReactNode; length: number }) => (
  <div className="ck mono pending">
    <span className="ck-k">{label}</span>
    <span className="ck-v">
      <span className="pend">{"0".repeat(Math.max(1, length))}</span>
    </span>
    <span aria-hidden="true" className="copy">
      <Copy aria-hidden="true" />
    </span>
  </div>
);

/** Collapsible container for checksum rows with a summary label, timing, and optional verdict. */
const ChecksumList = ({
  label,
  timing,
  match,
  verifying,
  sublabel,
  defaultOpen,
  open,
  onToggle,
  lead,
  children,
}: {
  label: ReactNode;
  timing?: ReactNode;
  match?: { ok: boolean; label: ReactNode };
  /** A deferred verification is still running: show a subtle "Verifying…" readout in place of the
   * verdict chip (the card's verify-bar carries the motion; the body stays fully visible). */
  verifying?: boolean;
  sublabel?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  lead?: ReactNode;
  children: ReactNode;
}) => (
  <Drawer
    defaultOpen={defaultOpen}
    label={label}
    onToggle={onToggle}
    open={open}
    readouts={
      sublabel || timing || match || verifying ? (
        <>
          {sublabel ? <DrawerReadout muted>{sublabel}</DrawerReadout> : null}
          {verifying ? (
            <DrawerReadout muted>Verifying…</DrawerReadout>
          ) : (
            <>
              {timing ? <DrawerReadout time>{timing}</DrawerReadout> : null}
              {match ? (
                <DrawerMark
                  className={match.ok ? "cks-match" : "cks-match bad"}
                  ok={match.ok}
                  title={match.ok ? "Verified" : "Verification failed"}
                >
                  {match.ok ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
                  {match.label ? <span className="sr-only">{match.label}</span> : null}
                </DrawerMark>
              ) : null}
            </>
          )}
        </>
      ) : undefined
    }
  >
    {lead}
    {children}
  </Drawer>
);

/**
 * The set of checksum groups + rows a still-staging file WILL produce, surfaced
 * early (from the streamed plan, or an always-present base group) so the Checks
 * drawer reserves their exact height with shimmer placeholders. A group with no
 * `label` renders its rows bare (matching a no-variant resolved layout).
 */
type ChecksumPendingGroup = { id: string; label?: ReactNode; rows: Array<{ label: ReactNode; length: number }> };

/**
 * Staging form of a Checks drawer: an open {@link ChecksumList} whose rows are
 * {@link PendingChecksumRow} shimmer placeholders for the planned groups. Shared
 * by the ROM card (variant groups) and the patch card (Input/Output sections) so
 * both reserve their resolved height the same way. `groupClassName` matches the
 * resolved group's class so heights line up exactly.
 */
const PendingChecks = ({
  groups,
  label = "Checks",
  groupClassName = "ck-group",
  defaultOpen,
  open,
  onToggle,
}: {
  groups: ChecksumPendingGroup[];
  label?: ReactNode;
  groupClassName?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}) => (
  <ChecksumList defaultOpen={defaultOpen} label={label} onToggle={onToggle} open={open}>
    {groups.map((group) => {
      const rows = group.rows.map((row, rowIndex) => (
        <PendingChecksumRow key={`${group.id}:${rowIndex}`} label={row.label} length={row.length} />
      ));
      return group.label ? (
        <div className={groupClassName} key={group.id}>
          <div className="ck-group-head">{group.label}</div>
          {rows}
        </div>
      ) : (
        <Fragment key={group.id}>{rows}</Fragment>
      );
    })}
  </ChecksumList>
);

export { ChecksumList, type ChecksumPendingGroup, ChecksumRow, PendingChecks };
