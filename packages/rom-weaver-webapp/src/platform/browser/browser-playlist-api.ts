import { createRomWeaverOutputScope } from "../../lib/runtime/run-output-paths.ts";
import { invokeRomWeaverPlaylistPlan, invokeRomWeaverPlaylistWrite } from "../../lib/runtime/wasm-playlist-commands.ts";
import { withBrowserOutputStorageFailureContext } from "../../storage/browser/browser-output-storage-guard.ts";
import { getBaseName } from "../../storage/shared/path-utils.ts";
import { createRuntimeOutputFromVfs } from "../../storage/vfs/runtime-output.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import type {
  PlaylistDryRunPlan,
  PlaylistLayout,
  RomWeaverRunJsonEvent,
} from "../../wasm/generated/rom-weaver-rust-types.d.ts";
import { registerBrowserVirtualFile } from "../../workers/protocol/browser-virtual-files.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";
import { browserVfs } from "./workflow-runtime-vfs-cleanup.ts";

/** A picked file and its `/`-separated path from the picked folder, ending in its name. */
type PlaylistSourceFile = { file: File; path: string };

/** What a `.zip` of the playlist and discs holds: the discs' names and where the files go. */
type PlaylistZipOptions = {
  layout: PlaylistLayout;
  rename: boolean;
};

type BrowserPlaylistPlanRequest = {
  files: readonly PlaylistSourceFile[];
  /** The disc files to list, as `path`s of `files`; every disc file when absent. */
  discs?: readonly string[];
  /** The game's name, which names the playlist and renamed discs. */
  name?: string;
  renameInPlace?: boolean;
  /** Plan a `.zip` of the playlist and discs instead of a lone `.m3u`; needs `name`. */
  zip?: PlaylistZipOptions;
  logLevel?: LogLevel | string;
  signal?: AbortSignal;
};

type BrowserPlaylistZipRequest = Omit<BrowserPlaylistPlanRequest, "name" | "renameInPlace" | "zip"> & {
  /** The game's name, which names the ZIP, the playlist, and renamed discs. */
  name: string;
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  zip: PlaylistZipOptions;
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

// The discs are already compressed or nearly incompressible, and deflating gigabytes in wasm is slow.
const PLAYLIST_ZIP_CODEC = "store";

const CONTROL_CHARACTERS = /\p{Cc}/u;
const PLAYLIST_OUTPUT_FILE = /\.(?:m3u8?|zip)$/i;

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

/** Refuse a path the engine cannot mount, and two files that would share one path. */
const checkSourceFiles = (sources: readonly PlaylistSourceFile[]) => {
  const seen = new Set<string>();
  for (const source of sources) {
    checkSourcePath(source.path);
    // Dropped files from different folders can share a name, and a mount holds one file per path.
    if (seen.has(source.path)) throw new Error(`Two files are named "${source.path}". Add the discs of one game.`);
    seen.add(source.path);
  }
};

/** The files to mount and, among them, the disc files to list. */
const selectPlanFiles = (
  sources: readonly PlaylistSourceFile[],
  discs: readonly string[] | undefined,
  renameInPlace: boolean | undefined,
) => {
  // An existing playlist or ZIP would block the engine from writing a new one beside it, and a download
  // never lands there. Renaming keeps them, so the plan refuses a name that is already taken.
  const mounted = renameInPlace ? sources : sources.filter((source) => !PLAYLIST_OUTPUT_FILE.test(source.path));
  const wanted = discs ? new Set(discs) : null;
  const inputs = mounted.filter((source) => (wanted ? wanted.has(source.path) : isPlaylistDisc(source.path)));
  if (!inputs.length) throw new Error("Add the game's disc files, such as .cue, .chd, or .iso files.");
  return { mounted, inputs };
};

type MountedPlaylistFiles = {
  /** The guest folder the files are mounted under. */
  root: string;
  mounted: readonly PlaylistSourceFile[];
  inputs: readonly PlaylistSourceFile[];
};

const toGuestPath = (root: string, path: string) => `${root}/${path}`;

/** Run the engine's dry run over files already mounted under `root`, and map its paths back. */
const planMountedPlaylist = async (
  { root, mounted, inputs }: MountedPlaylistFiles,
  { name, renameInPlace, zip, logLevel, signal }: BrowserPlaylistPlanRequest,
): Promise<BrowserPlaylistPlan> => {
  const toGuest = (path: string) => toGuestPath(root, path);
  const fromGuest = (path: string) => {
    if (!path.startsWith(`${root}/`)) throw new Error(`The playlist plan named a file outside the folder: ${path}`);
    return path.slice(root.length + 1);
  };
  const plan = (output?: string) =>
    invokeRomWeaverPlaylistPlan({
      inputs: inputs.map((source) => toGuest(source.path)),
      knownPaths: mounted.map((source) => toGuest(source.path)),
      logLevel,
      signal,
      ...(renameInPlace ? { name, renameInPlace } : { output }),
      ...(zip ? { layout: zip.layout, name, rename: zip.rename } : {}),
    });
  let result = await plan(!renameInPlace && name ? toGuest(`${name}.${zip ? "zip" : "m3u"}`) : undefined);
  // Without a name the engine writes the playlist beside the first disc. Lines are relative to
  // the playlist, so a first disc in a subfolder plans again with the playlist at the top.
  if (!(renameInPlace || name) && result.discs[0] && fromGuest(result.discs[0].path).includes("/")) {
    result = await plan(toGuest(result.file_name));
  }
  return {
    ...result,
    discs: result.discs.map((disc) => ({ ...disc, path: fromGuest(disc.path) })),
    renames: result.renames.map((rename) => ({ ...rename, from: fromGuest(rename.from) })),
    bundle: result.bundle.map((file) => (file.source ? { ...file, source: fromGuest(file.source) } : file)),
  };
};

/**
 * Engine messages name the mounted copies; show the paths from the picked folder instead.
 * The engine words some refusals for its command line; the form has a game name field and no flags.
 */
const rewordPlanError = (error: unknown, root: string) => {
  if (error instanceof Error) {
    error.message = error.message
      .replaceAll(`${root}/`, "")
      .replace("; pass --name", ". Type a game name")
      .replace("--rename cannot rename", "Cannot rename");
  }
};

/** Mount the picked files at their exact names, run `use` on them, and release the mounts. */
const withMountedPlaylist = async <Result>(
  request: BrowserPlaylistPlanRequest,
  use: (files: MountedPlaylistFiles) => Promise<Result>,
): Promise<Result> => {
  if (request.zip && !request.name) throw new Error("A ZIP needs a game name.");
  const sources = getPlaylistSourceFiles(request.files);
  checkSourceFiles(sources);
  const { mounted, inputs } = selectPlanFiles(sources, request.discs, request.renameInPlace);
  const root = `${WORKER_OPFS_MOUNTPOINT}/playlist-${crypto.randomUUID()}`;
  const unregister = mounted.map((source) =>
    registerBrowserVirtualFile({
      path: toGuestPath(root, source.path),
      source: source.file,
      trace: { logLevel: request.logLevel },
    }),
  );
  try {
    return await use({ root, mounted, inputs });
  } catch (error) {
    rewordPlanError(error, root);
    throw error;
  } finally {
    for (const release of unregister) release();
  }
};

/**
 * Plan a playlist from picked files with the engine's dry run. The files are mounted at their
 * exact names and relative paths, so the plan's lines and renamed sheets match the real folder.
 */
const planBrowserPlaylist = (request: BrowserPlaylistPlanRequest): Promise<BrowserPlaylistPlan> =>
  withMountedPlaylist(request, (files) => planMountedPlaylist(files, request));

/**
 * Write the `.zip` that {@link planBrowserPlaylist} plans for the same request, into the browser's
 * private storage. The caller saves the returned output and disposes it.
 */
const writeBrowserPlaylistZip = (request: BrowserPlaylistZipRequest): Promise<PublicOutput> =>
  withMountedPlaylist(request, async ({ root, mounted, inputs }) => {
    const { name, zip, logLevel, onEvent, signal } = request;
    const zipName = `${name}.zip`;
    const knownPaths = mounted.map((source) => toGuestPath(root, source.path));
    const scope = createRomWeaverOutputScope();
    const output = scope.selectOutputPath("", zipName, knownPaths);
    try {
      await invokeRomWeaverPlaylistWrite({
        codec: PLAYLIST_ZIP_CODEC,
        inputs: inputs.map((source) => toGuestPath(root, source.path)),
        knownPaths,
        layout: zip.layout,
        logLevel,
        name,
        onEvent,
        output,
        rename: zip.rename,
        signal,
      });
      const [cleanup] = await scope.createOutputCleanups([output], (filePath) => browserVfs.remove(filePath));
      return await createRuntimeOutputFromVfs(browserVfs, output, zipName, { cleanup });
    } catch (error) {
      await scope.cleanup().catch(() => undefined);
      throw await withBrowserOutputStorageFailureContext(error, {
        operationLabel: `write \`${zipName}\``,
        requiredBytes: mounted.reduce((total, source) => total + source.file.size, 0),
      });
    }
  });

export { planBrowserPlaylist, writeBrowserPlaylistZip };
export type { BrowserPlaylistPlan, PlaylistSourceFile, PlaylistZipOptions };
