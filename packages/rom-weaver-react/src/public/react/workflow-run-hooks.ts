import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowProgress } from "../../platform/browser/browser-api.ts";
import { createProgressViewModelFromEvent } from "../../presentation/workflow-presentation.ts";
import type { FileProgressProps } from "./components/ds/feedback.tsx";
import { toReactProgressEvent } from "./workflow-adapters.ts";

type ReactWorkflowProgress = ReturnType<typeof toReactProgressEvent>;
type WorkflowProgressCallback = (event: ReactWorkflowProgress) => void;
type WorkflowFormProgressState = ReturnType<typeof createProgressViewModelFromEvent> & {
  role?: string;
};
type DisposableOutputCleanup = () => Promise<void> | void;
type WorkflowFileProgressInput = {
  indeterminate?: boolean;
  label?: string;
  message?: string;
  percent?: number | null;
  value?: string;
  visualPercent?: number | null;
};

const WAITING_FOR_OTHER_ACTIONS_LABEL = "Waiting for other actions...";

const createWaitingWorkflowProgress = (): WorkflowFileProgressInput => ({
  indeterminate: true,
  label: WAITING_FOR_OTHER_ACTIONS_LABEL,
  message: WAITING_FOR_OTHER_ACTIONS_LABEL,
  percent: null,
  value: "waiting",
});

const createWorkflowFormProgress = (event: WorkflowProgress, fallbackStage: string): WorkflowFormProgressState => ({
  ...createProgressViewModelFromEvent(event, { stage: event.stage || fallbackStage }),
  role: typeof event.role === "string" ? event.role : undefined,
});

const createIndeterminateWorkflowProgress = ({
  label,
  role,
  stage,
}: {
  label: string;
  role?: string;
  stage: string;
}): WorkflowFormProgressState => ({
  ...createProgressViewModelFromEvent(
    {
      hasProgress: true,
      label,
      message: label,
      percent: null,
      stage,
    },
    { stage },
  ),
  role,
});

const toWorkflowFileProgressProps = (
  progress: WorkflowFileProgressInput | null | undefined,
): FileProgressProps | null => {
  if (!progress) return null;
  const percent =
    typeof progress.visualPercent === "number"
      ? progress.visualPercent
      : typeof progress.percent === "number"
        ? progress.percent
        : null;
  return {
    indeterminate: percent === null,
    label: progress.label || progress.message || "Working…",
    percent,
    value: progress.value || (typeof progress.percent === "number" ? `${Math.round(progress.percent)}%` : "working"),
  };
};

const toWorkflowChecksumProgressProps = (
  progress: WorkflowFileProgressInput | null | undefined,
): FileProgressProps | null => {
  const props = toWorkflowFileProgressProps(progress);
  if (!props) return null;
  const label = progress?.label || progress?.message || "Checksum";
  return {
    ...props,
    label: /^checksum\b/i.test(label) ? label : `Checksum ${label}`,
  };
};

const useWorkflowProgressState = ({ onProgress }: { onProgress?: WorkflowProgressCallback }) => {
  const [progress, setProgress] = useState<WorkflowFormProgressState | null>(null);
  const onProgressRef = useRef(onProgress);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  const reportProgressEvent = useCallback((event: WorkflowProgress, fallbackStage: string) => {
    onProgressRef.current?.(toReactProgressEvent(event));
    setProgress(createWorkflowFormProgress(event, fallbackStage));
  }, []);

  const createProgressHandler = useCallback(
    (fallbackStage: string) => (event: WorkflowProgress) => reportProgressEvent(event, fallbackStage),
    [reportProgressEvent],
  );

  const clearProgressForStage = useCallback((stage: string) => {
    setProgress((current) => (current?.stage === stage ? null : current));
  }, []);

  return {
    clearProgressForStage,
    createProgressHandler,
    progress,
    reportProgressEvent,
    setProgress,
  };
};

const useDisposableCleanup = () => {
  const activeCleanupRef = useRef<DisposableOutputCleanup | null>(null);

  const disposeActiveCleanup = useCallback(() => {
    const dispose = activeCleanupRef.current;
    activeCleanupRef.current = null;
    if (dispose) void Promise.resolve(dispose()).catch(() => undefined);
  }, []);

  const rememberActiveCleanup = useCallback((cleanup: DisposableOutputCleanup | null | undefined) => {
    activeCleanupRef.current = cleanup || null;
  }, []);

  return {
    activeCleanupRef,
    disposeActiveCleanup,
    rememberActiveCleanup,
  };
};

const useDisposableWorkflowOutput = <TOutput>(): {
  clearCompletedOutput: () => void;
  completedOutput: TOutput | null;
  disposeActiveOutput: () => void;
  rememberOutputDispose: (cleanup: DisposableOutputCleanup | null | undefined) => void;
  setCompletedOutput: Dispatch<SetStateAction<TOutput | null>>;
} => {
  const [completedOutput, setCompletedOutput] = useState<TOutput | null>(null);
  const { disposeActiveCleanup: disposeActiveOutput, rememberActiveCleanup: rememberOutputDispose } =
    useDisposableCleanup();

  const clearCompletedOutput = useCallback(() => {
    setCompletedOutput(null);
  }, []);

  return {
    clearCompletedOutput,
    completedOutput,
    disposeActiveOutput,
    rememberOutputDispose,
    setCompletedOutput,
  };
};

const useActiveAbortController = () => {
  const activeAbortControllerRef = useRef<AbortController | null>(null);

  const abortActiveOperation = useCallback(() => {
    activeAbortControllerRef.current?.abort();
  }, []);

  const rememberAbortController = useCallback((abortController: AbortController | null) => {
    activeAbortControllerRef.current = abortController;
  }, []);

  return {
    abortActiveOperation,
    activeAbortControllerRef,
    rememberAbortController,
  };
};

export type { WorkflowFormProgressState };
export {
  createIndeterminateWorkflowProgress,
  createWaitingWorkflowProgress,
  toWorkflowChecksumProgressProps,
  toWorkflowFileProgressProps,
  useActiveAbortController,
  useDisposableCleanup,
  useDisposableWorkflowOutput,
  useWorkflowProgressState,
};
