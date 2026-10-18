/**
 * Hands the discs of a finished Extract or Compress run to the Playlist tool.
 * The sender stores the files and switches the view; the Playlist form takes
 * them when it mounts or, if it is already mounted, as they arrive.
 */

import { copyRuntimeOutputToPath, createRuntimeOutputFromVfs } from "../storage/vfs/runtime-output.ts";
import { createVfsPathId } from "../storage/vfs/path-id.ts";
import type { PublicOutput } from "../types/workflow-runtime-types.ts";

/**
 * One file of a game: a dropped file, or an output another tool keeps alive.
 * `origin` and `owned` are set once the Playlist tool holds its own copy of such an output.
 */
type PlaylistDisc = {
  name: string;
  size: number;
  source: File | PublicOutput;
  origin?: File | PublicOutput;
  owned?: boolean;
};

/** Whether two entries are the same file: the same source, or the same dropped file picked twice. */
const isSamePlaylistFile = (left: PlaylistDisc, right: PlaylistDisc): boolean => {
  const a = left.origin ?? left.source;
  const b = right.origin ?? right.source;
  if (a === b) return true;
  return (
    a instanceof File &&
    b instanceof File &&
    a.name === b.name &&
    a.size === b.size &&
    a.lastModified === b.lastModified
  );
};

/** Where the Playlist tool keeps its copies; the boot cleanup sweeps this folder. */
const PLAYLIST_COPY_FOLDER = "runtime-output/playlist";

/**
 * Give the Playlist tool its own copy of an output another tool keeps alive, so the playlist still
 * has the file after that tool disposes it (Extract does when it starts its next run). Every copy
 * of one handoff goes into a shared folder under its real name and relative path, so a sheet still
 * finds the track files it names.
 */
const retainPlaylistDisc = async (disc: PlaylistDisc, handoffId: string): Promise<PlaylistDisc> => {
  const { source } = disc;
  if (source instanceof Blob) return disc;
  const copy = await copyRuntimeOutputToPath(source, source.fileName, PLAYLIST_COPY_FOLDER, handoffId);
  const owned = await createRuntimeOutputFromVfs(copy.vfs, copy.path, copy.fileName, {
    cleanup: copy.dispose,
    mediaType: copy.mediaType,
    size: copy.size,
  });
  return { name: disc.name, origin: source, owned: true, size: disc.size, source: owned };
};

/** A fresh folder name for one handoff's copies. */
const createPlaylistHandoffId = (): string => createVfsPathId();

/** Delete the copy {@link retainPlaylistDisc} made; a dropped file is left alone. */
const releasePlaylistDisc = (disc: PlaylistDisc) => {
  if (disc.owned && !(disc.source instanceof Blob)) void disc.source.dispose();
};

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

/** The files worth listing in a playlist: disc images and sheets plus the data files they use. */
const PLAYLIST_FILE_PATTERN =
  /\.(cue|gdi|chd|iso|pbp|ccd|mds|cso|rvz|wbfs|gcz|ciso|bin|img|sub|mdf|raw|wav|mp3|ogg|flac|ape)$/i;
const isPlaylistFile = (fileName: string): boolean => PLAYLIST_FILE_PATTERN.test(fileName);

/**
 * Whether `fileNames` hold several discs of one game, so a playlist is worth
 * offering: two or more disc-sheet or disc-image files (not the track files a
 * `.cue` names).
 */
const DISC_FILE_PATTERN = /\.(cue|gdi|chd|iso|pbp|ccd|mds|cso|rvz|wbfs|gcz|ciso)$/i;
const hasSeveralDiscs = (fileNames: readonly string[]): boolean =>
  fileNames.filter((name) => DISC_FILE_PATTERN.test(name)).length > 1;

export {
  createPlaylistHandoffId,
  hasSeveralDiscs,
  isPlaylistFile,
  isSamePlaylistFile,
  type PlaylistDisc,
  releasePlaylistDisc,
  retainPlaylistDisc,
  setPlaylistHandoff,
  subscribePlaylistHandoff,
  takePlaylistHandoff,
};
