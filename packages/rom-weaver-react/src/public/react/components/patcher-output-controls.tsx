import Download from "lucide-react/dist/esm/icons/download.js";
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { RunButton } from "../components/ds/feedback.tsx";
import type { PatcherOutputState } from "../patcher-presentation.ts";
import { buttonClasses, cx, formClasses } from "../tailwind-classes";
import { ApplyBandaidIcon } from "./apply-bandaid-icon.tsx";
import { ProgressActionButton } from "./progress-action-button.tsx";

type OutputController = {
  subscribe: (listener: () => void) => () => void;
  getState: () => PatcherOutputState;
  setDisplayFileName: (value: string) => void;
  setOutputCompression: (value: string) => void;
  runPrimaryAction: () => void;
};

const DEFAULT_CONTROL_HEIGHT_PX = 46;
const DEFAULT_FONT_SIZE_PX = 13;
const DEFAULT_VERTICAL_PADDING_PX = 8;

const parsePixelValue = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resizeOutputNameTextarea = (textarea: HTMLTextAreaElement | null) => {
  if (!textarea || typeof window === "undefined") return;
  const computedStyle = window.getComputedStyle(textarea);
  const controlHeight = parsePixelValue(
    computedStyle.getPropertyValue("--rom-weaver-control-height"),
    DEFAULT_CONTROL_HEIGHT_PX,
  );
  const defaultPaddingTop = textarea.dataset.defaultPaddingTop || computedStyle.paddingTop;
  const defaultPaddingBottom = textarea.dataset.defaultPaddingBottom || computedStyle.paddingBottom;
  textarea.dataset.defaultPaddingTop = defaultPaddingTop;
  textarea.dataset.defaultPaddingBottom = defaultPaddingBottom;
  const defaultPaddingTopPx = parsePixelValue(defaultPaddingTop, DEFAULT_VERTICAL_PADDING_PX);
  const defaultPaddingBottomPx = parsePixelValue(defaultPaddingBottom, DEFAULT_VERTICAL_PADDING_PX);
  const fontSizePx = parsePixelValue(computedStyle.fontSize, DEFAULT_FONT_SIZE_PX);
  const lineHeightPx = parsePixelValue(computedStyle.lineHeight, fontSizePx * 1.24);
  const borderHeight =
    parsePixelValue(computedStyle.borderTopWidth, 0) + parsePixelValue(computedStyle.borderBottomWidth, 0);

  textarea.style.paddingTop = `${defaultPaddingTopPx}px`;
  textarea.style.paddingBottom = `${defaultPaddingBottomPx}px`;
  textarea.style.height = "auto";
  const centeredPaddingPx = Math.max(defaultPaddingTopPx, (controlHeight - borderHeight - lineHeightPx) / 2);
  if (textarea.scrollHeight + borderHeight <= controlHeight + 0.5) {
    const centeredPadding = `${Math.max(0, centeredPaddingPx)}px`;
    textarea.style.paddingTop = centeredPadding;
    textarea.style.paddingBottom = centeredPadding;
    textarea.style.height = "auto";
  }
  const nextHeight = Math.max(controlHeight, textarea.scrollHeight + borderHeight);
  textarea.style.height = `${Math.ceil(nextHeight)}px`;
};

function PatcherOutputControls({ controller }: { controller: OutputController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const syncTextareaHeight = useCallback((textarea: HTMLTextAreaElement | null = textareaRef.current) => {
    resizeOutputNameTextarea(textarea);
  }, []);

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [state.displayFileName, syncTextareaHeight]);

  return (
    <>
      <textarea
        className={cx(
          formClasses.textarea,
          'block min-h-[var(--rom-weaver-control-height)] min-w-0 flex-[1_1_auto] resize-none overflow-hidden whitespace-pre-wrap break-words font-["Inter_Tight","Segoe_UI",sans-serif] text-[length:var(--rom-weaver-control-font-size)] leading-[var(--rom-weaver-control-line-height)] [overflow-wrap:anywhere] disabled:opacity-100',
        )}
        disabled={state.disabled}
        id="rom-weaver-input-output-file-name"
        onChange={(event) => {
          syncTextareaHeight(event.currentTarget);
          controller.setDisplayFileName(event.currentTarget.value);
        }}
        ref={textareaRef}
        rows={1}
        spellCheck={false}
        value={state.displayFileName}
      />
      <select
        aria-label="Output format"
        className={cx(
          formClasses.select,
          "w-[68px] flex-[0_0_68px] px-2 pr-4 text-left text-[length:var(--rom-weaver-control-font-size)] leading-[var(--rom-weaver-control-line-height)] disabled:opacity-100",
        )}
        disabled={state.disabled}
        id="rom-weaver-select-output-format"
        onChange={(event) => controller.setOutputCompression(event.currentTarget.value)}
        title="Output format"
        value={state.compressionFormat}
      >
        {state.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </>
  );
}

function PatcherPrimaryAction({ controller }: { controller: OutputController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  if (state.pendingDownloadFileName && !state.applyButton.progress && !state.applyButton.loading) {
    return (
      <RunButton
        disabled={state.applyButton.disabled}
        download={{
          format: state.downloadSummary?.format ? `Patched ${state.downloadSummary.format}` : "Patched",
          size:
            state.downloadSummary?.size && state.downloadSummary?.ratio
              ? `${state.downloadSummary.size} (${state.downloadSummary.ratio})`
              : state.downloadSummary?.size || undefined,
        }}
        icon={<Download aria-hidden="true" className={buttonClasses.icon} />}
        id="rom-weaver-button-apply"
        onClick={() => controller.runPrimaryAction()}
      />
    );
  }

  return (
    <ProgressActionButton
      disabled={state.applyButton.disabled}
      icon={<ApplyBandaidIcon className={`${buttonClasses.icon} apply-button-icon`} />}
      id="rom-weaver-button-apply"
      label={state.applyButton.label}
      loading={state.applyButton.loading}
      onClick={() => controller.runPrimaryAction()}
      progress={state.applyButton.progress}
      progressId="rom-weaver-progress-apply"
    />
  );
}

export { PatcherOutputControls, PatcherPrimaryAction };
