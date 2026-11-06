import { Download, FolderOpen, FolderPen, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import { getErrorMessage } from "../../lib/errors.ts";
import type { BrowserPlaylistPlan, PlaylistSourceFile } from "../../platform/browser/browser-playlist-api.ts";
import { checkGameName } from "../../storage/browser/playlist-game-name.ts";
import { canWritePlaylistFolders } from "../../storage/browser/playlist-folder-support.ts";
import { resolveAssetUrl } from "../../public/react/asset-url.ts";
import { Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { FileCard } from "../../public/react/components/ds/file-card.tsx";
import { GhostSteps } from "../../public/react/components/ds/ghost-steps.tsx";
import { StepSection } from "../../public/react/components/ds/layout.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import { useRomWeaverAssetBaseUrl } from "../../public/react/settings-context.tsx";
import { WORKFLOW_GUIDES } from "../../public/react/workflow-guides.ts";
import { useAgentWorkflow } from "../agent/workflow-registry.ts";

const PLAYLIST_ACTIVITY_KEY = "playlist";
const CLI_RENAME_GUIDE = "docs/cli-playlist#rename-the-discs";
// A game folder holds discs, their tracks, and maybe one folder per disc; deeper trees are not games.
const MAX_FOLDER_DEPTH = 3;
const MAX_FOLDER_FILES = 2000;
const PLAN_DELAY_MS = 250;

type PlaylistSource = {
  files: PlaylistSourceFile[];
  /** The picked folder, when the browser can change files in it. */
  directory: FileSystemDirectoryHandle | null;
  folderName: string | null;
};

type PlaylistFormProps = {
  onSessionChange: (active: boolean) => void;
  pageDrop?: PageFileDrop | null;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: { id?: string; mode: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** Every file in a picked folder, with paths from that folder. */
const readFolder = async (directory: FileSystemDirectoryHandle) => {
  const files: PlaylistSourceFile[] = [];
  const walk = async (folder: FileSystemDirectoryHandle, prefix: string, depth: number) => {
    for await (const entry of (
      folder as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> }
    ).values()) {
      if (files.length >= MAX_FOLDER_FILES) {
        throw new Error(`"${directory.name}" holds more than ${MAX_FOLDER_FILES} files. Pick the folder of one game.`);
      }
      const path = `${prefix}${entry.name}`;
      if (entry.kind === "file") files.push({ file: await (entry as FileSystemFileHandle).getFile(), path });
      else if (depth < MAX_FOLDER_DEPTH) await walk(entry as FileSystemDirectoryHandle, `${path}/`, depth + 1);
    }
  };
  await walk(directory, "", 1);
  return files;
};

/** Files from `<input webkitdirectory>`, with the picked folder's own name taken off their paths. */
const readFolderInput = (list: FileList) => {
  const files = Array.from(list);
  const folderName = files[0]?.webkitRelativePath.split("/")[0] ?? null;
  return {
    files: files.map((file) => ({ file, path: file.webkitRelativePath.split("/").slice(1).join("/") || file.name })),
    folderName,
  };
};

const PlaylistForm = ({ onSessionChange, pageDrop }: PlaylistFormProps) => {
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  const [canWriteFolders, setCanWriteFolders] = useState(false);
  const [source, setSource] = useState<PlaylistSource | null>(null);
  const [survey, setSurvey] = useState<BrowserPlaylistPlan | null>(null);
  const [game, setGame] = useState("");
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<BrowserPlaylistPlan | null>(null);
  const [rename, setRename] = useState(false);
  const [renamePlan, setRenamePlan] = useState<BrowserPlaylistPlan | null>(null);
  const [renameReason, setRenameReason] = useState("");
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState<"open" | "save" | "rename" | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const handledDropRef = useRef(0);
  const planRunRef = useRef(0);
  const surveyRef = useRef<BrowserPlaylistPlan | null>(null);
  const plannedSourceRef = useRef<PlaylistSource | null>(null);
  const busyRef = useRef(false);
  const nameProblem = checkGameName(name);

  useEffect(() => {
    // Read after hydration: the prerendered page cannot know the browser.
    setCanWriteFolders(canWritePlaylistFolders());
  }, []);
  useEffect(() => {
    onSessionChange(busy === "rename");
  }, [busy, onSessionChange]);
  useEffect(() => {
    if (busy || planning) setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { stage: "Make playlist", state: "running" });
    else if (error) setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "failed" });
    else if (done) setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { stage: done, state: "done" });
    else if (source) setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "ready" });
    else setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "idle" });
  }, [busy, done, error, planning, source]);
  useEffect(() => () => setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "idle" }), []);

  const games = useMemo(() => [...new Set((survey?.discs ?? []).map((disc) => disc.game))], [survey]);
  const allAtTop = !!plan && plan.discs.every((disc) => !disc.path.includes("/"));
  const canRename = canWriteFolders && !!source?.directory;
  // A click must ask for folder access while it still counts as a user action, so the writer loads before the click.
  useEffect(() => {
    if (canRename) void import("../../storage/browser/playlist-folder-write.ts");
  }, [canRename]);
  // Discs in subfolders cannot be renamed in place, so a choice left from another folder or game is ignored.
  const renaming = rename && canRename && allAtTop;

  // Plan again whenever the inputs, the game, or the name change. A newer run wins. New files
  // plan at once; later changes wait for typing to pause.
  useEffect(() => {
    if (!source) return;
    const delay = plannedSourceRef.current === source ? PLAN_DELAY_MS : 0;
    plannedSourceRef.current = source;
    const run = planRunRef.current + 1;
    planRunRef.current = run;
    const abort = new AbortController();
    // The shown plan is stale from here on, so actions wait for the new one.
    setPlanning(true);
    const timer = setTimeout(() => {
      void (async () => {
        const { planBrowserPlaylist } = await import("../../platform/browser/browser-playlist-api.ts");
        const typedName = nameProblem ? "" : name.trim();
        try {
          // Discs named only by number give the engine no game name, so a survey that failed unnamed runs again with the typed one.
          const cachedSurvey = surveyRef.current;
          const all =
            cachedSurvey ??
            (await planBrowserPlaylist({ files: source.files, name: typedName || undefined, signal: abort.signal }));
          if (planRunRef.current !== run) return;
          if (!typedName) surveyRef.current = all;
          setSurvey(all);
          const discs = all.discs.some((disc) => disc.game !== all.discs[0]?.game)
            ? all.discs.filter((disc) => disc.game === (game || all.discs[0]?.game)).map((disc) => disc.path)
            : undefined;
          // A survey planned with the typed name is already the plan.
          const next =
            discs || (typedName && cachedSurvey)
              ? await planBrowserPlaylist({
                  discs,
                  files: source.files,
                  name: typedName || undefined,
                  signal: abort.signal,
                })
              : all;
          if (planRunRef.current !== run) return;
          setPlan(next);
          setError("");
          if (!(rename && canRename)) {
            setRenamePlan(null);
            setRenameReason("");
            return;
          }
          try {
            const renamed = await planBrowserPlaylist({
              discs: next.discs.map((disc) => disc.path),
              files: source.files,
              name: typedName || undefined,
              renameInPlace: true,
              signal: abort.signal,
            });
            if (planRunRef.current !== run) return;
            setRenamePlan(renamed);
            setRenameReason("");
          } catch (cause) {
            if (planRunRef.current !== run || isAbort(cause)) return;
            setRenamePlan(null);
            setRenameReason(getErrorMessage(cause));
          }
        } catch (cause) {
          if (planRunRef.current !== run || isAbort(cause)) return;
          setPlan(null);
          setRenamePlan(null);
          setError(getErrorMessage(cause));
        } finally {
          if (planRunRef.current === run) setPlanning(false);
        }
      })();
    }, delay);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [canRename, game, name, nameProblem, rename, source]);

  const replaceSource = useCallback((next: PlaylistSource | null) => {
    planRunRef.current += 1;
    surveyRef.current = null;
    setSource(next);
    setSurvey(null);
    setPlan(null);
    setRenamePlan(null);
    setRenameReason("");
    setGame("");
    setError("");
    setDone("");
    setPlanning(false);
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      if (busyRef.current || !files.length) return;
      replaceSource({ directory: null, files: files.map((file) => ({ file, path: file.name })), folderName: null });
    },
    [replaceSource],
  );

  useEffect(() => {
    if (!(pageDrop && pageDrop.id !== handledDropRef.current)) return;
    handledDropRef.current = pageDrop.id;
    addFiles(pageDrop.files);
    pageDrop.onConsumed?.();
  }, [addFiles, pageDrop]);

  const runAction = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    setError("");
    setDone("");
    try {
      await action();
    } catch (cause) {
      if (!isAbort(cause)) setError(getErrorMessage(cause));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const openFolder = () => {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    // Check now rather than read canWriteFolders: it is set after the first render, and a click can come first.
    if (!(canWritePlaylistFolders() && picker)) {
      folderInputRef.current?.click();
      return;
    }
    void runAction("open", async () => {
      const directory = await picker.call(window, { id: "rom-weaver-playlist", mode: "read" });
      replaceSource({ directory, files: await readFolder(directory), folderName: directory.name });
    });
  };

  const reloadFolder = async (directory: FileSystemDirectoryHandle) => {
    replaceSource({ directory, files: await readFolder(directory), folderName: directory.name });
  };

  const download = () =>
    void runAction("save", async () => {
      if (!plan) return;
      const { triggerBrowserDownload } = await import("../../platform/browser/browser-download.ts");
      await triggerBrowserDownload(new Blob([plan.text], { type: "audio/x-mpegurl" }), plan.file_name, {
        interactive: true,
      });
      setDone(`Downloaded ${plan.file_name}`);
    });

  const saveToFolder = () => {
    const directory = source?.directory;
    if (!(directory && plan)) return;
    void runAction("save", async () => {
      const folder = await import("../../storage/browser/playlist-folder-write.ts");
      await folder.requestPlaylistFolderAccess(directory);
      await folder.savePlaylistToFolder(directory, plan.file_name, plan.text);
      setDone(`Saved ${plan.file_name} in ${directory.name}`);
    });
  };

  const renameDiscs = () => {
    const directory = source?.directory;
    if (!(directory && renamePlan && source)) return;
    const planned = new Map(
      source.files.map((entry) => [entry.path, { lastModified: entry.file.lastModified, size: entry.file.size }]),
    );
    void runAction("rename", async () => {
      const folder = await import("../../storage/browser/playlist-folder-write.ts");
      await folder.requestPlaylistFolderAccess(directory);
      await folder.renamePlaylistFolder({
        directory,
        planned,
        playlist: { fileName: renamePlan.file_name, text: renamePlan.text },
        renames: renamePlan.renames,
      });
      setRename(false);
      await reloadFolder(directory);
      setDone(`Renamed ${renamePlan.renames.length} files and saved ${renamePlan.file_name} in ${directory.name}`);
    });
  };

  useAgentWorkflow(PLAYLIST_ACTIVITY_KEY, {
    actions: {
      download: {
        description: "Download the .m3u playlist.",
        enabled: !!plan && !busy && !planning && !nameProblem,
        execute: () => download(),
      },
    },
    getState: () => ({
      busy,
      entries: plan?.entries ?? [],
      error: error || null,
      fileName: plan?.file_name ?? null,
      files: source?.files.length ?? 0,
      planning,
    }),
  });

  const locked = !!busy;
  const actionsReady = !!plan && !planning && !locked && !nameProblem;
  let folderHint = "";
  if (source?.directory) {
    if (plan && !allAtTop) {
      folderHint =
        "The discs are in subfolders, so the playlist lists their paths. Save it into the folder you opened.";
    }
  } else {
    folderHint = "Open the game's folder to save the playlist into it or rename its discs.";
  }
  const renameNote = renaming ? renameReason : "";

  return (
    <section className="panel" id="playlist-container">
      {/* Without a source the steps below are hidden, so a failed folder pick reports here. */}
      {!source && error ? (
        <Notice level="error" onDismiss={() => setError("")}>
          {error}
        </Notice>
      ) : null}
      <UnifiedDropZone
        addLabel="Replace the discs"
        // Below the drop target, not in the header: on phones the whole header is the add-files button.
        afterDropZone={
          <button className="btn slim ghost" disabled={locked} onClick={openFolder} type="button">
            <FolderOpen aria-hidden="true" />
            {busy === "open" ? "Opening folder…" : "Open game folder"}
          </button>
        }
        big={!source}
        disabled={locked}
        guide={WORKFLOW_GUIDES.playlist}
        heroLabel="Drop the discs of one game"
        heroLabelCoarse="Tap to add the discs of one game"
        info={<p>A playlist lists each disc of a multi-disc game, so an emulator can change discs.</p>}
        inputId="playlist-input-picker"
        lead={{ description: "ui.hero.playlistDescription", line1: "ui.hero.playlistThesis" }}
        onFiles={addFiles}
        supported={[
          { extensions: ["cue", "gdi", "ccd", "mds", "chd", "iso", "cso", "pbp", "rvz"], label: "Disc files" },
        ]}
      />
      <input
        aria-hidden="true"
        className="sr-only"
        hidden
        multiple
        onChange={(event) => {
          const list = event.currentTarget.files;
          if (list?.length) {
            const { files, folderName } = readFolderInput(list);
            replaceSource({ directory: null, files, folderName });
          }
          event.currentTarget.value = "";
        }}
        ref={(input) => {
          folderInputRef.current = input;
          input?.setAttribute("webkitdirectory", "");
        }}
        tabIndex={-1}
        type="file"
      />
      {source ? null : (
        <GhostSteps
          steps={[
            { num: "0x02", title: "Playlist" },
            { num: "0x03", title: "Save" },
          ]}
        />
      )}
      {source ? (
        <>
          <StepSection
            fault={!!error}
            meta={source.folderName ? <span className="mono">{source.folderName}</span> : undefined}
            num="0x02"
            title="Playlist"
          >
            {games.length > 1 ? (
              <label className="checkrow">
                <span>Game</span>
                <select
                  className="select mono"
                  disabled={locked}
                  onChange={(event) => setGame(event.currentTarget.value)}
                  value={game || games[0]}
                >
                  {games.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="checkrow">
              <span>Game name</span>
              <input
                aria-invalid={nameProblem ? "true" : undefined}
                className="input mono"
                disabled={locked}
                id="playlist-name"
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder={plan ? plan.file_name.replace(/\.m3u$/i, "") : ""}
                spellCheck={false}
                type="text"
                value={name}
              />
            </label>
            {nameProblem ? <Notice level="error">{nameProblem}</Notice> : null}
            {planning && !plan ? <p role="status">Reading the disc sheets…</p> : null}
            {plan ? (
              <div className="cards" id="playlist-entries">
                {(renamePlan && renaming ? renamePlan.entries : plan.entries).map((line, index) => (
                  <FileCard
                    key={line}
                    meta={<span className="meta-fmt mono">Disc {index + 1}</span>}
                    name={<span className="nm mono">{line}</span>}
                  />
                ))}
              </div>
            ) : null}
            {error ? (
              <Notice level="error" onDismiss={() => setError("")}>
                {error}
              </Notice>
            ) : null}
          </StepSection>
          <StepSection num="0x03" title="Save" woven={!!done}>
            <label className="checkrow">
              <input
                checked={renaming}
                disabled={!canRename || locked || !allAtTop}
                id="playlist-rename-discs"
                onChange={(event) => setRename(event.currentTarget.checked)}
                type="checkbox"
              />
              <FolderPen aria-hidden="true" />
              <span>
                Rename the discs to <span className="mono">{name.trim() || "Game"} (Disc N)</span>
              </span>
            </label>
            {renameNote ? <Notice level="warn">Can't rename these discs: {renameNote}</Notice> : null}
            {renaming && renamePlan ? (
              <div className="cards" id="playlist-renames">
                {renamePlan.renames.map((entry) => (
                  <FileCard
                    key={entry.from}
                    meta={<span className="meta-fmt mono">→ {entry.to}</span>}
                    name={<span className="nm mono">{entry.from}</span>}
                  />
                ))}
              </div>
            ) : null}
            {canWriteFolders ? (
              folderHint ? (
                <p className="hint">{folderHint}</p>
              ) : null
            ) : (
              <Notice level="info">
                Saving into a folder and renaming discs need Chrome or Edge on a computer. You can still download the
                playlist and save it beside the discs, or{" "}
                <a href={resolveAssetUrl(assetBaseUrl, CLI_RENAME_GUIDE)}>rename the discs with the command line</a>.
              </Notice>
            )}
            <div className="outbar">
              {renaming ? (
                <RunButton
                  disabled={!(actionsReady && renamePlan)}
                  icon={<FolderPen aria-hidden="true" />}
                  id="playlist-rename"
                  onClick={renameDiscs}
                >
                  {busy === "rename" ? "Renaming discs…" : "Rename discs and save playlist"}
                </RunButton>
              ) : (
                <>
                  <RunButton
                    disabled={!actionsReady}
                    icon={<Download aria-hidden="true" />}
                    id="playlist-download"
                    onClick={download}
                  >
                    {plan ? `Download ${plan.file_name}` : "Download playlist"}
                  </RunButton>
                  <button
                    className="btn ghost"
                    disabled={!(canWriteFolders && actionsReady && source.directory)}
                    id="playlist-save-folder"
                    onClick={saveToFolder}
                    type="button"
                  >
                    <Save aria-hidden="true" />
                    {busy === "save" ? "Saving…" : "Save into folder"}
                  </button>
                </>
              )}
            </div>
            {done ? <Notice level="info">{done}</Notice> : null}
          </StepSection>
        </>
      ) : null}
    </section>
  );
};

export { PlaylistForm };
export type { PlaylistFormProps };
