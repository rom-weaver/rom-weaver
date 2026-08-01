import { Check, Copy, ListChecks, X } from "lucide-preact";
import { Fragment, type ComponentChildren } from "preact";
import { join } from "./cx.ts";
import { Drawer, DrawerMark, DrawerReadout } from "./drawer.tsx";
import { useClipboardCopy } from "./use-clipboard-copy.ts";

/**
 * Checksum drawer + rows in the loom readout language. The whole row IS the
 * copy control (role=button), with the copy glyph as decoration - no nested
 * interactive elements. Shared by ROM inputs, patch info, and create-output
 * verification so the copy behaviour lives in one place.
 */

/* Values at least this long (md5, sha1) get the ck-fit marker: on narrow row
   lists the stylesheet hands them the full row width so the hash holds ONE
   line at the table's unified value size instead of wrapping. */
const FIT_VALUE_MIN_CHARS = 16;

/* The two short rows (crc32 + byte count) carry the ck-half marker so wide
   drawers can pair them onto one grid row; the two long hashes (md5 + sha-1)
   carry ck-hash, which only pairs once the drawer is wide enough for a
   40-character value to stay legible at half width. Every other label keeps the
   full row. Derived from the label so real and pending rows agree. */
const pairMarkerClass = (label: ComponentChildren): string | false => {
  if (label === "CRC32" || label === "BYTES") return "ck-half";
  if (label === "MD5" || label === "SHA-1") return "ck-hash";
  return false;
};

/** A single label/value checksum row. Click (or Enter/Space) copies `copyValue`.
 * `mark` renders a per-row verified/mismatch verdict (expected-vs-computed rows). */
const ChecksumRow = ({
  label,
  value,
  copyValue,
  bad,
  mark,
}: {
  label: ComponentChildren;
  value: ComponentChildren;
  copyValue?: string;
  bad?: boolean;
  mark?: "bad" | "ok";
}) => {
  const text = copyValue ?? (typeof value === "string" ? value : "");
  const { copied, copy } = useClipboardCopy(text);
  const fit = typeof value === "string" && value.length >= FIT_VALUE_MIN_CHARS;

  return (
    <button
      aria-label={`Copy ${typeof label === "string" ? label : "value"}`}
      className={join("ck mono", (bad || mark === "bad") && "bad", pairMarkerClass(label))}
      onClick={copy}
      type="button"
    >
      <span className="ck-k">{label}</span>
      <span className={join("ck-v", fit && "ck-fit", copied && "copied")}>{value}</span>
      {mark ? (
        <span className={join("ck-mark", mark)} title={mark === "ok" ? "Matches the ROM" : "Does not match the ROM"}>
          {mark === "ok" ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
          <span className="sr-only">{mark === "ok" ? "matches" : "mismatch"}</span>
        </span>
      ) : null}
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
const PendingChecksumRow = ({ label, length }: { label: ComponentChildren; length: number }) => (
  <div className={join("ck mono pending", pairMarkerClass(label))}>
    <span className="ck-k">{label}</span>
    <span className={join("ck-v", length >= FIT_VALUE_MIN_CHARS && "ck-fit")}>
      <span className="pend">{"0".repeat(Math.max(1, length))}</span>
    </span>
    <span aria-hidden="true" className="copy">
      <Copy aria-hidden="true" />
    </span>
  </div>
);

/** Collapsible container for checksum rows with a summary label, timing, and optional verdict. */
const ChecksumList = ({
  action,
  label,
  timing,
  match,
  verifying,
  sublabel,
  defaultOpen,
  open,
  onToggle,
  lead,
  bodyClassName,
  children,
}: {
  action?: ComponentChildren;
  label: ComponentChildren;
  timing?: ComponentChildren;
  match?: { ok: boolean; label: ComponentChildren };
  /** A deferred verification is still running: show a subtle "Verifying…" readout in place of the
   * verdict chip (the card's verify-bar carries the motion; the body stays fully visible). */
  verifying?: boolean;
  sublabel?: ComponentChildren;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  lead?: ComponentChildren;
  bodyClassName?: string;
  children: ComponentChildren;
}) => (
  <Drawer
    action={action}
    bodyClassName={bodyClassName}
    defaultOpen={defaultOpen}
    label={label}
    labelIcon={<ListChecks aria-hidden="true" />}
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
type ChecksumPendingGroup = {
  id: string;
  label?: ComponentChildren;
  /** A group whose values are already known while the file stages (a bundle's "Expected" checks
   * come from the bundle, not the hash), rendered as-is in place of shimmer rows. */
  content?: ComponentChildren;
  rows?: Array<{ id?: string; label: ComponentChildren; length: number }>;
};

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
  label?: ComponentChildren;
  groupClassName?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}) => (
  <ChecksumList defaultOpen={defaultOpen} label={label} onToggle={onToggle} open={open}>
    {groups.map((group) => {
      if (group.content) return <Fragment key={group.id}>{group.content}</Fragment>;
      const rows = (group.rows || []).map((row) => (
        <PendingChecksumRow
          key={`${group.id}:${row.id ?? `${typeof row.label === "string" ? row.label : "row"}:${row.length}`}`}
          label={row.label}
          length={row.length}
        />
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

export { ChecksumList, type ChecksumPendingGroup, ChecksumRow, FIT_VALUE_MIN_CHARS, PendingChecks };
