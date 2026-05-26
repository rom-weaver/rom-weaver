import { type ReactNode, useSyncExternalStore } from "react";
import { clampProgressPercent, normalizeProgressDisplayPercent } from "../../presentation/workflow-presentation.ts";
import type { DialogController, NoticeController } from "./patcher-form.ts";
import type { InputProgressState, InputUiState, NoticeState } from "./patcher-ui-state.ts";
import { createEmptyNoticeState, createInitialDialogState } from "./patcher-ui-state.ts";
import {
  cx,
  dialogClasses,
  formClasses,
  noticeClasses,
  patchStackClasses,
  progressClasses,
  rowClasses,
  sectionClasses,
  uploadClasses,
} from "./tailwind-classes";

export { InfoToggle } from "../../presentation/react/info-toggle.tsx";

const inertNoticeState: NoticeState = createEmptyNoticeState();

const inertDialogState = (() => {
  const { open, title, entries } = createInitialDialogState();
  return { entries, open, title };
})();
const TRAILING_PROGRESS_PERCENT_REGEX = /\s+\d+(?:\.\d+)?%$/;
const TRAILING_ELLIPSIS_REGEX = /\s*\.\.\.$/;

const createStaticStoreController = <State,>(state: State) => ({
  getState: () => state,
  subscribe: () => () => undefined,
});

const resolveProgressPercent = (progress: NonNullable<InputProgressState>) => {
  const percent =
    typeof progress.visualPercent === "number" && Number.isFinite(progress.visualPercent)
      ? Math.max(0, Math.min(100, progress.visualPercent))
      : clampProgressPercent(progress.percent);
  return typeof percent === "number" ? `scaleX(${percent / 100})` : undefined;
};

const resolveProgressTextParts = (progress: NonNullable<InputProgressState>) => {
  const percent = normalizeProgressDisplayPercent(progress.percent);
  const baseText = String(progress.label || progress.message || "")
    .replace(TRAILING_PROGRESS_PERCENT_REGEX, "")
    .replace(TRAILING_ELLIPSIS_REGEX, "")
    .trim();
  const timingText =
    typeof progress.label === "string" &&
    progress.label &&
    typeof progress.timingText === "string" &&
    progress.timingText
      ? ` ${progress.timingText}`
      : "";
  return {
    percentText: typeof percent === "number" ? `${percent}%` : "",
    taskText: `${baseText}${timingText}`.trim(),
  };
};

const NoticeMessage = ({
  containerClassName,
  id,
  messageId,
  renderIcon,
  state,
}: {
  containerClassName?: string;
  id: string;
  messageId: string;
  renderIcon?: (level: string, className: string) => ReactNode;
  state: NoticeState;
}) => {
  if (!state.visible) return null;
  return (
    <div className={cx("show", rowClasses.message, containerClassName)} id={id}>
      <span className={cx(noticeClasses.message, state.level === "warning" && noticeClasses.warning)} id={messageId}>
        {renderIcon?.(state.level, noticeClasses.icon)}
        {state.message}
      </span>
    </div>
  );
};

export const fileInputClassName = (inputState?: InputUiState) =>
  cx(
    formClasses.nativeFile,
    formClasses.file,
    inputState?.loading && "loading",
    inputState?.valid && "valid",
    inputState?.invalid && "invalid",
  );

export const patchUploadRowClassName = (inputState?: InputUiState) =>
  cx(
    "group",
    "rom-weaver-patch-upload-row",
    uploadClasses.patchRow,
    inputState?.progress && uploadClasses.patchRowDisabled,
    inputState?.disabled && !inputState?.progress && uploadClasses.patchRowDisabled,
  );

export const patchUploadCellClassName = (inputState?: InputUiState) =>
  cx(
    patchStackClasses.cell,
    uploadClasses.patchCell,
    inputState?.progress && uploadClasses.patchCellProgress,
    inputState?.disabled && !inputState?.progress && uploadClasses.patchCellDisabled,
  );

export function InputProgress({ id, progress }: { id: string; progress: InputProgressState }) {
  if (!progress) return null;
  const textParts = resolveProgressTextParts(progress);
  const showProgressBar =
    typeof progress.percent === "number" ||
    (typeof progress.visualPercent === "number" && Number.isFinite(progress.visualPercent)) ||
    progress.indeterminate === true;
  return (
    <div className={cx("rom-weaver-input-progress", progressClasses.container)} id={id}>
      <span className={cx("rom-weaver-input-progress-text", progressClasses.text)} title={progress.message}>
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">{textParts.taskText}</span>
        {textParts.percentText ? (
          <span className="ml-2 flex-none text-right tabular-nums">{textParts.percentText}</span>
        ) : null}
      </span>
      {showProgressBar ? (
        <div className={cx("rom-weaver-input-progress-track", progressClasses.track)}>
          <div
            className={cx(
              "rom-weaver-input-progress-bar",
              progressClasses.bar,
              progress.indeterminate && progressClasses.barIndeterminate,
            )}
            style={{ transform: progress.indeterminate ? undefined : resolveProgressPercent(progress) }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function RuntimeNotice({
  controller,
  rowId,
  messageId,
  renderIcon,
}: {
  controller?: NoticeController;
  rowId: string;
  messageId: string;
  renderIcon?: (level: string, className: string) => ReactNode;
}) {
  const activeController = controller || createStaticStoreController(inertNoticeState);
  const state = useSyncExternalStore(activeController.subscribe, activeController.getState, activeController.getState);
  return <NoticeMessage id={rowId} messageId={messageId} renderIcon={renderIcon} state={state} />;
}

export function SectionNotice({
  id,
  messageId,
  renderIcon,
  state,
}: {
  id: string;
  messageId: string;
  renderIcon?: (level: string, className: string) => ReactNode;
  state: NoticeState;
}) {
  return (
    <NoticeMessage containerClassName="mt-1" id={id} messageId={messageId} renderIcon={renderIcon} state={state} />
  );
}

export function ArchiveDialog({ controller }: { controller?: DialogController }) {
  const activeController: DialogController = controller || createStaticStoreController(inertDialogState);
  const state = useSyncExternalStore(activeController.subscribe, activeController.getState, activeController.getState);
  return (
    <dialog className={dialogClasses.panel} data-testid="archive-dialog" id="rom-weaver-dialog-zip" open={state.open}>
      <div className={dialogClasses.message} id="rom-weaver-dialog-zip-message">
        {state.title}
      </div>
      <ul className={dialogClasses.list} id="rom-weaver-dialog-zip-file-list">
        {state.entries.map((entry) => (
          <li
            className={dialogClasses.listItem}
            key={entry.id}
            onMouseUp={(event) => {
              if (event.target !== event.currentTarget) return;
              activeController.selectEntry?.(entry.id);
            }}
          >
            <button
              className={dialogClasses.entryButton}
              onClick={() => activeController.selectEntry?.(entry.id)}
              title={entry.label}
              type="button"
            >
              {entry.label}
            </button>
          </li>
        ))}
      </ul>
    </dialog>
  );
}

export function SectionTiming({ id, value, className }: { id: string; value: string; className?: string }) {
  return (
    <span className={cx(sectionClasses.timing, className)} hidden={!value} id={id}>
      {value}
    </span>
  );
}
