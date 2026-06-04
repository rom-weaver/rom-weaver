import type { CompressField } from "../../compress-options.ts";
import { OutputField } from "./output-card.tsx";

/**
 * Body of the output "Compress" collapsible: one labeled control per compression
 * field. Edits are forwarded as per-job overrides via `onChange(settingsKey,
 * value)`. Shared by the apply, create, and trim outputs.
 */
const CompressPanelBody = ({
  fields,
  onChange,
  disabled,
}: {
  fields: CompressField[];
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) => (
  <>
    {fields.map((field) =>
      field.kind === "select" ? (
        <OutputField key={field.key} label={field.label}>
          <select
            aria-label={field.label}
            className="select"
            disabled={disabled}
            onChange={(event) => onChange(field.key, event.currentTarget.value)}
            value={field.value}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </OutputField>
      ) : (
        <OutputField key={field.key} label={field.label}>
          <input
            aria-label={field.label}
            className={field.mono ? "input mono" : "input"}
            disabled={disabled}
            onChange={(event) => onChange(field.key, event.currentTarget.value)}
            placeholder={field.placeholder}
            value={field.value}
          />
        </OutputField>
      ),
    )}
  </>
);

export { CompressPanelBody };
