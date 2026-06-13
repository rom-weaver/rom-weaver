import Check from "lucide-react/dist/esm/icons/check.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import { Drawer, DrawerReadout } from "./drawer.tsx";
import { useClipboardCopy } from "./use-clipboard-copy.ts";

/**
 * Read-only collapsible section showing the CUE/GDI sheet that describes a
 * bin/track ROM, rendered as the loom code block: a title bar with the copy
 * button over a monospace listing on a recessed surface. The cue is never
 * patched or checksummed, so it rides alongside each bin row rather than
 * appearing as its own input.
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
    <Drawer
      className="cue rw-cue-section"
      defaultOpen={defaultOpen}
      label={label}
      readouts={<DrawerReadout muted>{sublabel ?? getCueSublabel(cueText)}</DrawerReadout>}
    >
      <div className="cue-sub">
        <div className="cue-sub-head">
          <span className="cue-sub-lab">{label}</span>
          <button
            aria-label={`Copy ${label} sheet`}
            className={join("copy cue-copy rw-cue-copy", copied && "copied")}
            onClick={copy}
            title={`Copy ${label}`}
            type="button"
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </button>
        </div>
        <pre className="cue-text mono">{cueText}</pre>
      </div>
    </Drawer>
  );
};

export { CuePanel };
