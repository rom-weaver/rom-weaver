import ListChecks from "lucide-react/dist/esm/icons/list-checks.js";
import { useState } from "react";
import {
  CHECK_FIELDS_PAIRED,
  CHECK_HEX_LENGTHS,
  CHECK_LABELS,
  type CheckAlgorithm,
  type CheckField,
  isValidCheckValue,
  normalizeCheckInput,
} from "./components/ds/check-fields.ts";
import { Drawer, DrawerReadout } from "./components/ds/drawer.tsx";

/** Bundle-checks values as typed on the ROM card in bundle-author mode. Empty
 * fields fall back to the staged ROM's computed hashes at export. */
type RomBundleChecksDraft = { crc32?: string; md5?: string; sha1?: string; bytes?: string };

/**
 * Bundle Author editor for the bundle's global ROM expectation (`rom.checks`).
 * Prefilled placeholders show the staged ROM's computed hashes - the values the
 * export uses when a field is left empty - so authors only type when the bundle
 * should expect a different base ROM than the one on the bench.
 */
const invalidFieldTitle = (field: CheckField): string =>
  field === "bytes"
    ? "Expected a whole number of bytes"
    : `Expected ${CHECK_HEX_LENGTHS[field as CheckAlgorithm]} hex characters`;

const RomBundleChecksEditor = ({
  computed,
  onChange,
  value,
}: {
  computed: RomBundleChecksDraft;
  onChange: (updates: RomBundleChecksDraft) => void;
  value: RomBundleChecksDraft;
}) => {
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>({});
  const commit = (field: CheckField, raw: string) => {
    const isBytes = field === "bytes";
    const normalized = isBytes ? raw.trim() : normalizeCheckInput(raw);
    const invalid = isBytes
      ? !!normalized && !/^\d+$/.test(normalized)
      : !!normalized && !isValidCheckValue(field as CheckAlgorithm, normalized);
    setInvalidFields((previous) => (previous[field] === invalid ? previous : { ...previous, [field]: invalid }));
    if (invalid) return;
    onChange({ [field]: normalized || undefined });
  };
  const customized = Boolean(value.crc32 || value.md5 || value.sha1 || value.bytes);
  return (
    <Drawer
      bodyClassName="optsbody"
      className="optsblock rom-bundle-checks"
      label="Bundle checks"
      labelIcon={<ListChecks aria-hidden="true" />}
      readouts={<DrawerReadout muted={!customized}>{customized ? "custom" : "auto"}</DrawerReadout>}
    >
      <div className="verification-list ck-fields-paired">
        {CHECK_FIELDS_PAIRED.map((field) => {
          const invalid = !!invalidFields[field];
          const fieldValue = value[field] || "";
          return (
            <div className="verification-row" key={field}>
              <label className="ofld-l" htmlFor={`rom-weaver-rom-bundle-${field}`}>
                {CHECK_LABELS[field]}
              </label>
              <input
                aria-invalid={invalid || undefined}
                className="input mono popt-input"
                defaultValue={fieldValue}
                id={`rom-weaver-rom-bundle-${field}`}
                key={`${field}:${fieldValue}`}
                onBlur={(event) => commit(field, event.currentTarget.value)}
                placeholder={computed[field] || ""}
                spellCheck={false}
                title={invalid ? invalidFieldTitle(field) : fieldValue || computed[field] || undefined}
                type="text"
              />
            </div>
          );
        })}
      </div>
      <p className="hintline">Empty fields export the staged ROM's computed values.</p>
    </Drawer>
  );
};

export { type RomBundleChecksDraft, RomBundleChecksEditor };
