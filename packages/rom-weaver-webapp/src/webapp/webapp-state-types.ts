type WorkflowView = "patcher" | "creator" | "identify" | "trim" | "ppf-undo" | "test";
type WebappView = WorkflowView | "docs";

type ValidationState = {
  messages: string[];
  invalidFields: string[];
};

type StartupState = {
  status: "loading" | "ready" | "error";
  message: string;
};

type PatcherSessionState = {
  outputCompression: string;
  outputName: string;
  patchCount: number;
  pendingDownloadFileName: string | null;
  romFilePresent: boolean;
};

type CreatorSessionState = {
  modifiedFilePresent: boolean;
  originalFilePresent: boolean;
  outputName: string;
  patchType: string;
};

type TrimSessionState = {
  outputFormat: string;
  outputName: string;
  sourceFilePresent: boolean;
};

type PpfUndoSessionState = {
  active: boolean;
};

const createEmptyValidationState = (): ValidationState => ({
  invalidFields: [],
  messages: [],
});

const createEmptyPatcherSessionState = (): PatcherSessionState => ({
  outputCompression: "none",
  outputName: "",
  patchCount: 0,
  pendingDownloadFileName: null,
  romFilePresent: false,
});

const createEmptyCreatorSessionState = (): CreatorSessionState => ({
  modifiedFilePresent: false,
  originalFilePresent: false,
  outputName: "",
  patchType: "bps",
});

const createEmptyTrimSessionState = (): TrimSessionState => ({
  outputFormat: "",
  outputName: "",
  sourceFilePresent: false,
});

const createEmptyPpfUndoSessionState = (): PpfUndoSessionState => ({ active: false });

export type {
  CreatorSessionState,
  PatcherSessionState,
  StartupState,
  PpfUndoSessionState,
  TrimSessionState,
  ValidationState,
  WebappView,
  WorkflowView,
};
export {
  createEmptyCreatorSessionState,
  createEmptyPatcherSessionState,
  createEmptyPpfUndoSessionState,
  createEmptyTrimSessionState,
  createEmptyValidationState,
};
