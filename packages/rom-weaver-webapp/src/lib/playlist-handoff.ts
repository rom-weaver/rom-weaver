/**
 * Hands the discs of a finished Extract or Compress run to the Playlist tool.
 * The sender stores the files and switches the view; the Playlist form takes
 * them when it mounts or, if it is already mounted, as they arrive.
 */

import type { PublicOutput } from "../types/workflow-runtime-types.ts";

/** One file of a game: a dropped file, or an output another tool keeps alive. */
type PlaylistDisc = { name: string; size: number; source: File | PublicOutput };

type Listener = () => void;

let pending: PlaylistDisc[] = [];
const listeners = new Set<Listener>();

const setPlaylistHandoff = (files: PlaylistDisc[]) => {
  pending = files;
  for (const listener of listeners) listener();
};

/** Returns the waiting files once; later calls return an empty list. */
const takePlaylistHandoff = (): PlaylistDisc[] => {
  const files = pending;
  pending = [];
  return files;
};

const subscribePlaylistHandoff = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Whether `fileNames` hold several discs of one game, so a playlist is worth
 * offering: two or more disc-sheet or disc-image files (not the track files a
 * `.cue` names).
 */
const DISC_FILE_PATTERN = /\.(cue|gdi|chd|iso|pbp|ccd|mds|cso|rvz|wbfs|gcz|ciso)$/i;
const hasSeveralDiscs = (fileNames: readonly string[]): boolean =>
  fileNames.filter((name) => DISC_FILE_PATTERN.test(name)).length > 1;

export { hasSeveralDiscs, type PlaylistDisc, setPlaylistHandoff, subscribePlaylistHandoff, takePlaylistHandoff };
