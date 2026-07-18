import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime-types.ts";
import { emitTraceLog } from "../logging.ts";

type WorkflowTraceOptions = ApplyWorkflowOptions | CreateWorkflowOptions | undefined;
type WorkflowTraceMessage = "stage.fail" | "stage.finish" | "stage.skip" | "stage.start";
type WorkflowTraceName = "apply" | "create" | "trim";
type WorkflowTraceLog = NonNullable<Exclude<WorkflowTraceOptions, undefined>["onLog"]>;
type WorkflowControllerTraceContext = {
  logLevel?: string;
  onLog?: WorkflowTraceLog;
  workflow: WorkflowTraceName;
  workflowId?: string;
};

const createWorkflowTracer = (workflow: WorkflowTraceName) => {
  const traceWorkflowStage = (
    options: WorkflowTraceOptions,
    message: WorkflowTraceMessage,
    stage: string,
    role: string | undefined,
    details: Record<string, unknown> = {},
  ) => {
    if (options?.logging?.level !== "trace") return;
    emitTraceLog({ logLevel: "trace", namespace: `workflow:${workflow}`, onLog: options.onLog }, message, {
      ...details,
      operation: "run",
      operationId: options.trace?.operationId,
      role,
      stage,
      workflow: options.trace?.workflow || workflow,
      workflowId: options.trace?.workflowId,
    });
  };

  const traceWorkflowStageBlock = async <TResult>(
    options: WorkflowTraceOptions,
    stage: string,
    role: string | undefined,
    callback: () => Promise<TResult>,
    details: () => Record<string, unknown> = () => ({}),
  ) => {
    const startedAt = Date.now();
    traceWorkflowStage(options, "stage.start", stage, role, details());
    try {
      const result = await callback();
      traceWorkflowStage(options, "stage.finish", stage, role, {
        ...details(),
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      traceWorkflowStage(options, "stage.fail", stage, role, {
        ...details(),
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  };

  return { traceWorkflowStage, traceWorkflowStageBlock };
};

const traceWorkflowControllerEvent = (
  context: WorkflowControllerTraceContext,
  message: string,
  details: Record<string, unknown> = {},
) => {
  if (context.logLevel !== "trace") return;
  emitTraceLog({ logLevel: "trace", namespace: `workflow:${context.workflow}`, onLog: context.onLog }, message, {
    ...details,
    workflow: context.workflow,
    workflowId: context.workflowId,
  });
};

export { createWorkflowTracer, traceWorkflowControllerEvent };
