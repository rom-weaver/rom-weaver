import { useSyncExternalStore } from "react";
import { subscribeWorkbenchRunStart } from "../../lib/activity-store.ts";
import type { RetainedRuntimeOutput } from "../../storage/vfs/types.ts";
import { clearEmulatorSavePreview } from "../../storage/browser/emulator-saves.ts";
import { createStore } from "../../webapp/vanilla-store.ts";
import { loadEmulatorRom } from "./components/emulator-load-rom.ts";

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
  savePreviewRevision?: number;
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

// The disc-sized game another action closed, so the Test view can say why it is gone.
const closedGameStore = createStore<{ fileName: string | null }>(() => ({ fileName: null }));

const setClosedGameName = (fileName: string | null) => {
  if (closedGameStore.getState().fileName !== fileName) closedGameStore.setState({ fileName });
};

const disposeEntryResources = (entry: EmulatorSessionEntry) => {
  if (entry.checksum) clearEmulatorSavePreview(entry.checksum);
  void Promise.resolve(entry.artifact?.dispose()).catch(() => undefined);
};

const restartCurrentGameWithSave = (id: string) => {
  store.setState((state) => ({
    entries: state.entries.map((entry) =>
      entry.id === id ? { ...entry, savePreviewRevision: (entry.savePreviewRevision ?? 0) + 1 } : entry,
    ),
  }));
};

const addEntry = (entry: EmulatorSessionEntry) => {
  store.setState((state) => {
    for (const existing of state.entries) {
      if (existing !== entry) disposeEntryResources(existing);
    }
    return { currentGameId: entry.id, entries: [entry] };
  });
  setClosedGameName(null);
};

const prepareEntry = async (id: string): Promise<Blob | null> => {
  const entry = store.getState().entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  if (entry.blob) return entry.blob;
  if (!entry.artifact) return null;
  const blob = await entry.artifact.getBlob();
  const { checksum } = await loadEmulatorRom(blob, entry.fileName);
  let accepted = false;
  store.setState((state) => {
    const current = state.entries.find((candidate) => candidate.id === id);
    if (!current || current.artifact !== entry.artifact) return {};
    accepted = true;
    return {
      entries: state.entries.map((candidate) => (candidate.id === id ? { ...candidate, blob, checksum } : candidate)),
    };
  });
  return accepted ? blob : null;
};

// A game this large is a disc; smaller ones cost little to keep.
const LARGE_GAME_BYTES = 128 * 1024 * 1024;

const isLargeEntry = (entry: EmulatorSessionEntry) => entry.sizeBytes > LARGE_GAME_BYTES;

/**
 * Release a disc-sized game before the page reads another disc or another action runs. A hidden Test view only
 * pauses its game, which keeps the disc's file-system copy and the core's heap in the page. Together with the next
 * disc or the action's memory, that can exceed an iOS tab's memory limit. `announce` tells the Test view that the
 * game was closed; callers that load a replacement leave it unset.
 */
const releaseLargeEntries = ({ announce = false }: { announce?: boolean } = {}) => {
  let closedName: string | undefined;
  store.setState((state) => {
    const large = state.entries.filter(isLargeEntry);
    if (!large.length) return {};
    for (const entry of large) disposeEntryResources(entry);
    closedName = large[0]?.fileName;
    return {
      currentGameId: large.some((entry) => entry.id === state.currentGameId) ? null : state.currentGameId,
      entries: state.entries.filter((entry) => !large.includes(entry)),
    };
  });
  if (announce && closedName) setClosedGameName(closedName);
};

/** Release a disc-sized game each time a workflow starts a run. Returns the unsubscribe function. */
const releaseLargeEntriesOnRunStart = () => subscribeWorkbenchRunStart(() => releaseLargeEntries({ announce: true }));

const dismissClosedGameNotice = () => setClosedGameName(null);

const getClosedGameName = () => closedGameStore.getState().fileName;

const useClosedGameName = () => useSyncExternalStore(closedGameStore.subscribe, getClosedGameName, getClosedGameName);

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
  dismissClosedGameNotice,
  disposeEntry,
  getApplyEntry,
  getClosedGameName,
  getEmulatorSessionState,
  isLargeEntry,
  prepareEntry,
  releaseLargeEntries,
  releaseLargeEntriesOnRunStart,
  restartCurrentGameWithSave,
  setCurrentGame,
  useClosedGameName,
  useEmulatorSession,
};
