import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime-types.ts";

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
    options.onLog?.({
      details: {
        ...details,
        operation: "run",
        operationId: options.trace?.operationId,
        role,
        stage,
        workflow: options.trace?.workflow || workflow,
        workflowId: options.trace?.workflowId,
      },
      level: "trace",
      message,
      namespace: `workflow:${workflow}`,
      timestamp: new Date().toISOString(),
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
  context.onLog?.({
    details: {
      ...details,
      workflow: context.workflow,
      workflowId: context.workflowId,
    },
    level: "trace",
    message,
    namespace: `workflow:${context.workflow}`,
    timestamp: new Date().toISOString(),
  });
};

export { createWorkflowTracer, traceWorkflowControllerEvent };
