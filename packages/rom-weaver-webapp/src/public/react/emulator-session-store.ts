import { useSyncExternalStore } from "react";
import type { RetainedRuntimeOutput } from "../../storage/vfs/types.ts";
import { createStore } from "../../webapp/vanilla-store.ts";

type EmulatorSessionSource = "apply" | "local";

type EmulatorSessionEntry = {
  id: string;
  fileName: string;
  platform?: string;
  core?: string;
  artifact?: Pick<RetainedRuntimeOutput, "dispose" | "getBlob">;
  source: EmulatorSessionSource;
  sizeBytes: number;
  objectUrl?: string;
};

type EmulatorSessionState = {
  entries: EmulatorSessionEntry[];
  currentGameId: string | null;
};

const store = createStore<EmulatorSessionState>(() => ({
  currentGameId: null,
  entries: [],
}));

const revokeEntryUrl = (entry: EmulatorSessionEntry) => {
  if (!entry.objectUrl || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(entry.objectUrl);
};

const disposeEntryResources = (entry: EmulatorSessionEntry) => {
  revokeEntryUrl(entry);
  void Promise.resolve(entry.artifact?.dispose()).catch(() => undefined);
};

const addEntry = (entry: EmulatorSessionEntry) => {
  store.setState((state) => {
    const existing = state.entries.find((candidate) => candidate.id === entry.id);
    if (existing) disposeEntryResources(existing);
    const entries = existing
      ? state.entries.map((candidate) => (candidate.id === entry.id ? entry : candidate))
      : [...state.entries, entry];
    return { entries };
  });
};

const prepareEntry = async (id: string): Promise<string | null> => {
  const entry = store.getState().entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  if (entry.objectUrl) return entry.objectUrl;
  if (!entry.artifact || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const blob = await entry.artifact.getBlob();
  const objectUrl = URL.createObjectURL(blob);
  let accepted = false;
  store.setState((state) => {
    const current = state.entries.find((candidate) => candidate.id === id);
    if (!current || current.artifact !== entry.artifact) return {};
    accepted = true;
    return {
      entries: state.entries.map((candidate) => (candidate.id === id ? { ...candidate, objectUrl } : candidate)),
    };
  });
  if (!accepted && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(objectUrl);
  return accepted ? objectUrl : null;
};

const getApplyEntry = (fileName?: string) =>
  store.getState().entries.find((entry) => entry.source === "apply" && (!fileName || entry.fileName === fileName));

const setCurrentGame = (id: string | null) => {
  store.setState({ currentGameId: id });
};

const disposeEntry = (id: string) => {
  store.setState((state) => {
    const entry = state.entries.find((candidate) => candidate.id === id);
    if (!entry) return {};
    disposeEntryResources(entry);
    return {
      currentGameId: state.currentGameId === id ? null : state.currentGameId,
      entries: state.entries.filter((candidate) => candidate.id !== id),
    };
  });
};

const clearApplyEntries = () => {
  store.setState((state) => {
    const applyEntries = new Set(state.entries.filter((entry) => entry.source === "apply").map((entry) => entry.id));
    for (const entry of state.entries) {
      if (entry.source === "apply") disposeEntryResources(entry);
    }
    return {
      currentGameId: state.currentGameId && applyEntries.has(state.currentGameId) ? null : state.currentGameId,
      entries: state.entries.filter((entry) => entry.source !== "apply"),
    };
  });
};

const subscribe = (listener: () => void) => store.subscribe(() => listener());
const getSnapshot = () => store.getState();

const useEmulatorSession = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

const getEmulatorSessionState = () => store.getState();

export type { EmulatorSessionEntry };
export {
  addEntry,
  clearApplyEntries,
  disposeEntry,
  getApplyEntry,
  getEmulatorSessionState,
  prepareEntry,
  setCurrentGame,
  useEmulatorSession,
};
