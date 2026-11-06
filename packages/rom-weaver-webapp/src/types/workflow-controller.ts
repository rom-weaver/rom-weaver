import type { SharedInputPreparationCache } from "../lib/workflow/shared-input-preparation.ts";
import type { SelectFile, SelectionRole } from "./selection.ts";
import type { UncompressedOutputRetention } from "./workflow-runtime-types.ts";

type WorkflowOptions<TSettings> = {
  assetBaseUrl?: string;
  id?: string;
  /** Shares prepared inputs with other workflows that stage the same source objects. */
  preparationCache?: SharedInputPreparationCache;
  retainUncompressedOutput?: UncompressedOutputRetention;
  selectFile?: SelectFile;
  settings?: Partial<TSettings>;
  signal?: AbortSignal;
};

type WorkflowWarning = {
  code?: string;
  details?: Record<string, unknown>;
  message: string;
  role?: SelectionRole | "output" | "worker";
};

export type { WorkflowOptions, WorkflowWarning };
