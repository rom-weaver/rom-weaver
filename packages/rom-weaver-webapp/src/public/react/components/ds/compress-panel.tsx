import type { ReactNode } from "react";
import { stripCompressionCodecLevelOverrides } from "../../../../lib/compression/codec-fields.ts";
import { InfoToggle } from "../../../../presentation/react/info-toggle.tsx";
import { type CompressField, type CompressFieldInfo, OUTPUT_FORMAT_INFO } from "../../compress-options.ts";
import { CodecCombobox } from "./codec-combobox.tsx";
import { DrawerReadout } from "./drawer.tsx";
import { DropdownSelect } from "./dropdown-select.tsx";
import { type FormatOption, type OutputCompressPanel, OutputField } from "./output-card.tsx";

/**
 * Body of the output "Options" collapsible: one labeled control per compression
 * field. Edits are forwarded as per-job overrides via `onChange(settingsKey,
 * value)`. Shared by the apply, create, and trim outputs.
 */

const CompressInfoContent = ({ info }: { info: CompressFieldInfo }) => (
  <>
    <strong>{info.title}</strong>
    {info.summary ? <p className="info-copy">{info.summary}</p> : null}
    {info.items?.length ? (
      <ul className="info-list">
        {info.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    ) : null}
    {info.levelMap?.length ? (
      <table className="info-level-map">
        <thead>
          <tr>
            <th>Profile</th>
            <th>Standard</th>
            <th>zstd</th>
          </tr>
        </thead>
        <tbody>
          {info.levelMap.map((row) => (
            <tr key={row.profile}>
              <td>{row.profile}</td>
              <td>{row.standard}</td>
              <td>{row.zstd}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null}
  </>
);

const FieldInfoToggle = ({ info, label }: { info?: CompressFieldInfo; label: string }) =>
  info ? (
    <InfoToggle ariaLabel={`Show ${label} details`} portalPanel title={`Show ${label} details`}>
      <CompressInfoContent info={info} />
    </InfoToggle>
  ) : null;

const CompressPanelBody = ({
  fields,
  onChange,
  disabled,
}: {
  fields: CompressField[];
  onChange: (key: string, value: string, updates?: Record<string, string>) => void;
  disabled?: boolean;
}) => {
  const handleChange = (field: CompressField, value: string) => {
    const updates: Record<string, string> = { [field.key]: value };
    if (field.kind === "select" && field.key === "compressionProfile") {
      for (const codecField of fields) {
        if (codecField.kind !== "codec") continue;
        const strippedValue = stripCompressionCodecLevelOverrides(codecField.value);
        if (strippedValue !== codecField.value) updates[codecField.key] = strippedValue;
      }
    }
    onChange(field.key, value, updates);
  };

  return (
    <>
      {fields.map((field) =>
        field.kind === "select" ? (
          <OutputField
            key={field.key}
            label={field.label}
            labelInfo={<FieldInfoToggle info={field.info} label={field.label} />}
          >
            <DropdownSelect
              aria-label={field.label}
              className="select"
              disabled={disabled}
              name={field.key}
              onChange={(event) => handleChange(field, event.currentTarget.value)}
              value={field.value}
            >
              {field.options.map((option) => (
                <option disabled={option.disabled} key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </DropdownSelect>
          </OutputField>
        ) : field.kind === "codec" ? (
          <OutputField
            key={field.key}
            label={field.label}
            labelInfo={<FieldInfoToggle info={field.info} label={field.label} />}
          >
            <CodecCombobox
              ariaLabel={field.label}
              disabled={disabled}
              inputClassName={field.mono ? "input mono" : "input"}
              label={field.label}
              multiple={field.multiple}
              onChange={(value) => handleChange(field, value)}
              options={field.options}
              placeholder={field.placeholder}
              suggestions={field.suggestions}
              value={field.value}
            />
          </OutputField>
        ) : (
          <OutputField
            key={field.key}
            label={field.label}
            labelInfo={<FieldInfoToggle info={field.info} label={field.label} />}
          >
            <input
              aria-label={field.label}
              className={field.mono ? "input mono" : "input"}
              disabled={disabled}
              name={field.key}
              onChange={(event) => handleChange(field, event.currentTarget.value)}
              placeholder={field.placeholder}
              value={field.value}
            />
          </OutputField>
        ),
      )}
    </>
  );
};

type OutputCompressionPanelConfig = {
  disabled?: boolean;
  /** Extra non-compression controls appended after the compression fields (e.g. the
   * apply output's "ROM header" select). */
  extraChildren?: ReactNode;
  fields?: CompressField[] | null;
  /** Value of the header's format chip - the short format label, not a sentence. */
  format?: string;
  formatId?: string;
  formatInfo?: CompressFieldInfo | null;
  formatLabel?: string;
  formatOptions?: FormatOption[];
  formatValue?: string;
  /** Context the format implies rather than an editable option (e.g. the CHD disc type). */
  note?: string;
  onFieldChange?: (key: string, value: string, updates?: Record<string, string>) => void;
  onFormatChange?: (value: string) => void;
  /** Extra drawer-header readout chips for non-compression options (e.g. output
   * verification status). */
  readouts?: ReactNode;
  timing?: ReactNode;
};

type CompressionFormatLabelOptions = {
  noneLabel?: string;
  uncompressedValues?: string[];
};

const getOutputCompressionFormatLabel = (
  formatValue: string,
  formatOptions: FormatOption[],
  { noneLabel = "None", uncompressedValues = ["none"] }: CompressionFormatLabelOptions = {},
) =>
  uncompressedValues.includes(formatValue)
    ? noneLabel
    : formatOptions.find((option) => option.value === formatValue)?.label;

/**
 * The collapsed header's chip row: the output format, any format-implied note,
 * then one value chip per option, the caller's extra chips, and the timing.
 * Labels stay in the markup for assistive technology. Chips are derived from
 * the same field models the drawer body renders, so a header value can never
 * drift from its control.
 */
const OutputOptionReadouts = ({
  fields,
  format,
  note,
  readouts,
  timing,
}: Pick<OutputCompressionPanelConfig, "fields" | "format" | "note" | "readouts" | "timing">) => (
  <>
    {/* The chip key stays "Type" even where the control is labelled at length
        ("Compression type"), because a chip has no room for the long form. */}
    {format ? <DrawerReadout label="Type">{format}</DrawerReadout> : null}
    {note ? <DrawerReadout muted>{note}</DrawerReadout> : null}
    {fields?.map((field) =>
      field.chip.value ? (
        <DrawerReadout key={field.key} label={field.chip.label}>
          {field.chip.value}
        </DrawerReadout>
      ) : null,
    )}
    {readouts}
    {timing ? <DrawerReadout time>{timing}</DrawerReadout> : null}
  </>
);

const buildOutputCompressionPanel = ({
  disabled,
  extraChildren,
  fields,
  format,
  formatId,
  formatInfo = OUTPUT_FORMAT_INFO,
  formatLabel = "Type",
  formatOptions,
  formatValue,
  note,
  onFieldChange,
  onFormatChange,
  readouts,
  timing,
}: OutputCompressionPanelConfig): OutputCompressPanel => ({
  children:
    fields?.length && onFieldChange ? (
      <CompressPanelBody disabled={disabled} fields={fields} onChange={onFieldChange} />
    ) : null,
  extraChildren,
  formatId,
  formatInfo:
    formatOptions?.length && onFormatChange ? (
      <FieldInfoToggle info={formatInfo ?? undefined} label={formatLabel} />
    ) : undefined,
  formatLabel,
  formatOptions,
  formatValue,
  onFormatChange,
  readouts: <OutputOptionReadouts fields={fields} format={format} note={note} readouts={readouts} timing={timing} />,
});

export {
  buildOutputCompressionPanel,
  CompressInfoContent,
  CompressPanelBody,
  FieldInfoToggle,
  getOutputCompressionFormatLabel,
};
