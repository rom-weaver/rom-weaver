import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import type { ReactNode } from "react";

/**
 * Output section: the filename field grouped with a format selector, an
 * optional collapsible "Compress" panel (codec/level/archive overrides), and a
 * caller-supplied action (run button or inline progress). Shared by apply,
 * create, and trim outputs.
 */

type FormatOption = { value: string; label: string };
const HEADER_SUMMARY_SEPARATOR = " · ";

/** One labeled control row inside the Compress panel. */
const OutputField = ({ label, children }: { label: ReactNode; children: ReactNode }) => (
  <div className="ofield">
    <span className="ofld-lbl">{label}</span>
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
}: {
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
  compress?: {
    summary?: ReactNode;
    timing?: ReactNode;
    children: ReactNode;
    format?: string;
    formatValue?: string;
    formatOptions?: FormatOption[];
    formatLabel?: string;
    formatId?: string;
    onFormatChange?: (value: string) => void;
  } | null;
  disabled?: boolean;
  action?: ReactNode;
}) => (
  <div className="outcard">
    <div className="fname-group">
      <textarea
        aria-label={fileNameLabel}
        className="input mono"
        disabled={disabled}
        id={fileNameId}
        onChange={(event) => onFileNameChange(event.currentTarget.value)}
        placeholder={fileNamePlaceholder}
        rows={1}
        spellCheck={false}
        value={fileName}
      />
      <span className="sep" />
      <select
        aria-label={formatLabel}
        className="select"
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
    {compress ? (
      <details className="outopts">
        <summary>
          <ChevronRight aria-hidden="true" className="chev" />
          <span className="lab">Compress</span>
          {compress.format ? <span className="sumv">{compress.format}</span> : null}
          {compress.format && compress.summary ? <span className="sumv">·</span> : null}
          {compress.summary ? (
            <span className="sumv">
              {typeof compress.summary === "string"
                ? compress.summary.replaceAll(" · ", HEADER_SUMMARY_SEPARATOR)
                : compress.summary}
            </span>
          ) : null}
          {compress.timing ? (
            <span className="tm">
              <span className="t">{compress.timing}</span>
            </span>
          ) : null}
        </summary>
        <div className="outopts-body">
          {compress.formatOptions?.length && compress.onFormatChange ? (
            <OutputField label={compress.formatLabel || "Type"}>
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
      </details>
    ) : null}
    {action}
  </div>
);

export { type FormatOption, OutputCard, OutputField };
