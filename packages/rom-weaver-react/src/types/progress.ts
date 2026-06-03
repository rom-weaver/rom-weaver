type WorkflowKind = "apply" | "create" | "trim";

type WorkflowProgressRole = "input" | "patch" | "original" | "modified" | "output" | "worker";

type WorkflowProgressStage =
  | "detect"
  | "decompress"
  | "select"
  | "parse"
  | "checksum"
  | "verify"
  | "apply"
  | "create"
  | "trim"
  | "compress"
  | "write";

type WorkflowProgressUnit = "bytes" | "entries" | "files";

type WorkflowProgress = {
  current?: number;
  details?: Record<string, unknown>;
  hasProgress?: boolean;
  id: string;
  label: string;
  parentId?: string;
  percent?: number | null;
  role: WorkflowProgressRole;
  sequence: number;
  stage: WorkflowProgressStage;
  target?: string;
  timing?: {
    durationMs?: number;
    startedAt?: number;
  };
  total?: number;
  unit?: WorkflowProgressUnit;
  workflow: WorkflowKind;
};

type ProgressSink = (event: WorkflowProgress) => void;

export type {
  ProgressSink,
  WorkflowKind,
  WorkflowProgress,
  WorkflowProgressRole,
  WorkflowProgressStage,
  WorkflowProgressUnit,
};
