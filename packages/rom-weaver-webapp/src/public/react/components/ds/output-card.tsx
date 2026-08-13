import { SlidersHorizontal, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { detectOutputLikeExtension } from "../../../../lib/output/output-name-validation.ts";
import { join } from "./cx.ts";
import { Drawer } from "./drawer.tsx";

/**
 * Output section: the filename field grouped with a format selector, an
 * optional collapsible "Options" drawer (codec/level/archive overrides), and a
 * caller-supplied action (run button or inline progress). Shared by apply,
 * create, and trim outputs.
 *
 * The drawer header carries every option as an accessible labelled chip, so the
 * values stay readable while the drawer is shut.
 */

type FormatOption = { value: string; label: string };
type OutputCompressPanel = {
  /** The full header chip row - one accessible labelled chip per option, built by `buildOutputCompressionPanel`. */
  readouts?: ReactNode;
  children: ReactNode;
  extraChildren?: ReactNode;
  formatValue?: string;
  formatOptions?: FormatOption[];
  formatLabel?: string;
  formatInfo?: ReactNode;
  formatId?: string;
  onFormatChange?: (value: string) => void;
};
type OutputCardProps = {
  fileName: string;
  onFileNameChange: (value: string) => void;
  extensionWarning?: string | null;
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
  action?: ReactNode;
};

/** One labeled control field inside the output options grid. */
const OutputField = ({
  label,
  labelInfo,
  className,
  children,
}: {
  label: ReactNode;
  labelInfo?: ReactNode;
  className?: string;
  children: ReactNode;
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
  extensionWarning,
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
  // Trim still uses the legacy name-only warning. Apply and create pass their
  // format-aware warning so valid extensions can select the matching format.
  const doubledExtension = extensionWarning === undefined ? detectOutputLikeExtension(fileName) : null;
  const compressionFields =
    compress?.formatOptions?.length && compress.onFormatChange ? (
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
    ) : null;
  return (
    <div className="card outcard">
      {extensionWarning || doubledExtension ? (
        <p aria-live="polite" className="patch-off-note outname-ext-warn" role="alert">
          <TriangleAlert aria-hidden="true" />
          <span>
            {extensionWarning || (
              <>
                The name ends in <code>.{doubledExtension}</code>, an output extension. The format selector adds the
                extension — remove it to avoid a doubled name.
              </>
            )}
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
            onChange={(event) => onFileNameChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              // The output name is a textarea only so it can grow - a filename
              // must never contain a newline.
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder={fileNamePlaceholder}
            rows={1}
            spellCheck={false}
            value={fileName}
          />
          <span className="sep" />
          <select
            aria-label={formatLabel}
            className="select mono outformat"
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
          readouts={compress.readouts}
        >
          {/* None of these controls writes back - the public form reads settings
              only. Phrased as "not saved" rather than "overrides your defaults"
              because a few options (Apply's ROM header) have no saved default at
              all. Said once at the top, since it holds for every option below. */}
          <p className="optsnote">These choices are not saved. Change your defaults in Settings.</p>
          <div className="optsgrid">
            {compressionFields || compress.children ? (
              <div className="optsgroup opts-compression-fields">
                {compressionFields}
                {compress.children}
              </div>
            ) : null}
            {compress.extraChildren ? (
              <div className="optsgroup opts-extra-fields">{compress.extraChildren}</div>
            ) : null}
          </div>
        </Drawer>
      ) : null}
      {action}
    </div>
  );
};

export { type FormatOption, OutputCard, type OutputCardProps, type OutputCompressPanel, OutputField };
