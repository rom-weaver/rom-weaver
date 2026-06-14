import type { ReactNode } from "react";
import { stripCompressionCodecLevelOverrides } from "../../../../lib/compression/codec-fields.ts";
import { InfoToggle } from "../../../../presentation/react/info-toggle.tsx";
import { type CompressField, type CompressFieldInfo, OUTPUT_FORMAT_INFO } from "../../compress-options.ts";
import { CodecCombobox } from "./codec-combobox.tsx";
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
            <select
              aria-label={field.label}
              className="select"
              disabled={disabled}
              onChange={(event) => handleChange(field, event.currentTarget.value)}
              value={field.value}
            >
              {field.options.map((option) => (
                <option disabled={option.disabled} key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
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
  fields?: CompressField[] | null;
  format?: string;
  formatId?: string;
  formatInfo?: CompressFieldInfo | null;
  formatLabel?: string;
  formatOptions?: FormatOption[];
  formatValue?: string;
  onFieldChange?: (key: string, value: string, updates?: Record<string, string>) => void;
  onFormatChange?: (value: string) => void;
  summary?: ReactNode;
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

const buildOutputCompressionPanel = ({
  disabled,
  fields,
  format,
  formatId,
  formatInfo = OUTPUT_FORMAT_INFO,
  formatLabel = "Type",
  formatOptions,
  formatValue,
  onFieldChange,
  onFormatChange,
  summary,
  timing,
}: OutputCompressionPanelConfig): OutputCompressPanel => ({
  children:
    fields?.length && onFieldChange ? (
      <CompressPanelBody disabled={disabled} fields={fields} onChange={onFieldChange} />
    ) : null,
  format,
  formatId,
  formatInfo:
    formatOptions?.length && onFormatChange ? (
      <FieldInfoToggle info={formatInfo ?? undefined} label={formatLabel} />
    ) : undefined,
  formatLabel,
  formatOptions,
  formatValue,
  onFormatChange,
  summary,
  timing,
});

export { buildOutputCompressionPanel, CompressInfoContent, CompressPanelBody, getOutputCompressionFormatLabel };
