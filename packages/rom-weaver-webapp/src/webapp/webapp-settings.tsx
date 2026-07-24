import type { ReactNode } from "react";
import { isCompressionCodecFieldKey } from "../lib/compression/codec-fields.ts";
import { CodecCombobox } from "../public/react/components/ds/codec-combobox.tsx";
import { CompressInfoContent } from "../public/react/components/ds/compress-panel.tsx";
import { COMPRESSION_PROFILE_FIELD_INFO } from "../public/react/compress-options.ts";
import { ACCENTS } from "./accent.ts";
import { RESOLVED_APP_BUILD_VERSION } from "./build-version.ts";
import { InfoToggle } from "./components/info-toggle.tsx";
import { LICENSE_URL, NOTICE_URL } from "./project-links.ts";
import type { SettingsDraftState, SettingsFieldKey, SettingsUiState } from "./settings/settings-state.ts";
import {
  getDefaultThreads,
  getSettingsFieldDefaultValue,
  getSettingsFieldMax,
  getSettingsFieldMin,
  getSettingsFieldPlaceholder,
  getSettingsFieldSuggestion,
  getSettingsFieldSuggestionDataLocalize,
  getSettingsUiState,
  isSettingsFieldDisabled,
  SETTINGS_FIELD_ID_TO_KEY,
  SETTINGS_FIELD_METADATA,
  SETTINGS_PANEL_FIELD_ORDER,
} from "./settings/settings-state.ts";
import type { ValidationState } from "./webapp-state-types.ts";

/**
 * Settings panel rendered in the dark-pro grouped layout (`.setgroup` /
 * `.setrow` / `.setchecks` / `.srange`). All field metadata, value resolution,
 * change handling, and validation wiring are preserved from the original
 * field-driven implementation; only the surrounding markup changed.
 */

type SettingsFieldShared = {
  draftSettings: SettingsDraftState;
  uiState: SettingsUiState;
  validation: ValidationState;
  onDraftChange: (field: SettingsFieldKey, value: string | boolean) => void;
};

type SettingsPanelProps = Omit<SettingsFieldShared, "uiState"> & {
  // Derived from `draftSettings` when omitted: keeping the derivation in here is
  // what lets the panel's whole metadata graph stay off the shared entry chunk.
  uiState?: SettingsUiState;
  onClose: () => void;
  onRestoreDefaults: () => void;
  onSaveClose: () => void;
};

type FieldRenderProps = SettingsFieldShared & {
  fieldKey: SettingsFieldKey;
};

const settingsPanelSections: Array<{ fields: SettingsFieldKey[]; title: string }> = [
  {
    fields: [
      "accent",
      "language",
      "logLevel",
      "bundlePackage",
      "betaToolsEnabled",
      "fixChecksum",
      "requireInputChecksumMatch",
    ],
    title: "General",
  },
  { fields: ["defaultCompression", "compressionProfile", "threads"], title: "Compression" },
  {
    fields: ["zipCodec", "sevenZipCodec", "rvzCodec", "chdCreateCdCodecs", "chdCreateDvdCodecs"],
    title: "Codecs",
  },
  { fields: ["rvzBlockSize"], title: "RVZ" },
];

// Per-format groups render in the same single-column stack (`.setcols`); the general
// groups above them stay full-width in the grouped settings layout.
const FORMAT_GROUP_TITLES = new Set(["Codecs", "RVZ"]);

const DEFAULT_PLACEHOLDER_KINDS = new Set(["number", "text"]);
const TOGGLE_KINDS = new Set(["checkbox", "choice-checkbox"]);

const isInvalid = (validation: ValidationState, id: string) =>
  validation.invalidFields.includes(id) ? { "aria-invalid": true as const } : {};

const getDefaultValueString = (fieldKey: SettingsFieldKey): string => {
  const defaultValue = getSettingsFieldDefaultValue(fieldKey);
  return defaultValue === undefined || defaultValue === null ? "" : String(defaultValue);
};

const shouldRenderDefaultAsPlaceholder = (fieldKey: SettingsFieldKey): boolean =>
  DEFAULT_PLACEHOLDER_KINDS.has(SETTINGS_FIELD_METADATA[fieldKey].kind) && getDefaultValueString(fieldKey) !== "";

const cleanDefaultOptionLabel = (label: string): string => label.replace(/\s*\([^)]*default[^)]*\)\s*/i, "").trim();
const formatDefaultLabel = (label: string): string => `${cleanDefaultOptionLabel(label) || label} (Default)`;

const getDefaultPlaceholderValue = (fieldKey: SettingsFieldKey): string => {
  if (fieldKey === "threads") return `auto (${getDefaultThreads()})`;
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  const defaultValue = getDefaultValueString(fieldKey);
  const optionLabel = field.options?.find((option) => option.value === defaultValue)?.label;
  return formatDefaultLabel(optionLabel || defaultValue);
};

const getSelectOptionLabel = (fieldKey: SettingsFieldKey, option: { label: string; value: string }): string =>
  option.value === getDefaultValueString(fieldKey) ? formatDefaultLabel(option.label) : option.label;

const getFieldPlaceholder = (
  fieldKey: SettingsFieldKey,
  draftSettings: SettingsDraftState,
  uiState: SettingsUiState,
): string | undefined =>
  shouldRenderDefaultAsPlaceholder(fieldKey)
    ? getDefaultPlaceholderValue(fieldKey)
    : getSettingsFieldPlaceholder(fieldKey, draftSettings, uiState);

const handleSettingsEvent = (
  target: HTMLInputElement | HTMLSelectElement,
  onDraftChange: SettingsPanelProps["onDraftChange"],
) => {
  const fieldKey = SETTINGS_FIELD_ID_TO_KEY[target.id];
  if (!fieldKey) return;
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  if (field.kind === "checkbox") {
    onDraftChange(fieldKey, (target as HTMLInputElement).checked);
    return;
  }
  if (field.kind === "choice-checkbox") {
    const checked = (target as HTMLInputElement).checked;
    onDraftChange(fieldKey, checked ? field.checkedValue || "" : field.uncheckedValue || "");
    return;
  }
  if (target.value === "" && shouldRenderDefaultAsPlaceholder(fieldKey)) {
    onDraftChange(fieldKey, getDefaultValueString(fieldKey));
    return;
  }
  onDraftChange(fieldKey, target.value);
};

const getResolvedFieldValue = (fieldKey: SettingsFieldKey, draftSettings: SettingsDraftState): string => {
  const value = draftSettings[fieldKey];
  if (value === undefined || value === null) return getDefaultValueString(fieldKey);
  return String(value);
};

const getFieldValue = (fieldKey: SettingsFieldKey, draftSettings: SettingsDraftState): string => {
  const value = getResolvedFieldValue(fieldKey, draftSettings);
  return shouldRenderDefaultAsPlaceholder(fieldKey) && value === getDefaultValueString(fieldKey) ? "" : value;
};

const getCheckboxValue = (fieldKey: SettingsFieldKey, draftSettings: SettingsDraftState): boolean => {
  const value = draftSettings[fieldKey];
  if (typeof value === "boolean") return value;
  return Boolean(getSettingsFieldDefaultValue(fieldKey));
};

const getChoiceCheckboxValue = (fieldKey: SettingsFieldKey, draftSettings: SettingsDraftState): string => {
  const value = draftSettings[fieldKey];
  if (typeof value === "string") return value;
  return String(getSettingsFieldDefaultValue(fieldKey));
};

const renderFieldInfo = (fieldKey: SettingsFieldKey, draftSettings: SettingsDraftState, uiState: SettingsUiState) => {
  const suggestion = getSettingsFieldSuggestion(fieldKey, draftSettings, uiState);
  if (!suggestion) return null;
  const suggestionDataLocalize = getSettingsFieldSuggestionDataLocalize(fieldKey, draftSettings, uiState);
  const label = SETTINGS_FIELD_METADATA[fieldKey].label || fieldKey;
  const content =
    fieldKey === "compressionProfile" ? <CompressInfoContent info={COMPRESSION_PROFILE_FIELD_INFO} /> : suggestion;
  return (
    <InfoToggle ariaLabel={`Show ${label} details`} portalPanel title={`Show ${label} details`}>
      <div
        data-localize={
          fieldKey !== "compressionProfile" && typeof suggestionDataLocalize === "string"
            ? suggestionDataLocalize
            : undefined
        }
      >
        {content}
      </div>
    </InfoToggle>
  );
};

/**
 * Accent picker. A native <select> can't render its options' colours (Safari
 * ignores option styling entirely), and the colour IS the choice here - so the
 * six dye lots show as swatches, all visible at once instead of behind a popup.
 * The first radio carries the field id so the row's <label> targets it.
 */
const AccentPicker = ({ fieldKey, draftSettings, uiState, onDraftChange }: FieldRenderProps) => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  const disabled = isSettingsFieldDisabled(fieldKey, draftSettings, uiState);
  const value = getFieldValue(fieldKey, draftSettings) || getDefaultValueString(fieldKey);
  const selected = ACCENTS.find((accent) => accent.value === value);
  return (
    <span aria-label={field.label} className="accent-picker" role="radiogroup">
      {ACCENTS.map((accent, index) => (
        <label className="accent-chip" key={accent.value} title={accent.label}>
          <input
            aria-label={accent.label}
            checked={value === accent.value}
            disabled={disabled}
            id={index === 0 ? field.id : undefined}
            name={field.id}
            onChange={() => onDraftChange(fieldKey, accent.value)}
            type="radio"
            value={accent.value}
          />
          <span aria-hidden="true" className="accent-chip-dot" style={{ background: accent.swatch }} />
        </label>
      ))}
      <span className="accent-name">{selected ? getSelectOptionLabel(fieldKey, selected) : value}</span>
    </span>
  );
};

/** The control element (select / text / number input) for a non-toggle field. */
const FieldControl = ({ fieldKey, draftSettings, uiState, validation, onDraftChange }: FieldRenderProps) => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  const disabled = isSettingsFieldDisabled(fieldKey, draftSettings, uiState);
  if (fieldKey === "accent") {
    return (
      <AccentPicker
        draftSettings={draftSettings}
        fieldKey={fieldKey}
        onDraftChange={onDraftChange}
        uiState={uiState}
        validation={validation}
      />
    );
  }
  if (field.kind === "select") {
    const placeholder = getFieldPlaceholder(fieldKey, draftSettings, uiState);
    const value = getFieldValue(fieldKey, draftSettings);
    return (
      <select
        className={value === "" && placeholder ? "select settings-placeholder-value" : "select"}
        disabled={disabled}
        id={field.id}
        onChange={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
        value={value}
        {...isInvalid(validation, field.id)}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {(field.options || []).map((option) => (
          <option key={`${field.id}-${option.value}`} value={option.value}>
            {getSelectOptionLabel(fieldKey, option)}
          </option>
        ))}
      </select>
    );
  }
  const inputType = field.kind === "number" && fieldKey !== "threads" ? "number" : "text";
  const placeholder = getFieldPlaceholder(fieldKey, draftSettings, uiState);
  const value = getFieldValue(fieldKey, draftSettings);
  if (field.kind === "text" && isCompressionCodecFieldKey(fieldKey)) {
    return (
      <CodecCombobox
        disabled={disabled}
        forceInvalid={validation.invalidFields.includes(field.id)}
        id={field.id}
        inputClassName={value === "" && placeholder ? "input mono settings-placeholder-value" : "input mono"}
        label={field.label || fieldKey}
        multiple={fieldKey === "chdCreateCdCodecs" || fieldKey === "chdCreateDvdCodecs"}
        onChange={(nextValue) => onDraftChange(fieldKey, nextValue)}
        options={field.codecOptions || []}
        placeholder={placeholder}
        suggestions={field.codecSuggestions}
        value={value}
      />
    );
  }
  return (
    <input
      className={value === "" && placeholder ? "input mono settings-placeholder-value" : "input mono"}
      disabled={disabled}
      id={field.id}
      max={inputType === "number" ? getSettingsFieldMax(fieldKey, draftSettings, uiState) : undefined}
      min={inputType === "number" ? getSettingsFieldMin(fieldKey, draftSettings, uiState) : undefined}
      onChange={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
      placeholder={placeholder}
      step={inputType === "number" ? field.step : undefined}
      type={inputType}
      value={value}
      {...isInvalid(validation, field.id)}
    />
  );
};

const SettingsRow = (props: FieldRenderProps) => {
  const field = SETTINGS_FIELD_METADATA[props.fieldKey];
  return (
    <div className="setrow">
      <span className="slabel">
        <label htmlFor={field.id}>{field.label}</label>
        {renderFieldInfo(props.fieldKey, props.draftSettings, props.uiState)}
      </span>
      <span className="sctl">
        <FieldControl {...props} />
      </span>
    </div>
  );
};

const SettingsToggle = ({ fieldKey, draftSettings, uiState, onDraftChange }: FieldRenderProps) => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  const disabled = isSettingsFieldDisabled(fieldKey, draftSettings, uiState);
  const checked =
    field.kind === "choice-checkbox"
      ? getChoiceCheckboxValue(fieldKey, draftSettings) === field.checkedValue
      : getCheckboxValue(fieldKey, draftSettings);
  return (
    <label className="popt opt">
      <input
        checked={checked}
        disabled={disabled}
        id={field.id}
        onChange={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
        type="checkbox"
      />
      {field.label}
    </label>
  );
};

const SettingsRange = ({ fieldKey, draftSettings, uiState, validation, onDraftChange }: FieldRenderProps) => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  const scaleLabels = field.scaleLabels || [];
  const current = scaleLabels[uiState.compressionProfileIndex] || "";
  return (
    <div className="srange">
      <div className="srange-head">
        <span className="srange-label">
          <label htmlFor={field.id}>{field.label}</label>
          {renderFieldInfo(fieldKey, draftSettings, uiState)}
        </span>
        <span className="v">{current}</span>
      </div>
      <input
        id={field.id}
        max={getSettingsFieldMax(fieldKey, draftSettings, uiState)}
        min={getSettingsFieldMin(fieldKey, draftSettings, uiState)}
        onChange={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
        onInput={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
        step={field.step}
        type="range"
        value={uiState.compressionProfileIndex}
        {...isInvalid(validation, field.id)}
      />
      <div aria-hidden="true" className="srange-scale">
        {scaleLabels.map((label) => (
          <span key={`${field.id}-${label}`}>{label}</span>
        ))}
      </div>
    </div>
  );
};

const SettingsGroup = ({
  section,
  draftSettings,
  uiState,
  validation,
  onDraftChange,
}: { section: { fields: SettingsFieldKey[]; title: string } } & SettingsFieldShared) => {
  const shared = { draftSettings, onDraftChange, uiState, validation };
  const fields = section.fields.filter(
    (fieldKey) => SETTINGS_PANEL_FIELD_ORDER.includes(fieldKey) && SETTINGS_FIELD_METADATA[fieldKey].kind !== "hidden",
  );
  if (!fields.length) return null;
  const toggles = fields.filter((fieldKey) => TOGGLE_KINDS.has(SETTINGS_FIELD_METADATA[fieldKey].kind));
  const rows = fields.filter((fieldKey) => !TOGGLE_KINDS.has(SETTINGS_FIELD_METADATA[fieldKey].kind));
  return (
    <div className="setgroup">
      <div className="gtitle">{section.title}</div>
      {rows.map((fieldKey) =>
        SETTINGS_FIELD_METADATA[fieldKey].kind === "range" ? (
          <SettingsRange fieldKey={fieldKey} key={fieldKey} {...shared} />
        ) : (
          <SettingsRow fieldKey={fieldKey} key={fieldKey} {...shared} />
        ),
      )}
      {toggles.length ? (
        <div className="setchecks">
          {toggles.map((fieldKey) => (
            <SettingsToggle fieldKey={fieldKey} key={fieldKey} {...shared} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const AboutSection = () => (
  <div className="setgroup set-about">
    <div className="gtitle">About</div>
    <div className="about-line mono">
      rom-weaver{RESOLVED_APP_BUILD_VERSION ? ` ${RESOLVED_APP_BUILD_VERSION}` : ""}
    </div>
    <div className="about-line">
      © Brandon Casey. Free and open-source software under the{" "}
      <a href={LICENSE_URL} rel="noreferrer" target="_blank">
        GNU AGPL v3 (or later) license
      </a>
      .
    </div>
    <div className="about-line">
      Built with open-source components (nod, libarchive, chd-rs, and others) used under their own licenses; see the{" "}
      <a href={NOTICE_URL} rel="noreferrer" target="_blank">
        attribution and license inventory
      </a>
      .
    </div>
  </div>
);

function SettingsPanel({ draftSettings, uiState, validation, onDraftChange }: SettingsPanelProps): ReactNode {
  const shared = { draftSettings, onDraftChange, uiState: uiState ?? getSettingsUiState(draftSettings), validation };
  const fullWidthSections = settingsPanelSections.filter((section) => !FORMAT_GROUP_TITLES.has(section.title));
  const gridSections = settingsPanelSections.filter((section) => FORMAT_GROUP_TITLES.has(section.title));
  return (
    <div>
      {fullWidthSections.map((section) => (
        <SettingsGroup key={section.title} section={section} {...shared} />
      ))}
      <div className="setcols">
        {gridSections.map((section) => (
          <SettingsGroup key={section.title} section={section} {...shared} />
        ))}
      </div>
      {validation.messages.length ? (
        <div aria-live="polite" className="validation bad" id="settings-validation-message" role="alert">
          {validation.messages.join(" ")}
        </div>
      ) : null}
      <AboutSection />
    </div>
  );
}

export { SettingsPanel };
