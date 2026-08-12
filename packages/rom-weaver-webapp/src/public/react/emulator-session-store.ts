import { useSyncExternalStore } from "react";
import type { RetainedRuntimeOutput } from "../../storage/vfs/types.ts";
import { createStore } from "../../webapp/vanilla-store.ts";

type EmulatorSessionSource = "apply" | "local";

type EmulatorSessionEntry = {
  checksum?: string;
  id: string;
  fileName: string;
  platform?: string;
  core?: string;
  artifact?: Pick<RetainedRuntimeOutput, "dispose" | "getBlob">;
  source: EmulatorSessionSource;
  sizeBytes: number;
  /**
   * The playable bytes. The player mints a fresh object URL per mount from
   * this blob: EmulatorJS revokes the game URL it is given once it has read
   * it, so a stored URL would die after the first run (stop → play failed
   * with a network error).
   */
  blob?: Blob;
};

type EmulatorSessionState = {
  entries: EmulatorSessionEntry[];
  currentGameId: string | null;
};

const store = createStore<EmulatorSessionState>(() => ({
  currentGameId: null,
  entries: [],
}));

const disposeEntryResources = (entry: EmulatorSessionEntry) => {
  void Promise.resolve(entry.artifact?.dispose()).catch(() => undefined);
};

const addEntry = (entry: EmulatorSessionEntry) => {
  store.setState((state) => {
    for (const existing of state.entries) {
      if (existing !== entry) disposeEntryResources(existing);
    }
    return { currentGameId: entry.id, entries: [entry] };
  });
};

const prepareEntry = async (id: string): Promise<Blob | null> => {
  const entry = store.getState().entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  if (entry.blob) return entry.blob;
  if (!entry.artifact) return null;
  const blob = await entry.artifact.getBlob();
  let accepted = false;
  store.setState((state) => {
    const current = state.entries.find((candidate) => candidate.id === id);
    if (!current || current.artifact !== entry.artifact) return {};
    accepted = true;
    return {
      entries: state.entries.map((candidate) => (candidate.id === id ? { ...candidate, blob } : candidate)),
    };
  });
  return accepted ? blob : null;
};

const getApplyEntry = (fileName?: string) =>
  store.getState().entries.find((entry) => entry.source === "apply" && (!fileName || entry.fileName === fileName));

const setCurrentGame = (id: string | null) => {
  store.setState((state) => {
    if (id && !state.entries.some((entry) => entry.id === id)) return {};
    return { currentGameId: id };
  });
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
