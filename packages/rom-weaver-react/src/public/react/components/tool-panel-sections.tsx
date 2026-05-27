import UploadIcon from "lucide-react/dist/esm/icons/upload.js";
import { type ChangeEvent, type ComponentProps, type ReactNode, useRef } from "react";
import {
  fileInputClassName,
  InputProgress,
  patchUploadCellClassName,
  patchUploadRowClassName,
  SectionTiming,
} from "../patcher-react-shared.tsx";
import { buttonClasses, cx, formClasses, layoutClasses, rowClasses } from "../tailwind-classes";
import { PatcherFileStack, PatcherFileStackRemoveButton, PatcherFileStackRow } from "./patcher-file-stack.tsx";
import { ProgressActionButton } from "./progress-action-button.tsx";

const TRAILING_COLON_REGEX = /:$/;

function ToolOutputFileRow({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (nextValue: string) => void;
}) {
  return (
    <div className={rowClasses.output}>
      <div className={rowClasses.outputLabel}>
        <label htmlFor={id}>{label}</label>
      </div>
      <div className={rowClasses.outputValue}>
        <input
          className={cx(formClasses.base, formClasses.disabled)}
          disabled={disabled}
          id={id}
          onChange={(event) => onChange(event.currentTarget.value)}
          type="text"
          value={value}
        />
      </div>
    </div>
  );
}

function ToolActionSection({
  actionLabel,
  disabled,
  onAction,
  progress,
  secondaryAction,
  actionId,
}: {
  actionId?: string;
  actionLabel: string;
  disabled: boolean;
  onAction: () => void;
  progress: ComponentProps<typeof ProgressActionButton>["progress"];
  secondaryAction?: ReactNode;
}) {
  return (
    <div className={layoutClasses.spacedStack}>
      <ProgressActionButton
        disabled={disabled}
        id={actionId}
        label={actionLabel}
        onClick={onAction}
        progress={progress}
      />
      {secondaryAction}
    </div>
  );
}

function ToolFileInputStack({
  ariaLabel,
  disabled,
  emptyText,
  fileNames,
  id,
  label,
  multiple,
  onChange,
  onClear,
  progress,
  timing,
}: {
  ariaLabel: string;
  disabled?: boolean;
  emptyText: string;
  fileNames: string[];
  id: string;
  label: string;
  multiple?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  progress?: ComponentProps<typeof InputProgress>["progress"];
  timing?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hasFiles = fileNames.length > 0;
  const inputState = {
    disabled: !!disabled,
    invalid: false,
    loading: !!progress,
    progress: progress || null,
    valid: hasFiles,
  };
  const progressBlocksInput = !!progress;
  return (
    <div className={rowClasses.upload}>
      <div className={rowClasses.uploadLabel}>
        <label htmlFor={id}>{label}</label>
      </div>
      <div className={cx("rom-weaver-container-input", layoutClasses.containerInputFill)}>
        <div
          className={cx("rom-weaver-input-section-header", "mb-1 text-[13px] font-bold leading-[1.3] text-[#4f5757]")}
        >
          <div className="relative inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-[6px] gap-y-[2px]">
            <div className="inline-flex flex-none items-center gap-[6px] whitespace-nowrap">
              <span>{label.replace(TRAILING_COLON_REGEX, "")}</span>
            </div>
            <SectionTiming
              className="flex-[1_1_auto] whitespace-normal [overflow-wrap:anywhere]"
              id={`${id}-timing`}
              value={timing || ""}
            />
          </div>
        </div>
        <input
          className={fileInputClassName(inputState)}
          disabled={disabled}
          id={id}
          multiple={multiple}
          onChange={onChange}
          ref={inputRef}
          type="file"
        />
        <PatcherFileStack
          ariaLabel={ariaLabel}
          className="rom-weaver-input-stack"
          footer={
            progressBlocksInput || !hasFiles ? (
              <tfoot>
                <tr
                  aria-busy={progressBlocksInput}
                  className={patchUploadRowClassName(inputState)}
                  onClick={(event) => {
                    const target = event.target as HTMLElement | null;
                    if (progressBlocksInput || disabled) return;
                    if (target?.closest("input,label,button,select,a,summary")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    inputRef.current?.click();
                  }}
                  title={emptyText}
                >
                  {progressBlocksInput ? (
                    <td
                      className={cx(
                        patchUploadCellClassName(inputState),
                        "rom-weaver-patch-stack-progress",
                        "relative !p-0 text-left no-underline",
                      )}
                      colSpan={2}
                    >
                      <InputProgress id={`${id}-progress`} progress={progress} />
                    </td>
                  ) : (
                    <td
                      className={cx(
                        patchUploadCellClassName(inputState),
                        "rom-weaver-patch-stack-empty",
                        "relative text-[length:var(--rom-weaver-control-font-size)] leading-[var(--rom-weaver-control-line-height)] text-[var(--rom-weaver-color-muted)] underline underline-offset-2",
                      )}
                      colSpan={2}
                    >
                      <label
                        className="rom-weaver-rom-upload-label rom-weaver-patch-upload-label-inline-icon flex h-full w-full min-w-0 cursor-inherit items-center gap-[6px] [overflow-wrap:anywhere]"
                        htmlFor={id}
                      >
                        <UploadIcon className={buttonClasses.icon} />
                        {emptyText}
                      </label>
                    </td>
                  )}
                </tr>
              </tfoot>
            ) : null
          }
          id={`${id}-stack`}
          listId={`${id}-stack-list`}
        >
          {hasFiles && !progressBlocksInput
            ? fileNames.map((fileName, index) => (
                <PatcherFileStackRow
                  className="rom-weaver-input-stack-item"
                  controls={
                    index === 0 ? (
                      <PatcherFileStackRemoveButton
                        ariaLabel={`Clear ${label.replace(TRAILING_COLON_REGEX, "")}`}
                        disabled={disabled}
                        onClick={onClear}
                        title={`Clear ${label.replace(TRAILING_COLON_REGEX, "")}`}
                      />
                    ) : null
                  }
                  fileClassName="rom-weaver-input-stack-file"
                  fileName={fileName}
                  key={fileName}
                  nameClassName="rom-weaver-input-stack-name"
                />
              ))
            : null}
        </PatcherFileStack>
      </div>
    </div>
  );
}

export { ToolActionSection, ToolFileInputStack, ToolOutputFileRow };
