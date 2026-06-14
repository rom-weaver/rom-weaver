import type { LogLevel, LogRecord } from "../../types/logging.ts";
import type { PublicOutput as RuntimePublicOutput } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";

type PublicOutput<TDestination> = {
  id: string;
  fileName: string;
  size?: number;
  storage: "blob" | "opfs" | "file";
  getBlob?: () => Promise<Blob>;
  saveAs: (destination?: TDestination) => Promise<void>;
  dispose: () => Promise<void>;
};

type OutputTraceOptions = {
  logLevel?: LogLevel;
  onLog?: (record: Pick<LogRecord, "details" | "level" | "message" | "namespace" | "timestamp">) => void;
  operationId?: string | null;
  workflow?: "apply" | "create" | "trim";
  workflowId?: string;
};

const canUseBlob = () => typeof Blob !== "undefined";

const getDestinationKind = (destination: unknown) => {
  if (!destination) return "default";
  if (typeof destination === "string") return "path";
  if (destination && typeof destination === "object" && "createWritable" in destination) return "fileHandle";
  if (destination && typeof destination === "object" && "fileHandle" in destination) return "fileHandle";
  if (destination && typeof destination === "object") return "descriptor";
  return typeof destination;
};

const traceOutputStage = (
  options: OutputTraceOptions | undefined,
  message: "stage.fail" | "stage.finish" | "stage.start",
  stage: "output.dispose" | "output.saveAs",
  details: Record<string, unknown>,
) => {
  if (options?.logLevel !== "trace") return;
  options.onLog?.({
    details: {
      ...details,
      operation: "output",
      operationId: options.operationId,
      role: "output",
      stage,
      workflow: options.workflow,
      workflowId: options.workflowId,
    },
    level: "trace",
    message,
    namespace: `workflow:${options.workflow || "output"}`,
    timestamp: new Date().toISOString(),
  });
};

const wrapPublicOutput = <TDestination>(
  output: RuntimePublicOutput,
  runtime: Pick<WorkflowRuntime, "publicOutput">,
  index = 0,
  traceOptions?: OutputTraceOptions,
): PublicOutput<TDestination> => {
  const publicOutput: PublicOutput<TDestination> = {
    dispose: async () => {
      const startedAt = Date.now();
      traceOutputStage(traceOptions, "stage.start", "output.dispose", {
        outputName: publicOutput.fileName,
        storage: publicOutput.storage,
      });
      try {
        await output.dispose();
        traceOutputStage(traceOptions, "stage.finish", "output.dispose", {
          durationMs: Date.now() - startedAt,
          outputName: publicOutput.fileName,
          storage: publicOutput.storage,
        });
      } catch (error) {
        traceOutputStage(traceOptions, "stage.fail", "output.dispose", {
          durationMs: Date.now() - startedAt,
          error,
          outputName: publicOutput.fileName,
          storage: publicOutput.storage,
        });
        throw error;
      }
    },
    fileName: output.fileName,
    getBlob: canUseBlob() ? () => runtime.publicOutput.getBlob(output) : undefined,
    id: `output-${index}-${output.fileName}`,
    saveAs: async (destination?: TDestination) => {
      const startedAt = Date.now();
      traceOutputStage(traceOptions, "stage.start", "output.saveAs", {
        destinationKind: getDestinationKind(destination),
        outputName: publicOutput.fileName,
        storage: publicOutput.storage,
      });
      try {
        await runtime.publicOutput.saveAs(output, destination);
        traceOutputStage(traceOptions, "stage.finish", "output.saveAs", {
          destinationKind: getDestinationKind(destination),
          durationMs: Date.now() - startedAt,
          outputName: publicOutput.fileName,
          storage: publicOutput.storage,
        });
      } catch (error) {
        traceOutputStage(traceOptions, "stage.fail", "output.saveAs", {
          destinationKind: getDestinationKind(destination),
          durationMs: Date.now() - startedAt,
          error,
          outputName: publicOutput.fileName,
          storage: publicOutput.storage,
        });
        throw error;
      }
    },
    size: runtime.publicOutput.getSize(output),
    storage: runtime.publicOutput.getStorage(output),
  };
  return publicOutput;
};

export { wrapPublicOutput };
