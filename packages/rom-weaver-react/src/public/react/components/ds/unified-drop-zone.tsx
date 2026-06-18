import type { ReactNode } from "react";
import { createLogger } from "../../../../lib/logging.ts";
import { markDropReceived } from "../../../../lib/perf/op-perf-marks.ts";
import { DropZone, InfoPopover, StepSection } from "./layout.tsx";

/**
 * The 0x01 INPUTS step — the single combined drop surface shared by every
 * workflow tab. A hero drop target while the form is empty, shrinking to the
 * compact add-row once files are staged. Always accepts multiple files,
 * traces what it receives, and composes the per-category hints into one line.
 * Routing is decided by the per-tab caller (see `unified-drop-routing.ts`).
 */

const logger = createLogger("unified-drop-zone");

const joinHintParts = (parts: string[]): string | undefined => {
  if (parts.length <= 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}${parts.length > 2 ? "," : ""} or ${parts[parts.length - 1]}`;
};

type SupportedFileGroup = {
  label: string;
  extensions: readonly string[];
};

type UnifiedDropZoneProps = {
  label: ReactNode;
  romHint?: string;
  patchHint?: string;
  archiveHint?: string;
  big?: boolean;
  disabled?: boolean;
  accept?: string;
  id?: string;
  inputId?: string;
  /** Format pills under the hero label (empty state only). */
  formats?: readonly string[];
  /** Extra content for the step-header info popover (above the supported-file lists). */
  info?: ReactNode;
  /** Full per-bucket extension support, listed in the info popover; the hint line just says "many more". */
  supported?: readonly SupportedFileGroup[];
  /** Step number/title; the inputs step is 0x01 in every workflow. */
  num?: string;
  title?: ReactNode;
  hintCoarse?: ReactNode;
  onFiles: (files: File[]) => void;
  /** Extra content rendered inside the 0x01 step body, below the drop target (e.g. the
   * "identifying…" placeholders for dropped archives) so it shares the step's content width. */
  afterDropZone?: ReactNode;
};

const UnifiedDropZone = ({
  afterDropZone,
  archiveHint,
  formats,
  info,
  num = "0x01",
  onFiles,
  patchHint,
  romHint,
  supported,
  title = "Inputs",
  ...dropZoneProps
}: UnifiedDropZoneProps) => {
  const emit = (files: File[]) => {
    // Open the perceived-latency window: a drop/selection just began, measured against the first wasm
    // progress event (see lib/perf/op-perf-marks.ts → romweaver:before-start).
    markDropReceived();
    logger.trace("unified drop zone received files", {
      count: files.length,
      names: files.map((file) => file.name),
    });
    onFiles(files);
  };
  const joinedHint = joinHintParts([romHint, patchHint, archiveHint].filter((part): part is string => !!part));
  const hint = joinedHint && supported?.length ? `${joinedHint} — and many more` : joinedHint;
  const popover =
    info || supported?.length ? (
      <InfoPopover title="Input handling">
        {info}
        {supported?.length ? (
          <div className="info-support">
            {supported.map((group) => (
              <p key={group.label}>
                <b>{group.label}</b> <span className="mono">{group.extensions.join(", ")}</span>
              </p>
            ))}
          </div>
        ) : null}
      </InfoPopover>
    ) : undefined;
  return (
    <StepSection
      className={
        dropZoneProps.big ? "is-input is-empty unified-drop-step unified-drop-step--hero" : "is-input unified-drop-step"
      }
      info={popover}
      num={num}
      title={title}
    >
      <DropZone {...dropZoneProps} bare formats={formats} hint={hint} multiple onFiles={emit} />
      {afterDropZone}
    </StepSection>
  );
};

export { UnifiedDropZone };
