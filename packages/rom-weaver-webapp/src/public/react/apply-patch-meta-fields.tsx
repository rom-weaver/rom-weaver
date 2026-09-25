import type { PatchStackItemState } from "./patcher-presentation.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";
import { autosizeTextarea } from "./apply-patch-list-helpers.tsx";

type PatchMetaFieldProps = {
  index: number;
  item: PatchStackItemState;
  meta?: BundlePatchMeta;
  onMetaChange: (updates: Partial<BundlePatchMeta>) => void;
};

/** A single-line commit input for the meta form: trims on blur, Enter commits. */
const PatchMetaTextField = ({
  field,
  index,
  item,
  label,
  meta,
  onMetaChange,
  onSubmit,
  placeholder,
}: PatchMetaFieldProps & {
  field: "name" | "version" | "author";
  label: string;
  onSubmit: () => void;
  placeholder: string;
}) => (
  <div className={`ofld patch-meta-field patch-${field}-meta-field`}>
    <label className="ofld-l" htmlFor={`rom-weaver-patch-${field}-${index}`}>
      {label}
    </label>
    <input
      className="input popt-input"
      defaultValue={meta?.[field] || ""}
      id={`rom-weaver-patch-${field}-${index}`}
      key={`patch-${field}:${item.key ?? index}:${meta?.[field] || ""}`}
      onBlur={(event) => onMetaChange({ [field]: event.currentTarget.value.trim() || undefined })}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
          onSubmit();
        }
      }}
      placeholder={placeholder}
      spellCheck={false}
      type="text"
    />
  </div>
);

/** Pencil-editing a card: ONE form holding every editable patch field - name,
 * description, version, author - in place of the static description line.
 * Each field commits on blur; Enter commits and closes the form (Shift+Enter
 * keeps a newline in the description). */
const PatchMetaFields = ({
  index,
  item,
  meta,
  onMetaChange,
  onSubmit,
}: PatchMetaFieldProps & { onSubmit: () => void }) => (
  <PatchMetaFieldsContent index={index} item={item} meta={meta} onMetaChange={onMetaChange} onSubmit={onSubmit} />
);

const PatchMetaFieldsContent = ({
  index,
  item,
  meta,
  onMetaChange,
  onSubmit,
}: PatchMetaFieldProps & {
  onSubmit: () => void;
}) => {
  const localizer = useUiLocalizer();
  return (
    <div className="patch-meta-inline">
      <PatchMetaTextField
        field="name"
        index={index}
        item={item}
        label={localizer.message("ui.patch.name")}
        meta={meta}
        onMetaChange={onMetaChange}
        onSubmit={onSubmit}
        placeholder={item.fileName.replace(/\.[^.]+$/, "")}
      />
      <div className="ofld patch-description-field">
        <label className="ofld-l" htmlFor={`rom-weaver-patch-description-${index}`}>
          {localizer.message("ui.patch.description")}
        </label>
        <textarea
          className="input popt-input"
          defaultValue={meta?.description || ""}
          id={`rom-weaver-patch-description-${index}`}
          key={`patch-description:${item.key ?? index}:${meta?.description || ""}`}
          onBlur={(event) => onMetaChange({ description: event.currentTarget.value.trim() || undefined })}
          onInput={(event) => autosizeTextarea(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.blur();
              onSubmit();
            }
          }}
          placeholder={localizer.message("ui.patch.descriptionPlaceholder")}
          ref={autosizeTextarea}
          rows={1}
        />
      </div>
      <div className="patch-meta-cols">
        <PatchMetaTextField
          field="version"
          index={index}
          item={item}
          label={localizer.message("ui.patch.version")}
          meta={meta}
          onMetaChange={onMetaChange}
          onSubmit={onSubmit}
          placeholder="1.0"
        />
        <PatchMetaTextField
          field="author"
          index={index}
          item={item}
          label={localizer.message("ui.patch.author")}
          meta={meta}
          onMetaChange={onMetaChange}
          onSubmit={onSubmit}
          placeholder={localizer.message("ui.patch.authorPlaceholder")}
        />
      </div>
    </div>
  );
};

export { PatchMetaFields };
