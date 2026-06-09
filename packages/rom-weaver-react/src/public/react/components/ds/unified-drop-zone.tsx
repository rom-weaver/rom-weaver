import type { ReactNode } from "react";
import { createLogger } from "../../../../lib/logging.ts";
import { DropZone } from "./layout.tsx";

/**
 * The single combined drop surface shared by every workflow tab. It is a thin
 * wrapper over the {@link DropZone} primitive that always accepts multiple
 * files and traces what it receives; the per-tab caller decides how the files
 * are classified and routed (see `unified-drop-routing.ts`).
 */

const logger = createLogger("unified-drop-zone");

type UnifiedDropZoneProps = {
  label: ReactNode;
  hint?: ReactNode;
  big?: boolean;
  disabled?: boolean;
  accept?: string;
  id?: string;
  inputId?: string;
  onFiles: (files: File[]) => void;
};

const UnifiedDropZone = ({ onFiles, ...dropZoneProps }: UnifiedDropZoneProps) => (
  <DropZone
    {...dropZoneProps}
    multiple
    onFiles={(files) => {
      logger.trace("unified drop zone received files", {
        count: files.length,
        names: files.map((file) => file.name),
      });
      onFiles(files);
    }}
  />
);

export type { UnifiedDropZoneProps };
export { UnifiedDropZone };
