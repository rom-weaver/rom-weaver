import { Download, FolderOpen, FolderPen, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import { getErrorMessage } from "../../lib/errors.ts";
import type {
  BrowserPlaylistPlan,
  PlaylistSourceFile,
  planBrowserPlaylist,
} from "../../platform/browser/browser-playlist-api.ts";
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

type PlaylistActivityInput = {
  busy: boolean;
  planning: boolean;
  error: string;
  done: string;
  hasSource: boolean;
};

const getPlaylistActivity = ({ busy, planning, error, done, hasSource }: PlaylistActivityInput) => {
  if (busy || planning) return { stage: "Make playlist", state: "running" } as const;
  if (error) return { state: "failed" } as const;
  if (done) return { stage: done, state: "done" } as const;
  if (hasSource) return { state: "ready" } as const;
  return { state: "idle" } as const;
};

/** What one planning run reads: the files, the typed game name, and the planner the run loaded. */
type PlanRequest = {
  files: PlaylistSourceFile[];
  /** The game chosen among the survey's games; empty for the first. */
  game: string;
  /** The game name typed in the form; empty when none or when it cannot name a file. */
  typedName: string;
  planPlaylist: typeof planBrowserPlaylist;
  signal: AbortSignal;
};

const planPlaylistDiscs = (request: PlanRequest, discs?: string[], renameInPlace?: boolean) =>
  request.planPlaylist({
    discs,
    files: request.files,
    name: request.typedName || undefined,
    renameInPlace,
    signal: request.signal,
  });

/** The discs of the chosen game when the survey holds several games; undefined for every disc. */
const chooseGameDiscs = (survey: BrowserPlaylistPlan, game: string) => {
  const firstGame = survey.discs[0]?.game;
  if (survey.discs.every((disc) => disc.game === firstGame)) return undefined;
  return survey.discs.filter((disc) => disc.game === (game || firstGame)).map((disc) => disc.path);
};

/** Plan the survey's chosen game, reusing the survey when it already is that plan. */
const planChosenGame = async (request: PlanRequest, survey: BrowserPlaylistPlan, surveyWasCached: boolean) => {
  const discs = chooseGameDiscs(survey, request.game);
  // A survey planned with the typed name is already the plan.
  if (!(discs || (request.typedName && surveyWasCached))) return survey;
  return planPlaylistDiscs(request, discs);
};

/** Plan renaming the discs in place, or say why it cannot; an abort is rethrown. */
const planRenameInPlace = async (request: PlanRequest, plan: BrowserPlaylistPlan) => {
  try {
    const renamePlan = await planPlaylistDiscs(
      request,
      plan.discs.map((disc) => disc.path),
      true,
    );
    return { renamePlan, reason: "" };
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    return { renamePlan: null, reason: getErrorMessage(cause) };
  }
};

/** The hint under the save options; empty when there is nothing to say. */
const getFolderHint = (hasFolder: boolean, plan: BrowserPlaylistPlan | null, allAtTop: boolean) => {
  if (!hasFolder) return "Open the game's folder to save the playlist into it or rename its discs.";
  if (plan && !allAtTop) {
    return "The discs are in subfolders, so the playlist lists their paths. Save it into the folder you opened.";
  }
  return "";
};

type GameSelectProps = { games: string[]; game: string; locked: boolean; onChange: (game: string) => void };

/** Choose which game's discs to list when the picked files hold several games. */
const GameSelect = ({ games, game, locked, onChange }: GameSelectProps) => {
  if (games.length < 2) return null;
  return (
    <label className="checkrow">
      <span>Game</span>
      <select
        className="select mono"
        disabled={locked}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={game || games[0]}
      >
        {games.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
};

type GameNameFieldProps = {
  name: string;
  plan: BrowserPlaylistPlan | null;
  problem: string;
  locked: boolean;
  onChange: (name: string) => void;
};

/** The game name input, showing the playlist's name until one is typed, and why a name cannot be used. */
const GameNameField = ({ name, plan, problem, locked, onChange }: GameNameFieldProps) => (
  <>
    <label className="checkrow">
      <span>Game name</span>
      <input
        aria-invalid={problem ? "true" : undefined}
        className="input mono"
        disabled={locked}
        id="playlist-name"
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={plan ? plan.file_name.replace(/\.m3u$/i, "") : ""}
        spellCheck={false}
        type="text"
        value={name}
      />
    </label>
    {problem ? <Notice level="error">{problem}</Notice> : null}
  </>
);

type RenameChoiceProps = {
  renaming: boolean;
  disabled: boolean;
  name: string;
  /** Why the discs cannot be renamed; empty when they can. */
  reason: string;
  onChange: (rename: boolean) => void;
};

/** The checkbox to rename the discs after the game, and why that is not possible when it is not. */
const RenameChoice = ({ renaming, disabled, name, reason, onChange }: RenameChoiceProps) => (
  <>
    <label className="checkrow">
      <input
        checked={renaming}
        disabled={disabled}
        id="playlist-rename-discs"
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <FolderPen aria-hidden="true" />
      <span>
        Rename the discs to <span className="mono">{name.trim() || "Game"} (Disc N)</span>
      </span>
    </label>
    {reason ? <Notice level="warn">Can't rename these discs: {reason}</Notice> : null}
  </>
);

/** An error from the form, which the user can dismiss. */
const ErrorNotice = ({ error, onDismiss }: { error: string; onDismiss: () => void }) =>
  error ? (
    <Notice level="error" onDismiss={onDismiss}>
      {error}
    </Notice>
  ) : null;

type OpenFolderButtonProps = { opening: boolean; locked: boolean; onClick: () => void };

/** Opens the game's folder, which lets the page save the playlist into it and rename its discs. */
const OpenFolderButton = ({ opening, locked, onClick }: OpenFolderButtonProps) => (
  <button className="btn slim ghost" disabled={locked} onClick={onClick} type="button">
    <FolderOpen aria-hidden="true" />
    {opening ? "Opening folder…" : "Open game folder"}
  </button>
);

type PlaylistEntriesProps = {
  plan: BrowserPlaylistPlan | null;
  planning: boolean;
  renamePlan: BrowserPlaylistPlan | null;
  renaming: boolean;
};

/** The playlist's lines, one card per disc, or a status while the first plan is read. */
const PlaylistEntries = ({ plan, planning, renamePlan, renaming }: PlaylistEntriesProps) => {
  if (!plan) return planning ? <p role="status">Reading the disc sheets…</p> : null;
  const lines = renamePlan && renaming ? renamePlan.entries : plan.entries;
  return (
    <div className="cards" id="playlist-entries">
      {lines.map((line, index) => (
        <FileCard
          key={line}
          meta={<span className="meta-fmt mono">Disc {index + 1}</span>}
          name={<span className="nm mono">{line}</span>}
        />
      ))}
    </div>
  );
};

/** The files the rename-in-place plan renames, one card per file; nothing unless renaming. */
const RenameCards = ({ renamePlan, renaming }: { renamePlan: BrowserPlaylistPlan | null; renaming: boolean }) => {
  if (!(renaming && renamePlan)) return null;
  return (
    <div className="cards" id="playlist-renames">
      {renamePlan.renames.map((entry) => (
        <FileCard
          key={entry.from}
          meta={<span className="meta-fmt mono">→ {entry.to}</span>}
          name={<span className="nm mono">{entry.from}</span>}
        />
      ))}
    </div>
  );
};

/** The hint under the save options, or the notice that this browser cannot write folders. */
const FolderSupportNote = ({ canWriteFolders, folderHint }: { canWriteFolders: boolean; folderHint: string }) => {
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  if (!canWriteFolders) {
    return (
      <Notice level="info">
        Saving into a folder and renaming discs need Chrome or Edge on a computer. You can still download the playlist
        and save it beside the discs, or{" "}
        <a href={resolveAssetUrl(assetBaseUrl, CLI_RENAME_GUIDE)}>rename the discs with the command line</a>.
      </Notice>
    );
  }
  return folderHint ? <p className="hint">{folderHint}</p> : null;
};

type SaveActionsProps = {
  busy: "open" | "save" | "rename" | null;
  plan: BrowserPlaylistPlan | null;
  renaming: boolean;
  renamePlan: BrowserPlaylistPlan | null;
  actionsReady: boolean;
  canSaveToFolder: boolean;
  onDownload: () => void;
  onRename: () => void;
  onSaveToFolder: () => void;
};

/** The buttons that finish the playlist: rename the discs and save it, or download or save it. */
const SaveActions = ({
  busy,
  plan,
  renaming,
  renamePlan,
  actionsReady,
  canSaveToFolder,
  onDownload,
  onRename,
  onSaveToFolder,
}: SaveActionsProps) => {
  if (renaming) {
    return (
      <RunButton
        disabled={!(actionsReady && renamePlan)}
        icon={<FolderPen aria-hidden="true" />}
        id="playlist-rename"
        onClick={onRename}
      >
        {busy === "rename" ? "Renaming discs…" : "Rename discs and save playlist"}
      </RunButton>
    );
  }
  return (
    <>
      <RunButton
        disabled={!actionsReady}
        icon={<Download aria-hidden="true" />}
        id="playlist-download"
        onClick={onDownload}
      >
        {plan ? `Download ${plan.file_name}` : "Download playlist"}
      </RunButton>
      <button
        className="btn ghost"
        disabled={!(canSaveToFolder && actionsReady)}
        id="playlist-save-folder"
        onClick={onSaveToFolder}
        type="button"
      >
        <Save aria-hidden="true" />
        {busy === "save" ? "Saving…" : "Save into folder"}
      </button>
    </>
  );
};

const PlaylistForm = ({ onSessionChange, pageDrop }: PlaylistFormProps) => {
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
    setWorkbenchActivity(
      PLAYLIST_ACTIVITY_KEY,
      getPlaylistActivity({ busy: !!busy, done, error, hasSource: !!source, planning }),
    );
  }, [busy, done, error, planning, source]);
  useEffect(() => () => setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "idle" }), []);

  const games = useMemo(() => [...new Set((survey?.discs ?? []).map((disc) => disc.game))], [survey]);
  const allAtTop = !!plan && plan.discs.every((disc) => !disc.path.includes("/"));
  const canRename = canWriteFolders && !!source?.directory;
  // A click must ask for folder access while it still counts as a user action, so the writer loads before the click.
  useEffect(() => {
    if (canRename) void import("../../storage/browser/playlist-folder-write.ts");
  }, [canRename]);
  // Discs in subfolders cannot be renamed in place, so a choice made for another game is ignored.
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
        const request: PlanRequest = {
          files: source.files,
          game,
          planPlaylist: planBrowserPlaylist,
          signal: abort.signal,
          typedName: nameProblem ? "" : name.trim(),
        };
        try {
          // Discs named only by number give the engine no game name, so a survey that failed unnamed runs again with the typed one.
          const cachedSurvey = surveyRef.current;
          const all = cachedSurvey ?? (await planPlaylistDiscs(request));
          if (planRunRef.current !== run) return;
          if (!request.typedName) surveyRef.current = all;
          setSurvey(all);
          const next = await planChosenGame(request, all, !!cachedSurvey);
          if (planRunRef.current !== run) return;
          setPlan(next);
          setError("");
          if (!(rename && canRename)) {
            setRenamePlan(null);
            setRenameReason("");
            return;
          }
          const renamed = await planRenameInPlace(request, next);
          if (planRunRef.current !== run) return;
          setRenamePlan(renamed.renamePlan);
          setRenameReason(renamed.reason);
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
    // Renaming moves files, so a new folder starts without the last folder's choice.
    setRename(false);
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
  const folderHint = getFolderHint(!!source?.directory, plan, allAtTop);
  const renameNote = renaming ? renameReason : "";

  return (
    <section className="panel" id="playlist-container">
      {/* Without a source the steps below are hidden, so a failed folder pick reports here. */}
      {source ? null : <ErrorNotice error={error} onDismiss={() => setError("")} />}
      <UnifiedDropZone
        addLabel="Replace the discs"
        // Below the drop target, not in the header: on phones the whole header is the add-files button.
        afterDropZone={<OpenFolderButton locked={locked} onClick={openFolder} opening={busy === "open"} />}
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
            <GameSelect games={games} game={game} locked={locked} onChange={setGame} />
            <GameNameField locked={locked} name={name} onChange={setName} plan={plan} problem={nameProblem} />
            <PlaylistEntries plan={plan} planning={planning} renamePlan={renamePlan} renaming={renaming} />
            <ErrorNotice error={error} onDismiss={() => setError("")} />
          </StepSection>
          <StepSection num="0x03" title="Save" woven={!!done}>
            <RenameChoice
              disabled={!canRename || locked || !allAtTop}
              name={name}
              onChange={setRename}
              reason={renameNote}
              renaming={renaming}
            />
            <RenameCards renamePlan={renamePlan} renaming={renaming} />
            <FolderSupportNote canWriteFolders={canWriteFolders} folderHint={folderHint} />
            <div className="outbar">
              <SaveActions
                actionsReady={actionsReady}
                busy={busy}
                canSaveToFolder={canWriteFolders && !!source.directory}
                onDownload={download}
                onRename={renameDiscs}
                onSaveToFolder={saveToFolder}
                plan={plan}
                renamePlan={renamePlan}
                renaming={renaming}
              />
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
