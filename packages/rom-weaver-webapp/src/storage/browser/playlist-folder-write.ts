import { createLogger } from "../../lib/logging.ts";
import { writeBlobToFileHandle } from "./file-handle-write.ts";
import { createIdbObjectStore } from "./idb-object-store.ts";

// File System Access members that TypeScript's DOM library does not declare.
type FolderHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>;
  queryPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
};
type MovableFileHandle = FileSystemFileHandle & { move?: (name: string) => Promise<void> };

type PlaylistFolderRename = { from: string; to: string; text?: string | null };
type PlaylistFolderSnapshot = { size: number; lastModified: number };

type RenamePlaylistFolderRequest = {
  directory: FileSystemDirectoryHandle;
  renames: readonly PlaylistFolderRename[];
  playlist: { fileName: string; text: string };
  /** Each renamed file as the plan saw it. A file that changed since stops the rename. */
  planned: ReadonlyMap<string, PlaylistFolderSnapshot>;
};

/**
 * What a rename has changed so far, saved before each step, so an interrupted rename (a closed
 * tab, a crash) can be undone later. `pending` is a move that may or may not have happened.
 */
type PlaylistRenameJournal = {
  version: 1;
  directory: FileSystemDirectoryHandle;
  folderName: string;
  moves: { from: string; to: string }[];
  pending: { from: string; to: string } | null;
  /** Rewritten sheets, by their final name, with their original bytes. */
  sheets: { name: string; bytes: ArrayBuffer }[];
  /** The playlist this rename creates, once it starts writing it. */
  playlist: string | null;
};

const logger = createLogger("playlist-folder-write");
const LOCK_NAME = "rom-weaver-playlist-folder";
const JOURNAL_KEY = "rename";
const journalStore = createIdbObjectStore("rom-weaver-playlist-rename", "journal", {
  blocked: "Playlist storage is upgrading. Close other rom-weaver tabs and try again.",
  unavailable: "Playlist storage is unavailable, so discs cannot be renamed safely.",
  failed: "Could not save the rename's progress.",
});

const PLAYLIST_FOLDER_UNSUPPORTED = "PLAYLIST_FOLDER_UNSUPPORTED";

// Names compare as most file systems on Windows and macOS do: ignoring case, after NFC.
const foldName = (name: string) => name.normalize("NFC").toLowerCase();

const isNotFound = (error: unknown) => error instanceof DOMException && error.name === "NotFoundError";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Ask for write access. Callers MUST call this first in a click handler, while it still counts as a user action. */
const requestPlaylistFolderAccess = async (directory: FileSystemDirectoryHandle) => {
  const folder = directory as FolderHandle;
  const state = (await folder.requestPermission?.({ mode: "readwrite" })) ?? "granted";
  if (state !== "granted") throw new Error(`rom-weaver needs permission to change files in "${directory.name}".`);
};

const assertWritable = async (directory: FileSystemDirectoryHandle) => {
  const state = (await (directory as FolderHandle).queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (state !== "granted")
    throw new Error(`rom-weaver no longer has permission to change files in "${directory.name}".`);
};

const listFolder = async (directory: FileSystemDirectoryHandle) => {
  const files = new Map<string, FileSystemFileHandle>();
  const names: string[] = [];
  for await (const handle of (directory as FolderHandle).values()) {
    names.push(handle.name);
    if (handle.kind === "file") files.set(handle.name, handle as FileSystemFileHandle);
  }
  return { files, names };
};

const assertAbsent = async (directory: FileSystemDirectoryHandle, name: string) => {
  try {
    await directory.getFileHandle(name);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new Error(`"${name}" appeared in the folder while renaming; nothing was overwritten.`);
};

/** Create `fileName` in the folder, refusing any existing name that differs only in case. */
const createFolderFile = async (directory: FileSystemDirectoryHandle, fileName: string, text: string) => {
  const { names } = await listFolder(directory);
  const taken = names.find((name) => foldName(name) === foldName(fileName));
  if (taken) throw new Error(`"${taken}" already exists in "${directory.name}"; nothing was overwritten.`);
  const handle = await directory.getFileHandle(fileName, { create: true });
  try {
    await writeBlobToFileHandle(handle, new Blob([text], { type: "audio/x-mpegurl" }));
  } catch (error) {
    await directory.removeEntry(fileName).catch(() => undefined);
    throw error;
  }
};

const withFolderLock = <T>(action: () => Promise<T>) =>
  navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("Another rom-weaver tab is changing a game folder. Wait for it to finish.");
    return action();
  });

/** Save a playlist into the picked folder. It never replaces a file. */
const savePlaylistToFolder = async (directory: FileSystemDirectoryHandle, fileName: string, text: string) => {
  await assertWritable(directory);
  await withFolderLock(() => createFolderFile(directory, fileName, text));
};

const readJournal = async (): Promise<PlaylistRenameJournal | null> => {
  const value: unknown = await journalStore.transaction("readonly", (store) => store.get(JOURNAL_KEY));
  return value && typeof value === "object" && (value as { version?: unknown }).version === 1
    ? (value as PlaylistRenameJournal)
    : null;
};

const saveJournal = (journal: PlaylistRenameJournal) =>
  journalStore.transaction("readwrite", (store) => store.put(journal, JOURNAL_KEY));

const clearJournal = () => journalStore.transaction("readwrite", (store) => store.delete(JOURNAL_KEY));

const unsupportedError = (cause?: unknown) =>
  Object.assign(new Error("This browser cannot rename files in a folder.", { cause }), {
    code: PLAYLIST_FOLDER_UNSUPPORTED,
  });

const moveFile = async (handle: FileSystemFileHandle, name: string) => {
  const move = (handle as MovableFileHandle).move;
  if (typeof move !== "function") throw unsupportedError();
  try {
    await move.call(handle, name);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotSupportedError") throw unsupportedError(error);
    throw error;
  }
};

/**
 * Put back everything a journal records, newest first, dropping each step from the journal once it
 * is undone so a retry resumes where this stopped. Returns what could not be put back.
 */
const undoJournal = async (journal: PlaylistRenameJournal): Promise<string[]> => {
  const { directory } = journal;
  const failures: string[] = [];
  const save = () => saveJournal(journal).catch((error) => logger.warn("could not save undo progress", { error }));
  for (const sheet of [...journal.sheets].reverse()) {
    try {
      await writeBlobToFileHandle(await directory.getFileHandle(sheet.name), new Blob([sheet.bytes]));
      journal.sheets = journal.sheets.filter((entry) => entry !== sheet);
      await save();
    } catch (error) {
      failures.push(`restore the text of "${sheet.name}" (${errorMessage(error)})`);
    }
  }
  if (journal.playlist) {
    try {
      await directory.removeEntry(journal.playlist);
      journal.playlist = null;
    } catch (error) {
      if (isNotFound(error)) journal.playlist = null;
      else failures.push(`remove "${journal.playlist}" (${errorMessage(error)})`);
    }
    await save();
  }
  if (journal.pending) {
    const { to } = journal.pending;
    const moved = await directory.getFileHandle(to).then(
      () => true,
      () => false,
    );
    if (moved) journal.moves.push(journal.pending);
    journal.pending = null;
    await save();
  }
  for (const move of [...journal.moves].reverse()) {
    try {
      await assertAbsent(directory, move.from);
      await moveFile(await directory.getFileHandle(move.to), move.from);
      journal.moves = journal.moves.filter((entry) => entry !== move);
      await save();
    } catch (error) {
      failures.push(`rename "${move.to}" back to "${move.from}" (${errorMessage(error)})`);
    }
  }
  return failures;
};

const tempName = (name: string, runId: string, index: number) => {
  const dot = name.lastIndexOf(".");
  // The temporary name keeps the extension: Chrome repeats its download safety checks when a move changes one.
  return dot > 0 ? `${name.slice(0, dot)}.rw-${runId}-${index}${name.slice(dot)}` : `${name}.rw-${runId}-${index}`;
};

const preflight = async ({ directory, renames, playlist, planned }: RenamePlaylistFolderRequest) => {
  const { files, names } = await listFolder(directory);
  const sources = new Set(renames.map((rename) => rename.from));
  const others = new Map(names.filter((name) => !sources.has(name)).map((name) => [foldName(name), name]));
  const targets = new Set<string>();
  const handles: FileSystemFileHandle[] = [];
  for (const rename of renames) {
    const handle = files.get(rename.from);
    const before = planned.get(rename.from);
    const file = handle ? await handle.getFile() : null;
    if (!(handle && file && before && file.size === before.size && file.lastModified === before.lastModified)) {
      throw new Error(`"${rename.from}" changed after the preview. Choose the folder again.`);
    }
    handles.push(handle);
  }
  for (const target of [...renames.map((rename) => rename.to), playlist.fileName]) {
    const taken = others.get(foldName(target));
    if (taken) throw new Error(`"${taken}" already exists in "${directory.name}"; nothing was renamed.`);
    if (targets.has(foldName(target))) throw new Error(`Two files would both be named "${target}".`);
    targets.add(foldName(target));
  }
  return handles;
};

/**
 * Rename files where they are, rewrite renamed sheets, and write the playlist. Each file moves to
 * a temporary name first, so swapped or case-only names never meet. Any failure puts the folder
 * back; an interruption leaves a journal for {@link undoInterruptedPlaylistRename}.
 */
const renamePlaylistFolder = async (request: RenamePlaylistFolderRequest) => {
  const { directory, renames, playlist } = request;
  await assertWritable(directory);
  await withFolderLock(async () => {
    if (await readJournal()) throw new Error("Undo the interrupted rename before renaming again.");
    const handles = await preflight(request);
    const originals = await Promise.all(
      renames.map(async (rename, index) =>
        typeof rename.text === "string" ? await (await handles[index]?.getFile())?.arrayBuffer() : undefined,
      ),
    );
    const runId = crypto.randomUUID().slice(0, 8);
    const journal: PlaylistRenameJournal = {
      version: 1,
      directory,
      folderName: directory.name,
      moves: [],
      pending: null,
      sheets: [],
      playlist: null,
    };
    const step = async (from: string, to: string, handle: FileSystemFileHandle) => {
      await assertAbsent(directory, to);
      journal.pending = { from, to };
      await saveJournal(journal);
      await moveFile(handle, to);
      journal.moves.push({ from, to });
      journal.pending = null;
      await saveJournal(journal);
    };
    try {
      const temps = renames.map((rename, index) => tempName(rename.from, runId, index));
      for (const [index, rename] of renames.entries()) {
        const handle = handles[index] as FileSystemFileHandle;
        await step(rename.from, temps[index] as string, handle);
      }
      for (const [index, rename] of renames.entries()) {
        await step(temps[index] as string, rename.to, handles[index] as FileSystemFileHandle);
      }
      for (const [index, rename] of renames.entries()) {
        const bytes = originals[index];
        if (typeof rename.text !== "string" || !bytes) continue;
        journal.sheets.push({ name: rename.to, bytes });
        await saveJournal(journal);
        await writeBlobToFileHandle(handles[index] as FileSystemFileHandle, new Blob([rename.text]));
      }
      await createFolderFile(directory, playlist.fileName, playlist.text);
      journal.playlist = playlist.fileName;
      await saveJournal(journal);
    } catch (error) {
      const failures = await undoJournal(journal);
      if (!failures.length) await clearJournal().catch(() => undefined);
      if (
        !(journal.moves.length || failures.length) &&
        (error as { code?: unknown }).code === PLAYLIST_FOLDER_UNSUPPORTED
      ) {
        throw error;
      }
      logger.warn("playlist rename rolled back", { error: errorMessage(error), failures });
      throw new Error(
        failures.length
          ? `${errorMessage(error)} rom-weaver could not ${failures.join("; ")}.`
          : `${errorMessage(error)} The folder was put back as it was.`,
        { cause: error },
      );
    }
    await clearJournal();
  });
};

type InterruptedPlaylistRename = { directory: FileSystemDirectoryHandle; folderName: string };

/** A rename that stopped partway, or null when nothing needs undoing. */
const readInterruptedPlaylistRename = async (): Promise<InterruptedPlaylistRename | null> => {
  const journal = await readJournal().catch(() => null);
  return journal ? { directory: journal.directory, folderName: journal.folderName } : null;
};

/** Undo a rename that stopped partway. Callers MUST call it from a click handler. */
const undoInterruptedPlaylistRename = async ({ directory }: InterruptedPlaylistRename) => {
  await requestPlaylistFolderAccess(directory);
  await withFolderLock(async () => {
    const journal = await readJournal();
    if (!journal) return;
    const failures = await undoJournal(journal);
    if (failures.length) throw new Error(`rom-weaver could not ${failures.join("; ")}.`);
    await clearJournal();
  });
};

export {
  readInterruptedPlaylistRename,
  renamePlaylistFolder,
  requestPlaylistFolderAccess,
  savePlaylistToFolder,
  undoInterruptedPlaylistRename,
};
export type { InterruptedPlaylistRename };
