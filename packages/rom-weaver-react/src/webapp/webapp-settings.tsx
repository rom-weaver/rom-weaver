import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { type CSSProperties, type ReactNode } from "react";
import { APP_BUILD_VERSION } from "./build-version.ts";
import { InfoToggle } from "./components/info-toggle.tsx";
import type { SettingsDraftState, SettingsFieldKey, SettingsUiState } from "./settings/settings-state.ts";
import {
  getSettingsFieldDefaultValue,
  getSettingsFieldMax,
  getSettingsFieldMin,
  getSettingsFieldPlaceholder,
  getSettingsFieldSuggestion,
  getSettingsFieldSuggestionDataLocalize,
  isSettingsFieldDisabled,
  SETTINGS_FIELD_ID_TO_KEY,
  SETTINGS_FIELD_METADATA,
  SETTINGS_PANEL_FIELD_ORDER,
} from "./settings/settings-state.ts";
import { buttonClasses, cx, formClasses, settingsClasses, tabClasses } from "./tailwind-classes.ts";
import type { ValidationState, WorkflowView } from "./webapp-state-types.ts";

type TabProps = {
  currentView: WorkflowView;
  onSelectView: (mode: WorkflowView) => void;
};

type SettingsPanelProps = {
  draftSettings: SettingsDraftState;
  uiState: SettingsUiState;
  validation: ValidationState;
  onDraftChange: (field: SettingsFieldKey, value: string | boolean) => void;
  onClose: () => void;
  onRestoreDefaults: () => void;
  onSaveClose: () => void;
};

type SettingsFieldRowProps = Pick<SettingsPanelProps, "draftSettings" | "uiState" | "validation" | "onDraftChange"> & {
  fieldKey: SettingsFieldKey;
};

const settingsPanelSections: Array<{ fields: SettingsFieldKey[]; title: string }> = [
  {
    fields: ["requireInputChecksumMatch", "requireOutputChecksumMatch"],
    title: "Validation",
  },
  {
    fields: ["fixChecksum"],
    title: "Compatibility",
  },
  {
    fields: ["compressionProfile"],
    title: "Output",
  },
  {
    fields: ["sevenZipCodec", "sevenZipLevel", "zipCodec", "zipLevel"],
    title: "ZIP / 7z",
  },
  {
    fields: ["rvzCompression", "rvzCompressionLevel", "rvzBlockSize", "rvzScrub"],
    title: "RVZ",
  },
  {
    fields: ["chdCreateCdCodecs", "chdCreateDvdCodecs"],
    title: "CHD",
  },
  {
    fields: ["z3dsCompressionLevel"],
    title: "Z3DS",
  },
  {
    fields: ["workerThreads"],
    title: "Workers",
  },
  {
    fields: ["language", "logLevel", "erudaDevTools"],
    title: "Logging",
  },
];

const tabClassName = (currentView: WorkflowView, tabMode: WorkflowView) =>
  [currentView === tabMode ? `active ${tabClasses.buttonActive}` : "", tabClasses.button].filter(Boolean).join(" ");

const settingsSelectClassName = cx(formClasses.select, formClasses.invalid, settingsClasses.control);
const settingsTextClassName = cx(formClasses.base, formClasses.disabled, formClasses.invalid, settingsClasses.control);
const settingsRangeClassName = cx(settingsClasses.compressionRange, formClasses.invalid);

function WorkflowTabs({ currentView, onSelectView }: TabProps) {
  return (
    <>
      <button
        aria-controls="rom-weaver-container"
        aria-selected={currentView === "patcher" ? "true" : "false"}
        className={tabClassName(currentView, "patcher")}
        id="tab-patcher"
        onClick={() => onSelectView("patcher")}
        role="tab"
        type="button"
      >
        Patcher
      </button>
      <button
        aria-controls="patch-builder-container"
        aria-selected={currentView === "creator" ? "true" : "false"}
        className={tabClassName(currentView, "creator")}
        id="tab-creator"
        onClick={() => onSelectView("creator")}
        role="tab"
        type="button"
      >
        Creator
      </button>
    </>
  );
}

const invalidProps = (validation: ValidationState, id: string) =>
  validation.invalidFields.includes(id)
    ? {
        "aria-invalid": true,
      }
    : {};

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
  onDraftChange(fieldKey, target.value);
};

const getFieldValue = (fieldKey: SettingsFieldKey, draftSettings: SettingsDraftState): string => {
  const value = draftSettings[fieldKey];
  if (value === undefined || value === null) {
    const defaultValue = getSettingsFieldDefaultValue(fieldKey);
    return defaultValue === undefined || defaultValue === null ? "" : String(defaultValue);
  }
  return String(value);
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

const getFieldClasses = (fieldKey: SettingsFieldKey) => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  return field.layout === "large"
    ? {
        label: settingsClasses.labelLarge,
        value: settingsClasses.valueLarge,
      }
    : {
        label: settingsClasses.label,
        value: settingsClasses.value,
      };
};

const renderFieldInfoToggle = (
  fieldKey: SettingsFieldKey,
  draftSettings: SettingsDraftState,
  uiState: SettingsUiState,
) => {
  const suggestion = getSettingsFieldSuggestion(fieldKey, draftSettings, uiState);
  const suggestionDataLocalize = getSettingsFieldSuggestionDataLocalize(fieldKey, draftSettings, uiState);
  if (!suggestion) return null;
  return (
    <InfoToggle
      ariaLabel={`Show ${SETTINGS_FIELD_METADATA[fieldKey].label || fieldKey} details`}
      panelClassName={settingsClasses.infoPanel}
      portalPanel
      title={`Show ${SETTINGS_FIELD_METADATA[fieldKey].label || fieldKey} details`}
    >
      <div data-localize={typeof suggestionDataLocalize === "string" ? suggestionDataLocalize : undefined}>
        {suggestion}
      </div>
    </InfoToggle>
  );
};

const renderFieldLabel = (fieldKey: SettingsFieldKey) => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  if (!field.label) return null;
  return (
    <label data-localize={field.labelDataLocalize} htmlFor={field.id}>
      {field.label}
    </label>
  );
};

function SettingsFieldRowLayout({
  fieldKey,
  info,
  children,
}: {
  fieldKey: SettingsFieldKey;
  info?: ReactNode;
  children: ReactNode;
}) {
  const fieldClasses = getFieldClasses(fieldKey);
  return (
    <div className={settingsClasses.row}>
      <div className={fieldClasses.label}>
        <span className={settingsClasses.labelWithInfo}>
          {renderFieldLabel(fieldKey)}
          {info}
        </span>
      </div>
      <div className={fieldClasses.value}>{children}</div>
    </div>
  );
}

function SettingsCheckboxField({
  fieldKey,
  checked,
  disabled,
  onDraftChange,
}: {
  fieldKey: SettingsFieldKey;
  checked: boolean;
  disabled: boolean;
  onDraftChange: SettingsPanelProps["onDraftChange"];
}) {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  return (
    <input
      checked={checked}
      className={formClasses.checkbox}
      disabled={disabled}
      id={field.id}
      onChange={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
      type="checkbox"
    />
  );
}

function SettingsScalarInputField({
  fieldKey,
  type,
  value,
  disabled,
  placeholder,
  min,
  max,
  validation,
  onDraftChange,
}: {
  fieldKey: SettingsFieldKey;
  type: "text" | "number";
  value: string;
  disabled: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  validation: ValidationState;
  onDraftChange: SettingsPanelProps["onDraftChange"];
}) {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  return (
    <input
      className={settingsTextClassName}
      disabled={disabled}
      id={field.id}
      max={type === "number" ? max : undefined}
      min={type === "number" ? min : undefined}
      onChange={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
      placeholder={placeholder}
      step={type === "number" ? field.step : undefined}
      type={type}
      value={value}
      {...invalidProps(validation, field.id)}
    />
  );
}

function SettingsFieldRow({ fieldKey, draftSettings, uiState, validation, onDraftChange }: SettingsFieldRowProps) {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  const disabled = isSettingsFieldDisabled(fieldKey, draftSettings, uiState);
  const placeholder = getSettingsFieldPlaceholder(fieldKey, draftSettings, uiState);
  const min = getSettingsFieldMin(fieldKey, draftSettings, uiState);
  const max = getSettingsFieldMax(fieldKey, draftSettings, uiState);
  const info = renderFieldInfoToggle(fieldKey, draftSettings, uiState);

  if (field.kind === "hidden") return null;

  if (field.kind === "checkbox") {
    return (
      <SettingsFieldRowLayout fieldKey={fieldKey} info={info}>
        <SettingsCheckboxField
          checked={getCheckboxValue(fieldKey, draftSettings)}
          disabled={disabled}
          fieldKey={fieldKey}
          onDraftChange={onDraftChange}
        />
      </SettingsFieldRowLayout>
    );
  }

  if (field.kind === "choice-checkbox") {
    return (
      <SettingsFieldRowLayout fieldKey={fieldKey} info={info}>
        <SettingsCheckboxField
          checked={getChoiceCheckboxValue(fieldKey, draftSettings) === field.checkedValue}
          disabled={disabled}
          fieldKey={fieldKey}
          onDraftChange={onDraftChange}
        />
      </SettingsFieldRowLayout>
    );
  }

  if (field.kind === "select") {
    return (
      <SettingsFieldRowLayout fieldKey={fieldKey} info={info}>
        <select
          className={settingsSelectClassName}
          disabled={disabled}
          id={field.id}
          onChange={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
          value={getFieldValue(fieldKey, draftSettings)}
          {...invalidProps(validation, field.id)}
        >
          {(field.options || []).map((option) => (
            <option key={`${field.id}-${option.value}`} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingsFieldRowLayout>
    );
  }

  if (field.kind === "text") {
    return (
      <SettingsFieldRowLayout fieldKey={fieldKey} info={info}>
        <SettingsScalarInputField
          disabled={disabled}
          fieldKey={fieldKey}
          onDraftChange={onDraftChange}
          placeholder={placeholder}
          type="text"
          validation={validation}
          value={getFieldValue(fieldKey, draftSettings)}
        />
      </SettingsFieldRowLayout>
    );
  }

  if (field.kind === "number") {
    const inputType = fieldKey === "workerThreads" ? "text" : "number";
    return (
      <SettingsFieldRowLayout fieldKey={fieldKey} info={info}>
        <SettingsScalarInputField
          disabled={disabled}
          fieldKey={fieldKey}
          max={max}
          min={min}
          onDraftChange={onDraftChange}
          placeholder={placeholder}
          type={inputType}
          validation={validation}
          value={getFieldValue(fieldKey, draftSettings)}
        />
      </SettingsFieldRowLayout>
    );
  }

  if (field.kind === "range") {
    const scaleLabels = field.scaleLabels || [];
    const scaleStepCount = Math.max(1, scaleLabels.length - 1);

    return (
      <div className={settingsClasses.rangeRow}>
        <div className={settingsClasses.rangeHeader}>
          <div className={settingsClasses.rangeLabelBlock}>
            <span className={settingsClasses.labelWithInfo}>
              {renderFieldLabel(fieldKey)}
              {info}
            </span>
          </div>
        </div>
        <div className={settingsClasses.compressionControl}>
          <input
            className={settingsRangeClassName}
            id={field.id}
            max={max}
            min={min}
            onChange={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
            onInput={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
            step={field.step}
            type="range"
            value={uiState.compressionProfileIndex}
            {...invalidProps(validation, field.id)}
          />
          <div aria-hidden="true" className={settingsClasses.compressionScale}>
            {scaleLabels.map((label, index) => (
              <span
                className={settingsClasses.compressionScaleLabel}
                data-localize={label}
                key={`${field.id}-${label}`}
                style={
                  {
                    "--compression-scale-position": `${(index / scaleStepCount) * 100}%`,
                  } as CSSProperties
                }
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function RuntimeDiagnosticsPanel() {
  return (
    <section className={settingsClasses.section}>
      <h3 className={settingsClasses.sectionTitle}>Version / Runtime</h3>
      <div className="grid gap-2 text-left text-[12px] leading-[1.3] text-[#4f5757]">
        <div>
          <div className="font-bold text-[#243232]">Version</div>
          <div className="break-all font-mono text-[11px]">{APP_BUILD_VERSION}</div>
        </div>
      </div>
    </section>
  );
}

function SettingsPanel({ draftSettings, uiState, validation, onDraftChange }: SettingsPanelProps) {
  return (
    <div className={settingsClasses.panel}>
      {settingsPanelSections.map((section) => (
        <section className={settingsClasses.section} key={section.fields.join("-")}>
          <h3 className={settingsClasses.sectionTitle}>{section.title}</h3>
          <div className={settingsClasses.grid}>
            {section.fields
              .filter((fieldKey) => SETTINGS_PANEL_FIELD_ORDER.includes(fieldKey))
              .map((fieldKey) => (
                <SettingsFieldRow
                  draftSettings={draftSettings}
                  fieldKey={fieldKey}
                  key={fieldKey}
                  onDraftChange={onDraftChange}
                  uiState={uiState}
                  validation={validation}
                />
              ))}
          </div>
        </section>
      ))}

      <div aria-live="polite" className={settingsClasses.validation} id="settings-validation-message" role="alert">
        {validation.messages.join(" ")}
      </div>
      <RuntimeDiagnosticsPanel />
    </div>
  );
}

function SettingsHeaderActions({
  onClose,
  onRestoreDefaults,
  onSaveClose,
}: Pick<SettingsPanelProps, "onClose" | "onRestoreDefaults" | "onSaveClose">) {
  return (
    <>
      <button
        aria-label="Restore defaults"
        className={cx(buttonClasses.primary, settingsClasses.actionButton, settingsClasses.actionWarning)}
        data-localize="Restore defaults"
        id="settings-restore-defaults"
        onClick={onRestoreDefaults}
        title="Restore defaults"
        type="button"
      >
        <RotateCcw aria-hidden="true" className={settingsClasses.actionIcon} />
      </button>
      <button
        aria-label="Save settings"
        className={cx(buttonClasses.primary, settingsClasses.actionButton, settingsClasses.actionSuccess)}
        data-localize="Save and close"
        id="settings-save-close"
        onClick={onSaveClose}
        title="Save settings"
        type="button"
      >
        <Save aria-hidden="true" className={settingsClasses.actionIcon} />
      </button>
      <button
        aria-label="Close settings"
        className={cx(buttonClasses.primary, settingsClasses.actionButton, settingsClasses.actionDanger)}
        id="settings-close"
        onClick={onClose}
        title="Close settings"
        type="button"
      >
        <X aria-hidden="true" className={settingsClasses.actionIcon} />
      </button>
    </>
  );
}

export { SettingsHeaderActions, SettingsPanel, WorkflowTabs };
