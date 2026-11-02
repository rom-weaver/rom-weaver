import type { TrimMode } from "../../lib/trim/trim-output-name.ts";

type TrimModeToggleProps = {
  value: TrimMode;
  onChange: (mode: TrimMode) => void;
  disabled?: boolean;
};

const TRIM_MODE_LABELS: Record<TrimMode, string> = { restore: "Restore padding", trim: "Trim" };

const TrimModeToggle = ({ value, onChange, disabled }: TrimModeToggleProps) => (
  <fieldset className="seg seg-fit" id="trim-builder-mode">
    <legend className="sr-only">Trim mode</legend>
    {(["trim", "restore"] as const).map((mode) => (
      <button
        key={mode}
        type="button"
        className="seg-btn"
        aria-pressed={value === mode}
        disabled={disabled}
        onClick={() => onChange(mode)}
      >
        {TRIM_MODE_LABELS[mode]}
      </button>
    ))}
  </fieldset>
);

export { TrimModeToggle };
