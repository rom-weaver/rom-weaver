import { invokeRomWeaverPlaylistPlan } from "../../lib/runtime/wasm-playlist-commands.ts";
import type { LogLevel } from "../../types/logging.ts";
import { getBaseName } from "../../storage/shared/path-utils.ts";
import type { PlaylistDryRunPlan } from "../../wasm/generated/rom-weaver-rust-types.d.ts";
import { registerBrowserVirtualFile } from "../../workers/protocol/browser-virtual-files.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";

/** A picked file and its `/`-separated path from the picked folder, ending in its name. */
type PlaylistSourceFile = { file: File; path: string };

type BrowserPlaylistPlanRequest = {
  files: readonly PlaylistSourceFile[];
  /** The disc files to list, as `path`s of `files`; every disc file when absent. */
  discs?: readonly string[];
  /** The game's name, which names the playlist and renamed discs. */
  name?: string;
  renameInPlace?: boolean;
  logLevel?: LogLevel | string;
  signal?: AbortSignal;
};

/** A {@link PlaylistDryRunPlan} whose paths are `path`s of the picked files. */
type BrowserPlaylistPlan = PlaylistDryRunPlan;

// Disc images and sheets a playlist lists. Track and data files (`.bin`, `.img`, `.sub`, `.mdf`)
// stay out: the sheet that names them brings them along.
const PLAYLIST_DISC_EXTENSIONS: ReadonlySet<string> = new Set([
  "ccd",
  "cdi",
  "chd",
  "ciso",
  "cso",
  "cue",
  "gcz",
  "gdi",
  "iso",
  "mds",
  "nrg",
  "pbp",
  "rvz",
  "wbfs",
  "wia",
  "zso",
]);

// Files that operating systems leave beside games. `._Game.cue` is macOS metadata, not a disc sheet.
const SYSTEM_FILE_NAMES: ReadonlySet<string> = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

const CONTROL_CHARACTERS = /\p{Cc}/u;
const PLAYLIST_FILE = /\.m3u8?$/i;

const isSystemFile = (path: string) => {
  const name = getBaseName(path);
  return name.startsWith("._") || SYSTEM_FILE_NAMES.has(name.toLowerCase());
};

const isPlaylistDisc = (path: string) => {
  const name = getBaseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && PLAYLIST_DISC_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
};

const checkSourcePath = (path: string) => {
  const parts = path.split("/");
  if (
    parts.some(
      (part) => part === "" || part === "." || part === ".." || part.includes("\\") || CONTROL_CHARACTERS.test(part),
    )
  ) {
    throw new Error(`"${path}" has a name the playlist cannot use. Rename it and pick the folder again.`);
  }
};

/** The picked files a playlist can use, without the metadata files operating systems add. */
const getPlaylistSourceFiles = (files: readonly PlaylistSourceFile[]) =>
  files.filter((source) => !isSystemFile(source.path));

/**
 * Plan a playlist from picked files with the engine's dry run. The files are mounted at their
 * exact names and relative paths, so the plan's lines and renamed sheets match the real folder.
 */
const planBrowserPlaylist = async ({
  files,
  discs,
  name,
  renameInPlace,
  logLevel,
  signal,
}: BrowserPlaylistPlanRequest): Promise<BrowserPlaylistPlan> => {
  const sources = getPlaylistSourceFiles(files);
  const seen = new Set<string>();
  for (const source of sources) {
    checkSourcePath(source.path);
    // Dropped files from different folders can share a name, and a mount holds one file per path.
    if (seen.has(source.path)) throw new Error(`Two files are named "${source.path}". Add the discs of one game.`);
    seen.add(source.path);
  }
  // An existing playlist would block the engine from writing a new one beside it, and a download
  // never lands there. Renaming keeps it, so the plan refuses a name that is already taken.
  const mounted = renameInPlace ? sources : sources.filter((source) => !PLAYLIST_FILE.test(source.path));
  const wanted = discs ? new Set(discs) : null;
  const inputs = mounted.filter((source) => (wanted ? wanted.has(source.path) : isPlaylistDisc(source.path)));
  if (!inputs.length) throw new Error("Add the game's disc files, such as .cue, .chd, or .iso files.");
  const root = `${WORKER_OPFS_MOUNTPOINT}/playlist-${crypto.randomUUID()}`;
  const toGuest = (path: string) => `${root}/${path}`;
  const fromGuest = (path: string) => {
    if (!path.startsWith(`${root}/`)) throw new Error(`The playlist plan named a file outside the folder: ${path}`);
    return path.slice(root.length + 1);
  };
  const unregister = mounted.map((source) =>
    registerBrowserVirtualFile({ path: toGuest(source.path), source: source.file, trace: { logLevel } }),
  );
  try {
    const plan = (output?: string) =>
      invokeRomWeaverPlaylistPlan({
        inputs: inputs.map((source) => toGuest(source.path)),
        knownPaths: mounted.map((source) => toGuest(source.path)),
        logLevel,
        signal,
        ...(renameInPlace ? { name, renameInPlace } : { output }),
      });
    let result = await plan(!renameInPlace && name ? toGuest(`${name}.m3u`) : undefined);
    // Without a name the engine writes the playlist beside the first disc. Lines are relative to
    // the playlist, so a first disc in a subfolder plans again with the playlist at the top.
    if (!(renameInPlace || name) && result.discs[0] && fromGuest(result.discs[0].path).includes("/")) {
      result = await plan(toGuest(result.file_name));
    }
    return {
      ...result,
      discs: result.discs.map((disc) => ({ ...disc, path: fromGuest(disc.path) })),
      renames: result.renames.map((rename) => ({ ...rename, from: fromGuest(rename.from) })),
    };
  } catch (error) {
    // Engine messages name the mounted copies; show the paths from the picked folder instead.
    // The engine words some refusals for its command line; the form has a game name field and no flags.
    if (error instanceof Error) {
      error.message = error.message
        .replaceAll(`${root}/`, "")
        .replace("; pass --name", ". Type a game name")
        .replace("--rename cannot rename", "Cannot rename");
    }
    throw error;
  } finally {
    for (const release of unregister) release();
  }
};

export { planBrowserPlaylist };
export type { BrowserPlaylistPlan, PlaylistSourceFile };
