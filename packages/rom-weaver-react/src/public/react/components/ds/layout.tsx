import Upload from "lucide-react/dist/esm/icons/upload.js";
import { type ReactNode, useId, useState } from "react";

/**
 * Design-system layout primitives: the numbered step section, the inline help
 * popover, and the drag-and-drop file affordance. Shared by every workflow so
 * the section/upload chrome is defined once.
 */

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

/** A numbered workflow step with an optional help popover and trailing meta. */
const StepSection = ({
  num,
  title,
  info,
  meta,
  children,
  id,
}: {
  num: string;
  title: ReactNode;
  info?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  id?: string;
}) => (
  <section className="step" id={id}>
    <div className="step-head">
      <span className="step-num">{num}</span>
      <span className="step-title">{title}</span>
      {info}
      {meta ? <span className="step-meta inline">{meta}</span> : null}
    </div>
    <div className="step-body">{children}</div>
  </section>
);

/** `<details>`-based inline help bubble. The summary is the round "i" trigger. */
const InfoPopover = ({ title, children }: { title?: string; children: ReactNode }) => (
  <details className="info">
    <summary title={title}>i</summary>
    <div className="info-pop">{children}</div>
  </details>
);

/**
 * Drag-and-drop / click-to-browse file affordance backed by a hidden file
 * input. `big` is the empty-state variant; the inline variant adds more files.
 */
const DropZone = ({
  label,
  hint,
  big,
  multiple,
  accept,
  disabled,
  onFiles,
  id,
}: {
  label: ReactNode;
  hint?: ReactNode;
  big?: boolean;
  multiple?: boolean;
  accept?: string;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  id?: string;
}) => {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);

  const emit = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  };

  // A <label> wrapping the hidden file input is natively clickable and
  // keyboard-accessible (focus lands on the input), so no role/tabindex needed.
  return (
    <label
      aria-disabled={disabled || undefined}
      className={join("drop", big && "big", dragging && "dragging")}
      htmlFor={inputId}
      id={id}
      onDragLeave={() => setDragging(false)}
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (disabled) return;
        emit(event.dataTransfer?.files ?? null);
      }}
    >
      <span className="main">
        <Upload aria-hidden="true" />
        {label}
      </span>
      {hint ? <span className="hint">{hint}</span> : null}
      <input
        accept={accept}
        aria-label={typeof label === "string" ? label : undefined}
        className="absolute h-px w-px overflow-hidden opacity-0"
        disabled={disabled}
        id={inputId}
        multiple={multiple}
        onChange={(event) => {
          emit(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
        type="file"
      />
    </label>
  );
};

export { DropZone, InfoPopover, StepSection };
