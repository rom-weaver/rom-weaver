import { useSyncExternalStore } from "react";
import { createStore } from "../../webapp/vanilla-store.ts";

type EmulatorSessionSource = "apply" | "local";

type EmulatorSessionEntry = {
  id: string;
  fileName: string;
  platform?: string;
  core?: string;
  source: EmulatorSessionSource;
  sizeBytes: number;
  objectUrl: string;
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
  URL.revokeObjectURL(entry.objectUrl);
};

const addEntry = (entry: EmulatorSessionEntry) => {
  store.setState((state) => {
    const existing = state.entries.find((candidate) => candidate.id === entry.id);
    if (existing && existing.objectUrl !== entry.objectUrl) revokeEntryUrl(existing);
    const entries = existing
      ? state.entries.map((candidate) => (candidate.id === entry.id ? entry : candidate))
      : [...state.entries, entry];
    return { entries };
  });
};

const setCurrentGame = (id: string | null) => {
  store.setState({ currentGameId: id });
};

const disposeEntry = (id: string) => {
  store.setState((state) => {
    const entry = state.entries.find((candidate) => candidate.id === id);
    if (!entry) return {};
    revokeEntryUrl(entry);
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
      if (entry.source === "apply") revokeEntryUrl(entry);
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
export { addEntry, clearApplyEntries, disposeEntry, getEmulatorSessionState, setCurrentGame, useEmulatorSession };
