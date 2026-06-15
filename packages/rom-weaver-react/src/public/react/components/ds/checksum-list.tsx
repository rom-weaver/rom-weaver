import Check from "lucide-react/dist/esm/icons/check.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import X from "lucide-react/dist/esm/icons/x.js";
import type { ReactNode } from "react";
import { join } from "./cx.ts";
import { Drawer, DrawerMark, DrawerReadout } from "./drawer.tsx";
import { useClipboardCopy } from "./use-clipboard-copy.ts";

/**
 * Checksum drawer + rows in the loom readout language. The whole row IS the
 * copy control (role=button), with the copy glyph as decoration — no nested
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

/** Collapsible container for checksum rows with a summary label, timing, and optional verdict. */
const ChecksumList = ({
  label,
  timing,
  match,
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
      sublabel || timing || match ? (
        <>
          {sublabel ? <DrawerReadout muted>{sublabel}</DrawerReadout> : null}
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
      ) : undefined
    }
  >
    {lead}
    {children}
  </Drawer>
);

export { ChecksumList, ChecksumRow };
