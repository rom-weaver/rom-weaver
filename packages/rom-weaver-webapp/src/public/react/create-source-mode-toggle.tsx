import { useUiLocalizer } from "./settings-context.tsx";

type CreateSourceModeToggleProps = {
  value: "rom" | "patches";
  onChange: (mode: "rom" | "patches") => void;
  disabled?: boolean;
};

const CreateSourceModeToggle = ({ value, onChange, disabled }: CreateSourceModeToggleProps) => {
  const localizer = useUiLocalizer();
  return (
    <fieldset className="seg">
      <legend className="sr-only">{localizer.message("ui.create.sourceMode.label")}</legend>
      {(["rom", "patches"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className="seg-btn"
          aria-pressed={value === mode}
          disabled={disabled}
          onClick={() => onChange(mode)}
        >
          {localizer.message(mode === "rom" ? "ui.create.sourceMode.rom" : "ui.create.sourceMode.patches")}
        </button>
      ))}
    </fieldset>
  );
};

export { CreateSourceModeToggle };
