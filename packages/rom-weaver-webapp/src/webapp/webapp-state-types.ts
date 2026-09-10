type WorkflowView = "patcher" | "creator" | "identify" | "trim" | "ppf-undo" | "save-editor" | "test";
/** "home" is the apex landing route: a WebappView the shell renders, but not a workflow. */
type WebappView = WorkflowView | "docs" | "home" | "whats-new";

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

type SaveEditorSessionState = {
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

const createEmptySaveEditorSessionState = (): SaveEditorSessionState => ({ active: false });

export type {
  CreatorSessionState,
  PatcherSessionState,
  StartupState,
  PpfUndoSessionState,
  SaveEditorSessionState,
  TrimSessionState,
  ValidationState,
  WebappView,
  WorkflowView,
};
export {
  createEmptyCreatorSessionState,
  createEmptyPatcherSessionState,
  createEmptyPpfUndoSessionState,
  createEmptySaveEditorSessionState,
  createEmptyTrimSessionState,
  createEmptyValidationState,
};
