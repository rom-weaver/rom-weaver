import Check from "lucide-react/dist/esm/icons/check.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createLogger } from "../../../../lib/logging.ts";

/**
 * Collapsible checksum / patch-info section (prototype `.cks`). Rows copy to the
 * clipboard on click with a brief confirmation. Shared by ROM inputs, patch
 * info, and create-output verification so the copy behaviour lives in one place.
 */

const logger = createLogger("checksum-list");
const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");
const COPIED_RESET_MS = 1100;

/** A single label/value checksum row. Clicking anywhere copies `copyValue`. */
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
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const text = copyValue ?? (typeof value === "string" ? value : "");

  const copy = () => {
    if (!text) return;
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      logger.trace("Clipboard unavailable; skipping checksum copy");
      return;
    }
    clipboard.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
      },
      (error) =>
        logger.trace("Checksum copy failed", { message: error instanceof Error ? error.message : String(error || "") }),
    );
  };

  return (
    <dl className={join("ck", bad && "bad")} onClick={copy}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <button
        aria-label={`Copy ${typeof label === "string" ? label : "value"}`}
        className={join("copy", copied && "copied")}
        onClick={(event) => {
          event.stopPropagation();
          copy();
        }}
        title="Copy"
        type="button"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
    </dl>
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
  <details
    className="cks"
    onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
    open={open ?? defaultOpen}
  >
    <summary className="cks-summary">
      <ChevronRight aria-hidden="true" className="chev" />
      <span className="lab">{label}</span>
      {sublabel ? <span className="sublab">{sublabel}</span> : null}
      {match ? (
        <span className={join("cks-match", !match.ok && "bad")}>{match.label}</span>
      ) : timing ? (
        <span className="tm">
          <span className="t">{timing}</span>
        </span>
      ) : null}
    </summary>
    {lead}
    <div className="cks-rows">{children}</div>
  </details>
);

export { ChecksumList, ChecksumRow };
