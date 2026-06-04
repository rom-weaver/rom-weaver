import Check from "lucide-react/dist/esm/icons/check.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import X from "lucide-react/dist/esm/icons/x.js";
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

  const markCopied = () => {
    setCopied(true);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  // Fallback for non-secure contexts (e.g. a self-signed LAN cert on iOS) where
  // navigator.clipboard is unavailable — selection + execCommand still copies there.
  const legacyCopy = (value: string): boolean => {
    if (typeof document === "undefined") return false;
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText = "position:fixed;top:-1000px;left:0;opacity:0;";
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(textarea);
    return ok;
  };

  const copy = () => {
    if (!text) return;
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard?.writeText) {
      clipboard.writeText(text).then(markCopied, () => {
        if (legacyCopy(text)) markCopied();
        else logger.trace("Checksum copy failed");
      });
      return;
    }
    if (legacyCopy(text)) markCopied();
    else logger.trace("Clipboard unavailable; skipping checksum copy");
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
}) => {
  const controlledOpen = open ?? defaultOpen;
  const hasSummaryMeta = !!(timing || match);
  return (
    <details
      className="cks"
      // `toggle` fires whenever the `open` attribute changes — including when React
      // re-asserts the controlled value. Only forward genuine changes so a controlled
      // `open` + state-toggling handler can't feed back into an open/close oscillation.
      onToggle={
        onToggle
          ? (event) => {
              if (event.currentTarget.open !== controlledOpen) onToggle(event.currentTarget.open);
            }
          : undefined
      }
      open={controlledOpen}
    >
      <summary className="cks-summary">
        <ChevronRight aria-hidden="true" className="chev" />
        <span className="lab">{label}</span>
        {sublabel ? <span className="sublab">{sublabel}</span> : null}
        {hasSummaryMeta ? (
          <span className="tm">
            {timing ? <span className="t">{timing}</span> : null}
            {match ? (
              <span
                className={join("cks-match", !match.ok && "bad")}
                title={match.ok ? "Verified" : "Verification failed"}
              >
                {match.ok ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
                {match.label ? <span>{match.label}</span> : null}
              </span>
            ) : null}
          </span>
        ) : null}
      </summary>
      {lead}
      <div className="cks-rows">{children}</div>
    </details>
  );
};

export { ChecksumList, ChecksumRow };
