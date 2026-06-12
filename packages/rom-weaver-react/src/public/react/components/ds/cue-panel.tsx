import Check from "lucide-react/dist/esm/icons/check.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import { useClipboardCopy } from "./use-clipboard-copy.ts";

/**
 * Read-only collapsible section showing the CUE sheet that describes a bin/track
 * ROM. The cue is never patched or checksummed, so it rides alongside each bin
 * row rather than appearing as its own input. A copy button lifts the full sheet
 * to the clipboard.
 */

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

const CUE_FILE_ENTRY_REGEX = /^\s*FILE\s+"([^"]+)"/im;

const getCueSublabel = (cueText: string): string => CUE_FILE_ENTRY_REGEX.exec(cueText)?.[1] || "cue sheet";

const CuePanel = ({
  cueText,
  defaultOpen,
  label = "CUE",
  sublabel,
}: {
  cueText: string;
  defaultOpen?: boolean;
  label?: string;
  sublabel?: string;
}) => {
  const { copied, copy } = useClipboardCopy(cueText);
  if (!cueText) return null;
  return (
    <details className="cks cue rw-cue-section" open={defaultOpen}>
      <summary className="cks-summary">
        <ChevronRight aria-hidden="true" className="chev" />
        <span className="lab">{label}</span>
        <span className="sublab">{sublabel ?? getCueSublabel(cueText)}</span>
        <button
          aria-label={`Copy ${label} sheet`}
          className={join("copy", "rw-cue-copy", copied && "copied")}
          onClick={(event) => {
            // Keep the click from toggling the surrounding <details>.
            event.preventDefault();
            event.stopPropagation();
            copy();
          }}
          title={`Copy ${label}`}
          type="button"
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </summary>
      <pre className="cue-text">{cueText}</pre>
    </details>
  );
};

export { CuePanel };
