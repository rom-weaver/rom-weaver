import type { ReactNode } from "react";
import { createLogger } from "../../../../lib/logging.ts";
import { DropZone, StepSection } from "./layout.tsx";

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
  /** Step header info popover. */
  info?: ReactNode;
  /** Step number/title; the inputs step is 0x01 in every workflow. */
  num?: string;
  title?: ReactNode;
  onFiles: (files: File[]) => void;
};

const UnifiedDropZone = ({
  archiveHint,
  formats,
  info,
  num = "0x01",
  onFiles,
  patchHint,
  romHint,
  title = "Inputs",
  ...dropZoneProps
}: UnifiedDropZoneProps) => {
  const emit = (files: File[]) => {
    logger.trace("unified drop zone received files", {
      count: files.length,
      names: files.map((file) => file.name),
    });
    onFiles(files);
  };
  const hint = joinHintParts([romHint, patchHint, archiveHint].filter((part): part is string => !!part));
  return (
    <StepSection
      className={
        dropZoneProps.big ? "is-input is-empty unified-drop-step unified-drop-step--hero" : "is-input unified-drop-step"
      }
      info={info}
      num={num}
      title={title}
    >
      <DropZone {...dropZoneProps} bare formats={formats} hint={hint} multiple onFiles={emit} />
    </StepSection>
  );
};

export type { UnifiedDropZoneProps };
export { UnifiedDropZone };
