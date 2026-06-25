import type { ChecksumVariant } from "../../types/checksum.ts";
import type { WorkflowKind, WorkflowProgress, WorkflowProgressRole } from "../../types/progress.ts";
import type { CandidateSelectionRequest, SelectFile, SelectionCandidate } from "../../types/selection.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime-types.ts";
import type { InputAsset } from "../input/input-assets.ts";

type SharedRomSourceRole = Extract<WorkflowProgressRole, "input" | "modified" | "original" | "patch">;
type SharedSourceStatus = "empty" | "failed" | "loading" | "needsSelection" | "ready";
type SharedParentCompression = {
  depth: number;
  kind: string;
  fileName: string;
  sourceSize?: number;
  outputSize?: number;
  decompressionTimeMs?: number;
};

type SharedRomSourceState<TRole extends SharedRomSourceRole = SharedRomSourceRole> = {
  id: string;
  fileName?: string;
  order?: number;
  role: TRole;
  status: SharedSourceStatus;
  candidates: SelectionCandidate[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  chdMode?: string;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  warnings: Array<{
    code?: string;
    details?: Record<string, unknown>;
    message: string;
    role?: string;
  }>;
  parentCompressions?: SharedParentCompression[];
  checksums?: unknown;
  checksumVariants?: ChecksumVariant[];
  checksumTimeMs?: number;
  romProbe?: unknown;
  romType?: unknown;
};

type SharedInternalCandidate<TSource, TState extends SharedRomSourceState> = {
  archiveEntry?: string;
  candidate: SelectionCandidate;
  owner?: SharedRomStagedSource<TSource, TState>;
  request?: CandidateSelectionRequest;
};

type SharedRomStagedSource<TSource, TState extends SharedRomSourceState> = {
  source: TSource;
  index: number;
  state: TState;
  internalCandidates: Map<string, SharedInternalCandidate<TSource, TState>>;
  preparedInputAssets?: InputAsset[];
  selectedArchiveEntry?: string;
  parentCompressions: SharedParentCompression[];
};

type SharedRomSourceSession<TSource, TState extends SharedRomSourceState> = {
  role: TState["role"];
  sources: TSource[];
  stages: Array<SharedRomStagedSource<TSource, TState>>;
  view: SharedRomStagedSource<TSource, TState>;
  synthetic: boolean;
};

type PreparationProgress = {
  current?: number;
  details?: unknown;
  hasProgress?: boolean;
  label?: string;
  message?: string;
  percent?: number | null;
  total?: number;
};

type SourceIdFactory<TRole extends SharedRomSourceRole> = (role: TRole, index: number, source: unknown) => string;
type SessionIdFactory<TRole extends SharedRomSourceRole> = (role: TRole) => string;
type WorkflowOptionsFactory = () => Partial<ApplyWorkflowOptions & CreateWorkflowOptions>;

type StagedRomSourceControllerOptions<TState extends SharedRomSourceState> = {
  clearRequestsWhenSinglePatchableAsset?: boolean;
  emitProgress: (event: Omit<WorkflowProgress, "sequence">) => void;
  getExecutionOptions: WorkflowOptionsFactory;
  getPreparedFileName?: (asset: InputAsset | undefined, fallback: string) => string;
  getSessionId?: SessionIdFactory<TState["role"]>;
  getSourceId: SourceIdFactory<TState["role"]>;
  id: string;
  releasePreparedOnSelection?: "always" | "when-empty";
  runtime: WorkflowRuntime;
  selectFile?: SelectFile;
  trace?: (message: string, details?: Record<string, unknown>) => void;
  workflow: WorkflowKind;
};

export type {
  PreparationProgress,
  SessionIdFactory,
  SharedInternalCandidate,
  SharedParentCompression,
  SharedRomSourceSession,
  SharedRomSourceState,
  SharedRomStagedSource,
  SourceIdFactory,
  StagedRomSourceControllerOptions,
  WorkflowOptionsFactory,
};
