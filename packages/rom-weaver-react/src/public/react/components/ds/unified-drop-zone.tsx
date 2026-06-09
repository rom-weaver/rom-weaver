import { type ReactNode, useId } from "react";
import { createLogger } from "../../../../lib/logging.ts";
import { DropZone } from "./layout.tsx";

/**
 * The single combined drop surface shared by every workflow tab. It is a thin
 * wrapper over the {@link DropZone} primitive that always accepts multiple
 * files and traces what it receives; the per-tab caller decides how the files
 * are classified and routed (see `unified-drop-routing.ts`).
 *
 * Alongside the file picker it offers a "pick a folder" affordance backed by a
 * `webkitdirectory` input, so a directory of ROMs/patches can be added by click
 * as well as by drag-and-drop (the drop path recurses folders in `DropZone`).
 */

const logger = createLogger("unified-drop-zone");

// Folder picks include OS junk like `.DS_Store`; drop hidden files to match the
// drag-and-drop traversal (see readDataTransferFiles).
const isHiddenName = (name: string) => name.startsWith(".");

// `webkitdirectory`/`directory` are not in the standard input attribute types,
// so set them via a ref instead of disabling the type checker.
const setDirectoryInputAttributes = (node: HTMLInputElement | null) => {
  if (!node) return;
  node.setAttribute("webkitdirectory", "");
  node.setAttribute("directory", "");
};

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

const UnifiedDropZone = ({ onFiles, ...dropZoneProps }: UnifiedDropZoneProps) => {
  const generatedId = useId();
  const folderInputId = `${dropZoneProps.inputId || generatedId}-folder`;
  const emit = (files: File[]) => {
    logger.trace("unified drop zone received files", {
      count: files.length,
      names: files.map((file) => file.name),
    });
    onFiles(files);
  };
  return (
    <div className="unified-drop">
      <DropZone {...dropZoneProps} multiple onFiles={emit} />
      <div className="unified-drop-actions">
        <label className="btn ghost" htmlFor={folderInputId}>
          Pick a folder
        </label>
        <input
          className="absolute h-px w-px overflow-hidden opacity-0"
          disabled={dropZoneProps.disabled}
          id={folderInputId}
          multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files || []).filter((file) => !isHiddenName(file.name));
            event.currentTarget.value = "";
            if (files.length) emit(files);
          }}
          ref={setDirectoryInputAttributes}
          type="file"
        />
      </div>
    </div>
  );
};

export type { UnifiedDropZoneProps };
export { UnifiedDropZone };
