import Info from "lucide-react/dist/esm/icons/info.js";
import Upload from "lucide-react/dist/esm/icons/upload.js";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { readDataTransferFiles } from "../../../../lib/input/dropped-files.ts";

/**
 * Loom layout primitives: the numbered step section (0x01 …), the inline info
 * popover, and the drag-and-drop file affordance (hero / add-row variants).
 * Shared by every workflow so the section/upload chrome is defined once.
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
  className,
  woven,
  fault,
}: {
  num: string;
  title: ReactNode;
  info?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
  /** Accent the step number (a finished stage). */
  woven?: boolean;
  /** Mark the step as the failing stage. */
  fault?: boolean;
}) => (
  <section className={join("step", woven && "is-woven", fault && "is-fault", className)} id={id}>
    <div className="step-head">
      <span className="step-num mono">{num}</span>
      <h2 className="step-title">{title}</h2>
      {info}
      {meta ? <span className="step-meta mono">{meta}</span> : null}
    </div>
    <div className="step-body">{children}</div>
  </section>
);

/**
 * Clickable "i" info mark with a drop-in popover. Closes on outside click and
 * Escape. Content is the caller's — typically a `.info-list` bullet list.
 */
const InfoPopover = ({ title = "More info", children }: { title?: string; children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const handlePointer = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("click", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);
  return (
    <span className="info" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-label={title}
        className="info-btn"
        onClick={() => setOpen((previous) => !previous)}
        title={title}
        type="button"
      >
        <Info aria-hidden="true" />
      </button>
      <span className="info-pop" hidden={!open} role="note">
        {children}
      </span>
    </span>
  );
};

/**
 * Drag-and-drop / click-to-browse file affordance backed by a hidden file
 * input. `big` is the hero (empty-state) variant with optional format pills;
 * the compact variant is the add-more row.
 */
const DropZone = ({
  label,
  hint,
  hintCoarse,
  formats,
  big,
  bare,
  multiple,
  accept,
  disabled,
  reading: readingLabel = "Reading folder…",
  onFiles,
  id,
  inputId,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** Touch-device hint (shown instead of `hint` on coarse pointers). */
  hintCoarse?: ReactNode;
  /** Format pills under the hero label (hero variant only). */
  formats?: readonly string[];
  big?: boolean;
  /** Hero without its own border (the input step already frames it). */
  bare?: boolean;
  multiple?: boolean;
  accept?: string;
  disabled?: boolean;
  /** Label shown while a dropped folder is being read. */
  reading?: ReactNode;
  onFiles: (files: File[]) => void;
  id?: string;
  inputId?: string;
}) => {
  const generatedInputId = useId();
  const resolvedInputId = inputId || generatedInputId;
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);

  const emit = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  };

  // A <label> wrapping the hidden file input is natively clickable and
  // keyboard-accessible (focus lands on the input), so no role/tabindex needed.
  return (
    <label
      aria-disabled={disabled || undefined}
      className={join("drop", big && "hero", big && bare && "bare", dragging && "dragging", reading && "staging")}
      htmlFor={resolvedInputId}
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
        // Read synchronously so folder entries are captured before the
        // DataTransfer is cleared; folders are flattened into the file list.
        // Surface a "reading" hint only if the traversal runs long enough to
        // matter, so plain file drops don't flicker it.
        const readingTimer = setTimeout(() => setReading(true), 120);
        void readDataTransferFiles(event.dataTransfer).then((files) => {
          clearTimeout(readingTimer);
          setReading(false);
          if (files.length) onFiles(files);
        });
      }}
    >
      <span className={join("main", !big && "btnish")}>
        {reading ? <span aria-hidden="true" className="spinner" /> : <Upload aria-hidden="true" />}
        <span>{reading ? readingLabel : label}</span>
      </span>
      {hint ? <span className="hint fine">{hint}</span> : null}
      {hintCoarse ? <span className="hint coarse">{hintCoarse}</span> : null}
      {big && formats?.length ? (
        <span aria-hidden="true" className="formats">
          {formats.map((format) => (
            <span className="fmt mono" key={format}>
              {format}
            </span>
          ))}
        </span>
      ) : null}
      <input
        accept={accept}
        aria-label={typeof label === "string" ? label : undefined}
        className="sr-only"
        disabled={disabled}
        id={resolvedInputId}
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

/**
 * Quiet directive shown by a secondary input section while empty: points the
 * user up to the 0x01 INPUTS hero instead of offering its own drop target.
 */
const NeedsInput = ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
  <button className="needs-input" onClick={onClick} type="button">
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 20V5m-5.5 5.5L12 5l5.5 5.5" />
    </svg>
    <span>{children}</span>
  </button>
);

export { DropZone, InfoPopover, NeedsInput, StepSection };
