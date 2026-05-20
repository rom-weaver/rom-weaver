import X from "lucide-react/dist/esm/icons/x.js";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { createTiming, formatTiming } from "../../../lib/progress/timing.ts";
import { formatByteSize } from "../../../presentation/workflow-presentation.ts";
import type { ArchivePathEntry, PatchStackState } from "../patcher-presentation.ts";
import { InputProgress } from "../patcher-react-shared.tsx";
import { cx, patchStackClasses } from "../tailwind-classes";

type PatchStackController = {
  subscribe: (listener: () => void) => () => void;
  getState: () => PatchStackState;
  removeItem: (index: number) => void;
};

const formatArchiveStepDetail = (entry: ArchivePathEntry, fallbackSize?: number) => {
  const currentSize =
    formatByteSize(entry.sourceSize) || formatByteSize(entry.outputSize) || formatByteSize(fallbackSize);
  const timing =
    typeof entry.decompressionTimeMs === "number" && Number.isFinite(entry.decompressionTimeMs)
      ? formatTiming(createTiming(entry.decompressionTimeMs))
      : "";
  return [currentSize, timing ? `time: ${timing}` : ""].filter(Boolean).join(", ");
};

const buildArchiveStepDetails = (
  entries: ArchivePathEntry[] | undefined,
  finalFileName: string,
  finalFileSize?: number,
) => {
  if (!entries?.length) return [];
  const filteredEntries = entries.filter((entry) => !!entry.fileName);
  const steps = filteredEntries.map<{ fileName: string; detail: string }>((entry, index) => {
    const nextEntry = filteredEntries[index + 1];
    const inferredSize =
      typeof nextEntry?.sourceSize === "number" && Number.isFinite(nextEntry.sourceSize)
        ? nextEntry.sourceSize
        : undefined;
    const detail = formatArchiveStepDetail(entry, inferredSize);
    return { detail, fileName: entry.fileName };
  });
  const lastStep = steps[steps.length - 1];
  if (finalFileName && (!lastStep || lastStep.fileName !== finalFileName)) {
    const finalSize = formatByteSize(finalFileSize);
    steps.push({ detail: finalSize, fileName: finalFileName });
  }
  return steps;
};

const renderArchiveStepDetails = (
  entries: ArchivePathEntry[] | undefined,
  finalFileName: string,
  finalFileSize?: number,
) => {
  const steps = buildArchiveStepDetails(entries, finalFileName, finalFileSize);
  if (!steps.length) return null;
  const lastIndex = steps.length - 1;
  return (
    <div className="space-y-0.5">
      {steps.map((step, index) => {
        const text = step.detail ? `${step.fileName} (${step.detail})` : step.fileName;
        return (
          <div key={`${step.fileName}-${index}`} style={{ paddingLeft: `${index * 0.45}rem` }}>
            {index === lastIndex ? <strong>{text}</strong> : <span>{text}</span>}
          </div>
        );
      })}
    </div>
  );
};

const getArchiveLabel = (
  archiveFileName: string | null | undefined,
  archivePathEntries: ArchivePathEntry[] | undefined,
) => {
  if (archiveFileName) return archiveFileName;
  if (!archivePathEntries?.length) return "";
  return archivePathEntries
    .map((entry) => String(entry.fileName || "").trim())
    .filter(Boolean)
    .join(" > ");
};

const resolveDisplayFileName = (
  fileName: string,
  archiveFileName: string | null | undefined,
  archivePathEntries: ArchivePathEntry[] | undefined,
) => {
  const normalizedFileName = String(fileName || "").trim();
  const normalizedArchiveFileName = String(archiveFileName || "").trim();
  const archiveSegments = archivePathEntries?.map((entry) => String(entry.fileName || "").trim()).filter(Boolean);
  const archiveLeaf = archiveSegments?.length ? archiveSegments[archiveSegments.length - 1] : "";
  if (
    normalizedArchiveFileName &&
    normalizedFileName === normalizedArchiveFileName &&
    archiveLeaf &&
    archiveLeaf !== normalizedArchiveFileName
  ) {
    return archiveLeaf;
  }
  return normalizedFileName;
};

function PatcherFileStack({
  ariaLabel,
  children,
  className,
  footer,
  id,
  listId,
}: {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
  id: string;
  listId?: string;
}) {
  return (
    <table aria-label={ariaLabel} className={cx(className, patchStackClasses.table)} id={id}>
      <colgroup>
        <col />
        <col className={cx("rom-weaver-patch-stack-controls-col", patchStackClasses.controlsCol)} />
      </colgroup>
      <tbody id={listId}>{children}</tbody>
      {footer}
    </table>
  );
}

function PatcherFileStackRow({
  archiveFileName,
  children,
  className,
  controls,
  fileClassName,
  fileName,
  fileSize,
  nameClassName,
  detailText,
  archivePathEntries,
}: {
  archiveFileName?: string | null;
  children?: ReactNode;
  className?: string;
  controls?: ReactNode;
  detailText?: string | null;
  archivePathEntries?: ArchivePathEntry[];
  fileClassName?: string;
  fileName: string;
  fileSize?: number;
  nameClassName?: string;
}) {
  const archiveLabel = getArchiveLabel(archiveFileName, archivePathEntries);
  const displayFileName = resolveDisplayFileName(fileName, archiveFileName, archivePathEntries);
  const archiveStepDetails = renderArchiveStepDetails(archivePathEntries, fileName, fileSize);
  return (
    <tr className={className}>
      <td
        className={cx(patchStackClasses.cell, nameClassName, patchStackClasses.nameCell, "relative pr-9")}
        colSpan={2}
      >
        <div className={cx(fileClassName, patchStackClasses.fileBlock)}>{displayFileName}</div>
        {archiveLabel ? (
          <div className={cx("rom-weaver-patch-stack-archive", patchStackClasses.details)}>{archiveLabel}</div>
        ) : null}
        {archiveStepDetails ? (
          <div className={cx("rom-weaver-patch-stack-archive-steps", patchStackClasses.details)}>
            {archiveStepDetails}
          </div>
        ) : null}
        {controls ? <div className="absolute top-1.5 right-1.5">{controls}</div> : null}
        {detailText ? (
          <div className={cx("rom-weaver-patch-stack-details", patchStackClasses.details)}>{detailText}</div>
        ) : null}
        {children}
      </td>
    </tr>
  );
}

function PatcherFileStackRemoveButton({
  ariaLabel,
  className,
  disabled,
  onClick,
  title,
}: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      aria-label={ariaLabel}
      className={cx(
        "rom-weaver-patch-stack-button rom-weaver-patch-stack-button-inline-icon rom-weaver-patch-stack-button-remove",
        patchStackClasses.button,
        patchStackClasses.removeButton,
        className,
      )}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      <X aria-hidden="true" className={patchStackClasses.buttonIcon} />
    </button>
  );
}

function PatcherPatchStackRows({ controller }: { controller: PatchStackController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  return (
    <>
      {state.items.map((item, index) => (
        <PatcherFileStackRow
          archiveFileName={item.archiveFileName}
          archivePathEntries={item.archivePathEntries}
          className={cx(
            "rom-weaver-patch-stack-item",
            item.validationState && `validation-${item.validationState}`,
            item.validationState === "valid" && patchStackClasses.rowValidationValid,
            item.validationState === "invalid" && patchStackClasses.rowValidationInvalid,
          )}
          controls={
            <PatcherFileStackRemoveButton
              ariaLabel="Remove patch"
              disabled={!item.canRemove}
              onClick={() => controller.removeItem(index)}
              title="Remove patch"
            />
          }
          detailText={item.detailText}
          fileClassName="rom-weaver-patch-stack-file"
          fileName={item.fileName}
          fileSize={item.fileSize}
          key={item.key || `${item.archiveFileName}:${item.fileName}`}
          nameClassName="rom-weaver-patch-stack-name"
        >
          {item.validationState ? (
            <div
              className={cx(
                "rom-weaver-patch-stack-validation",
                item.validationState,
                patchStackClasses.validation,
                item.validationState === "valid"
                  ? patchStackClasses.validationValid
                  : (() => {
                      if (item.validationState === "invalid") {
                        return patchStackClasses.validationInvalid;
                      }
                      return patchStackClasses.validationPending;
                    })(),
              )}
            >
              <div className="rom-weaver-patch-stack-validation-required">
                {item.validationLabel}{" "}
                {item.validationValues.map((value, valueIndex) => (
                  <span key={`${item.fileName}-${item.validationLabel}-${value}`}>
                    {valueIndex > 0 ? ", " : null}
                    <code className={patchStackClasses.validationCode}>{value}</code>
                  </span>
                ))}
              </div>
              <div className="rom-weaver-patch-stack-validation-status">
                {item.validationMessage}
                {item.validationActualValue ? (
                  <>
                    {": "}
                    <code className={patchStackClasses.validationCode}>{item.validationActualValue}</code>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
          {item.progress ? (
            <div className="relative mt-2 min-h-[calc(var(--rom-weaver-control-height)-2px)]">
              <InputProgress
                id={index === 0 ? "rom-weaver-progress-patch" : `rom-weaver-progress-patch-${index + 1}`}
                progress={item.progress}
              />
            </div>
          ) : null}
        </PatcherFileStackRow>
      ))}
    </>
  );
}

export { PatcherFileStack, PatcherFileStackRemoveButton, PatcherFileStackRow, PatcherPatchStackRows };
