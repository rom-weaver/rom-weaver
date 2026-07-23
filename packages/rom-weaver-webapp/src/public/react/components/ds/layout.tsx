import { Upload } from "lucide-react";
import { type ReactNode, type Ref, useId, useState } from "react";
import { readDataTransferFiles } from "../../../../lib/input/dropped-files.ts";
import { perfNow, recordDrop } from "../../../../lib/runtime/perf-latency.ts";
import { InfoToggle } from "../../../../presentation/react/info-toggle.tsx";
import { join } from "./cx.ts";

// Stamp the perceived-latency start for each incoming file so the eventual
// command can emit a drop -> done measure. Shared by the drop and picker paths.
const stampDroppedFiles = (files: readonly File[], atMs: number): void => {
  for (const file of files) recordDrop(file.name, atMs);
};

/**
 * Loom layout primitives: the numbered step section (0x01 …), the inline info
 * popover, and the drag-and-drop file affordance (hero / add-row variants).
 * Shared by every workflow so the section/upload chrome is defined once.
 */

/** A numbered workflow step with an optional help popover and trailing meta. */
const StepSection = ({
  num,
  title,
  info,
  meta,
  headerExtra,
  children,
  id,
  className,
  woven,
  fault,
  headerAction,
}: {
  num: string;
  title: ReactNode;
  info?: ReactNode;
  meta?: ReactNode;
  /** Right-aligned control that shares the header row (e.g. a mode toggle). */
  headerExtra?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
  /** Optional mobile-sized action covering the section heading. */
  headerAction?: { disabled?: boolean; label: string; onClick: () => void };
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
      {headerExtra}
      {headerAction ? (
        <button
          aria-label={headerAction.label}
          className="step-head-action"
          disabled={headerAction.disabled}
          onClick={headerAction.onClick}
          type="button"
        />
      ) : null}
    </div>
    <div className="step-body">{children}</div>
  </section>
);

/**
 * Clickable "i" info mark with a viewport-aware popover. Content is the
 * caller's - typically a `.info-list` bullet list.
 */
const InfoPopover = ({ title = "More info", children }: { title?: string; children: ReactNode }) => (
  <InfoToggle ariaLabel={title} portalPanel title={title}>
    {children}
  </InfoToggle>
);

/**
 * Drag-and-drop / click-to-browse file affordance backed by a hidden file
 * input. `big` is the hero (empty-state) variant with optional format pills;
 * the compact variant is the add-more row.
 */
const DropZone = ({
  lead,
  label,
  labelCoarse,
  hint,
  hintCoarse,
  formats,
  big,
  bare,
  multiple,
  accept,
  disabled,
  reading: readingLabel = "Reading folder…",
  onDropStart,
  onFiles,
  id,
  inputId,
  inputRef,
}: {
  /** Intro content rendered inside the hero drop surface. */
  lead?: ReactNode;
  label: ReactNode;
  /** Touch-device label shown instead of `label` on coarse pointers. */
  labelCoarse?: ReactNode;
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
  /** Fires as soon as the user supplies files, before any staging work begins. */
  onDropStart?: () => void;
  onFiles: (files: File[]) => void;
  id?: string;
  inputId?: string;
  inputRef?: Ref<HTMLInputElement>;
}) => {
  const generatedInputId = useId();
  const resolvedInputId = inputId || generatedInputId;
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const formatSplit = Math.ceil((formats?.length || 0) / 2);
  const formatRows = formats?.length
    ? formats.length < 4
      ? [Array.from({ length: 12 }, (_, index) => formats[index % formats.length])]
      : [formats.slice(0, formatSplit), formats.slice(formatSplit)]
    : [];

  const emit = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    stampDroppedFiles(files, perfNow());
    onDropStart?.();
    onFiles(files);
  };

  // The drop instruction. In the hero it sits below the fell line as the woven
  // cloth; in the compact add-row it rides inline in the button.
  const renderLabelBody = () =>
    reading ? (
      <span>{readingLabel}</span>
    ) : labelCoarse ? (
      <>
        <span className="pointer-copy fine">{label}</span>
        <span className="pointer-copy coarse">{labelCoarse}</span>
      </>
    ) : (
      <span>{label}</span>
    );
  // In the hero the glyph is the shuttle bead that rides the fell line (no
  // label - that drops below); in the compact add-row it is the plain button
  // with its label inline.
  const mainNode = (
    <span className={join("main", big ? "bead" : "btnish")}>
      {reading ? <span aria-hidden="true" className="spinner" /> : <Upload aria-hidden="true" />}
      {big ? null : renderLabelBody()}
    </span>
  );
  const formatsNode =
    big && formats?.length ? (
      <span aria-hidden="true" className="formats">
        {formatRows.map((row) => (
          <span className="formats-lane" key={row.join("|")}>
            <span className="formats-track">
              {[0, 1].map((copy) => (
                <span className="formats-set" key={copy}>
                  {row.map((format) => (
                    <span className="fmt mono" key={`${copy}-${format}`}>
                      {format}
                    </span>
                  ))}
                </span>
              ))}
            </span>
          </span>
        ))}
      </span>
    ) : null;

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
        onDropStart?.();
        // Stamp the drop instant now; folder reads below are async, but the
        // perceived latency starts the moment the user let go of the files.
        const droppedAtMs = perfNow();
        // Read synchronously so folder entries are captured before the
        // DataTransfer is cleared; folders are flattened into the file list.
        // Surface a "reading" hint only if the traversal runs long enough to
        // matter, so plain file drops don't flicker it.
        const readingTimer = setTimeout(() => setReading(true), 120);
        void readDataTransferFiles(event.dataTransfer).then((files) => {
          clearTimeout(readingTimer);
          setReading(false);
          if (files.length) {
            stampDroppedFiles(files, droppedAtMs);
            onFiles(files);
          }
        });
      }}
    >
      {lead}
      {big ? (
        <>
          {/* the fell line: the active weave row the upload bead sits on as the
              mid-point pivot, with the woven threads meeting it from both selvages */}
          <div className="fell">
            <span aria-hidden="true" className="fell-thread" />
            {mainNode}
            <span aria-hidden="true" className="fell-thread" />
          </div>
          {/* woven cloth below the fell: the drop instruction, then the format reed */}
          <div className="drop-base">
            <span className="drop-belowlabel">{renderLabelBody()}</span>
            {formatsNode}
          </div>
        </>
      ) : (
        <>
          {mainNode}
          {hint ? <span className="hint fine">{hint}</span> : null}
          {hintCoarse ? <span className="hint coarse">{hintCoarse}</span> : null}
        </>
      )}
      <input
        accept={accept}
        aria-label={typeof label === "string" ? label : "Add files"}
        className="sr-only"
        disabled={disabled}
        id={resolvedInputId}
        multiple={multiple}
        onChange={(event) => {
          emit(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
        ref={inputRef}
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
