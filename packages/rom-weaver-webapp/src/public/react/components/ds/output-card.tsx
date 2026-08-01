import { SlidersHorizontal, TriangleAlert } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { detectOutputLikeExtension } from "../../../../lib/output/output-name-validation.ts";
import { join } from "./cx.ts";
import { Drawer, DrawerReadout } from "./drawer.tsx";

/**
 * Output section: the filename field grouped with a format selector, an
 * optional collapsible "Options" drawer (codec/level/archive overrides), and a
 * caller-supplied action (run button or inline progress). Shared by apply,
 * create, and trim outputs.
 */

type FormatOption = { value: string; label: string };
type OutputCompressPanel = {
  summary?: ComponentChildren;
  /** Extra readout chips for the drawer header, beside the format/summary chips. */
  readouts?: ComponentChildren;
  timing?: ComponentChildren;
  children: ComponentChildren;
  format?: string;
  formatValue?: string;
  formatOptions?: FormatOption[];
  formatLabel?: string;
  formatInfo?: ComponentChildren;
  formatId?: string;
  onFormatChange?: (value: string) => void;
};
type OutputCardProps = {
  fileName: string;
  onFileNameChange: (value: string) => void;
  fileNamePlaceholder?: string;
  fileNameLabel?: string;
  fileNameId?: string;
  format: string;
  formatOptions: FormatOption[];
  onFormatChange: (value: string) => void;
  formatLabel?: string;
  formatId?: string;
  compress?: OutputCompressPanel | null;
  disabled?: boolean;
  action?: ComponentChildren;
};

/** One labeled control field inside the output options grid. */
const OutputField = ({
  label,
  labelInfo,
  className,
  children,
}: {
  label: ComponentChildren;
  labelInfo?: ComponentChildren;
  className?: string;
  children: ComponentChildren;
}) => (
  <div className={join("ofld ofield", className)}>
    <span className="ofld-l ofld-lbl">
      <span className="ofld-text">{label}</span>
      {labelInfo}
    </span>
    {children}
  </div>
);

const OutputCard = ({
  fileName,
  onFileNameChange,
  fileNamePlaceholder,
  fileNameLabel = "Output filename",
  fileNameId,
  format,
  formatOptions,
  onFormatChange,
  formatLabel = "Output format",
  formatId,
  compress,
  disabled,
  action,
}: OutputCardProps) => {
  // The format selector appends the extension, so a name that already ends in
  // an output-looking extension would be saved doubled (`game.zip.zip`).
  const doubledExtension = detectOutputLikeExtension(fileName);
  return (
    <div className="card outcard">
      {doubledExtension ? (
        <p aria-live="polite" className="patch-off-note outname-ext-warn" role="alert">
          <TriangleAlert aria-hidden="true" />
          <span>
            The name ends in <code>.{doubledExtension}</code>, an output extension. The format selector adds the
            extension — remove it to avoid a doubled name.
          </span>
        </p>
      ) : null}
      <div className="outbar">
        <div className="fname fname-group">
          <textarea
            aria-label={fileNameLabel}
            className="input mono outname"
            disabled={disabled}
            id={fileNameId}
            onInput={(event) => onFileNameChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              // The output name is a textarea only so it can grow - a filename
              // must never contain a newline.
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder={fileNamePlaceholder}
            rows={1}
            spellcheck={false}
            value={fileName}
          />
          <span className="sep" />
          <select
            aria-label={formatLabel}
            className="select mono"
            disabled={disabled}
            id={formatId}
            onChange={(event) => onFormatChange(event.currentTarget.value)}
            value={format}
          >
            {formatOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {compress ? (
        <Drawer
          bodyClassName="optsbody"
          className="optsblock outopts"
          label="Options"
          labelIcon={<SlidersHorizontal aria-hidden="true" className="tune" />}
          readouts={
            <>
              {compress.format ? <DrawerReadout>{compress.format}</DrawerReadout> : null}
              {compress.summary ? <DrawerReadout>{compress.summary}</DrawerReadout> : null}
              {compress.readouts}
              {compress.timing ? <DrawerReadout time>{compress.timing}</DrawerReadout> : null}
            </>
          }
        >
          <div className="optsgrid">
            {compress.formatOptions?.length && compress.onFormatChange ? (
              <OutputField label={compress.formatLabel || "Type"} labelInfo={compress.formatInfo}>
                <select
                  aria-label={compress.formatLabel || "Type"}
                  className="select"
                  disabled={disabled}
                  id={compress.formatId}
                  onChange={(event) => compress.onFormatChange?.(event.currentTarget.value)}
                  value={compress.formatValue || ""}
                >
                  {compress.formatOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </OutputField>
            ) : null}
            {compress.children}
          </div>
        </Drawer>
      ) : null}
      {action}
    </div>
  );
};

export { type FormatOption, OutputCard, type OutputCardProps, type OutputCompressPanel, OutputField };
