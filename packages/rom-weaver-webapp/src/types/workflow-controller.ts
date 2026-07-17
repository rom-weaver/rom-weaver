import type { SelectFile, SelectionRole } from "./selection.ts";

type WorkflowOptions<TSettings> = {
  assetBaseUrl?: string;
  id?: string;
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
