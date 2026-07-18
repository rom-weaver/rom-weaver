import Check from "lucide-react/dist/esm/icons/check.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import Disc3 from "lucide-react/dist/esm/icons/disc-3.js";
import { join } from "./cx.ts";
import { Drawer } from "./drawer.tsx";
import { useClipboardCopy } from "./use-clipboard-copy.ts";

/**
 * Read-only collapsible section showing the CUE/GDI sheet(s) that describe a
 * bin/track ROM, rendered as the loom code block with a copy button over a
 * monospace listing on a recessed surface. The sheets are never
 * patched or checksummed, so they ride alongside the ROM rather than appearing
 * as their own input.
 */

/** A single sheet's copy control over the listing. When
 * a disc carries both a cue and a gdi, each renders as one of these sub-blocks
 * inside the shared sheets drawer, so the label is shown to tell them apart. */
const SheetBlock = ({ label, showLabel, text }: { label: string; showLabel: boolean; text: string }) => {
  const { copied, copy } = useClipboardCopy(text);
  const copyButton = (
    <button
      aria-label={`Copy ${label} sheet`}
      className={join("copy cue-copy rw-cue-copy", copied && "copied")}
      onClick={copy}
      title={`Copy ${label}`}
      type="button"
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  );
  return (
    <div className={join("cue-sub", !showLabel && "cue-sub-single")}>
      {showLabel ? (
        <div className="cue-sub-head">
          <span className="cue-sub-lab">{label}</span>
          {copyButton}
        </div>
      ) : (
        copyButton
      )}
      <pre className="cue-text mono">{text}</pre>
    </div>
  );
};

type DiscSheet = { label: string; text: string };

/**
 * The disc index section: a `.cue` sheet for CDs and/or a `.gdi` index for
 * GD-ROMs. When both are present they share one drawer ("CUE / GDI") split into
 * two labelled sub-blocks, each with its own copy button.
 */
const DiscSheetsPanel = ({
  cueText,
  defaultOpen,
  gdiText,
}: {
  cueText?: string;
  defaultOpen?: boolean;
  gdiText?: string;
}) => {
  const sheets: DiscSheet[] = [
    ...(cueText ? [{ label: "CUE", text: cueText }] : []),
    ...(gdiText ? [{ label: "GDI", text: gdiText }] : []),
  ];
  const first = sheets[0];
  if (!first) return null;
  const both = sheets.length > 1;
  const label = both ? "CUE / GDI" : first.label;
  return (
    <Drawer
      className="cue rw-cue-section"
      defaultOpen={defaultOpen}
      label={label}
      labelIcon={<Disc3 aria-hidden="true" />}
    >
      {sheets.map((sheet) => (
        <SheetBlock key={sheet.label} label={sheet.label} showLabel={both} text={sheet.text} />
      ))}
    </Drawer>
  );
};

export { DiscSheetsPanel };
