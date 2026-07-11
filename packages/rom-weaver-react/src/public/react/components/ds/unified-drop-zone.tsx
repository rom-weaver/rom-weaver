import type { ReactNode } from "react";
import { createLogger } from "../../../../lib/logging.ts";
import { markDropReceived } from "../../../../lib/perf/op-perf-marks.ts";
import { DropZone, InfoPopover, StepSection } from "./layout.tsx";

/**
 * The 0x01 INPUTS step - the single combined drop surface shared by every
 * workflow tab. A hero drop target while the form is empty, shrinking to the
 * compact add-row once files are staged. Always accepts multiple files,
 * traces what it receives, and lists every supported format. Routing is decided
 * by the per-tab caller (see `unified-drop-routing.ts`).
 */

const logger = createLogger("unified-drop-zone");

type SupportedFileGroup = {
  label: string;
  extensions: readonly string[];
};

type UnifiedDropZoneProps = {
  label: ReactNode;
  labelCoarse?: ReactNode;
  big?: boolean;
  disabled?: boolean;
  accept?: string;
  id?: string;
  inputId?: string;
  /** Extra content for the step-header info popover (above the supported-file lists). */
  info?: ReactNode;
  /** Full per-bucket extension support, listed in the hero ticker and info popover. */
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
  info,
  num = "0x01",
  onFiles,
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
  const formats = [...new Set(supported?.flatMap((group) => group.extensions) || [])];
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
      <DropZone {...dropZoneProps} bare formats={formats} multiple onFiles={emit} />
      {afterDropZone}
    </StepSection>
  );
};

export { UnifiedDropZone };
