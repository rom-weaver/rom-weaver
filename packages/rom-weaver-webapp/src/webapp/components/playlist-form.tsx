import { Archive, Disc, FolderOpen, FolderPen, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import { getErrorMessage } from "../../lib/errors.ts";
import type { MessageId } from "../../presentation/localization/catalog.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
import type {
  BrowserPlaylistPlan,
  PlaylistSourceFile,
  PlaylistZipOptions,
  planBrowserPlaylist,
} from "../../platform/browser/browser-playlist-api.ts";
import { checkGameName, type GameNameProblem } from "../../storage/browser/playlist-game-name.ts";
import { getBaseName } from "../../storage/shared/path-utils.ts";
import { canWritePlaylistFolders } from "../../storage/browser/playlist-folder-support.ts";
import { Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { FileCard } from "../../public/react/components/ds/file-card.tsx";
import { GhostSteps } from "../../public/react/components/ds/ghost-steps.tsx";
import { StepSection } from "../../public/react/components/ds/layout.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { WORKFLOW_GUIDES } from "../../public/react/workflow-guides.ts";
import type { PlaylistLayout } from "../../wasm/generated/rom-weaver-rust-types.d.ts";
import { useAgentWorkflow } from "../agent/workflow-registry.ts";
import { trackFilePicker } from "../file-picker-state.ts";
import { useKeptZip } from "../use-kept-zip.ts";

const PLAYLIST_ACTIVITY_KEY = "playlist";
// A game folder holds discs, their tracks, and maybe one folder per disc; deeper trees are not games.
const MAX_FOLDER_DEPTH = 3;
const MAX_FOLDER_FILES = 2000;
const PLAN_DELAY_MS = 250;

// Stands in for the game's name while a message is split around it. The name can then be styled in place.
const NAME_SLOT = "\uE000";

const PLAYLIST_LAYOUTS: ReadonlyArray<{ layout: PlaylistLayout; label: MessageId }> = [
  { label: "ui.playlist.layoutFlat", layout: "flat" },
  { label: "ui.playlist.layoutFolder", layout: "folder" },
  { label: "ui.playlist.layoutM3uFolder", layout: "m3u-folder" },
  { label: "ui.playlist.layoutDiscFolders", layout: "disc-folders" },
];

const NAME_PROBLEM_MESSAGES: Record<GameNameProblem, MessageId> = {
  characters: "ui.playlist.nameCharacters",
  dot: "ui.playlist.nameDot",
  length: "ui.playlist.nameLength",
  windows: "ui.playlist.nameWindows",
};

/** How the discs are saved: renamed where they are, as a ZIP, or as a lone playlist. */
type OutputMode = "in-place" | "zip" | "m3u";

type OutputChoices = {
  canRename: boolean;
  chd: boolean;
  layout: PlaylistLayout;
  plan: BrowserPlaylistPlan | null;
  rename: boolean;
};

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

const isAllAtTop = (plan: BrowserPlaylistPlan) => plan.discs.every((disc) => !disc.path.includes("/"));

/** The game's name, which names the playlist and the ZIP. */
const getGameName = (plan: BrowserPlaylistPlan) => plan.file_name.replace(/\.m3u$/i, "");

// In-place renaming changes the picked folder. It needs a writable folder, every disc at the top,
// and the playlist beside them. Any other rename or layout, or discs compressed to CHD, go into a ZIP.
const getOutputMode = ({ canRename, chd, layout, plan, rename }: OutputChoices): OutputMode => {
  const keepsDiscFiles = layout === "flat" && !chd;
  const fitsInPlace = canRename && keepsDiscFiles && !!plan && isAllAtTop(plan);
  if (rename && fitsInPlace) return "in-place";
  return rename || chd || layout !== "flat" ? "zip" : "m3u";
};

/** Every file in a picked folder, with paths from that folder. */
const readFolder = async (directory: FileSystemDirectoryHandle, localizer: Localizer) => {
  const files: PlaylistSourceFile[] = [];
  const walk = async (folder: FileSystemDirectoryHandle, prefix: string, depth: number) => {
    for await (const entry of (
      folder as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> }
    ).values()) {
      if (files.length >= MAX_FOLDER_FILES) {
        throw new Error(
          localizer.message("ui.playlist.folderTooLarge", { folder: directory.name, max: MAX_FOLDER_FILES }),
        );
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
  localizer: Localizer;
};

const getPlaylistActivity = ({ busy, planning, error, done, hasSource, localizer }: PlaylistActivityInput) => {
  if (busy || planning) return { stage: localizer.message("ui.playlist.activityStage"), state: "running" } as const;
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

/** What a planning run changes about the playlist it plans: its output, and the name that output needs. */
type PlannedOutput = { name?: string; renameInPlace?: boolean; zip?: PlaylistZipOptions };

const planPlaylistDiscs = (request: PlanRequest, discs?: string[], output?: PlannedOutput) =>
  request.planPlaylist({
    discs,
    files: request.files,
    name: request.typedName || undefined,
    signal: request.signal,
    ...output,
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

/** What the Save step writes: a rename in place, else a ZIP. The ZIP is planned even when only the playlist is saved. */
const getPlannedOutput = (mode: OutputMode, plan: BrowserPlaylistPlan, zip: PlaylistZipOptions): PlannedOutput =>
  mode === "in-place" ? { renameInPlace: true } : { name: getGameName(plan), zip };

/** Plan the output, or say why it cannot be made; an abort is rethrown. */
const planOutput = async (request: PlanRequest, plan: BrowserPlaylistPlan, output: PlannedOutput) => {
  try {
    const outputPlan = await planPlaylistDiscs(
      request,
      plan.discs.map((disc) => disc.path),
      output,
    );
    return { outputPlan, reason: "" };
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    return { outputPlan: null, reason: getErrorMessage(cause) };
  }
};

type PlanJob = {
  request: PlanRequest;
  cachedSurvey: BrowserPlaylistPlan | null;
  choices: Omit<OutputChoices, "plan">;
  /** False once a newer run has taken over. */
  isCurrent: () => boolean;
};

type PlanReport = {
  onSurvey: (survey: BrowserPlaylistPlan) => void;
  onPlan: (plan: BrowserPlaylistPlan) => void;
  onOutput: (output: { outputPlan: BrowserPlaylistPlan | null; reason: string }) => void;
};

/** Plan every disc, then the chosen game, then what Save writes. Each result is reported as it is ready. */
const planPlaylistSource = async ({ request, cachedSurvey, choices, isCurrent }: PlanJob, report: PlanReport) => {
  // Discs named only by number give no game name. A survey that failed unnamed runs again with the typed name.
  const survey = cachedSurvey ?? (await planPlaylistDiscs(request));
  if (!isCurrent()) return;
  report.onSurvey(survey);
  const plan = await planChosenGame(request, survey, !!cachedSurvey);
  if (!isCurrent()) return;
  report.onPlan(plan);
  const mode = getOutputMode({ ...choices, plan });
  const zip = { chd: choices.chd, layout: choices.layout, rename: choices.rename };
  const output = await planOutput(request, plan, getPlannedOutput(mode, plan, zip));
  if (isCurrent()) report.onOutput(output);
};

/** The hint under the save options; empty when there is nothing to say. */
const getFolderHint = (
  localizer: Localizer,
  { allAtTop, hasFolder, plan }: { allAtTop: boolean; hasFolder: boolean; plan: BrowserPlaylistPlan | null },
) => {
  if (!hasFolder) return localizer.message("ui.playlist.hintOpenFolder");
  if (plan && !allAtTop) return localizer.message("ui.playlist.hintSubfolders");
  return "";
};

type GameSelectProps = { games: string[]; game: string; locked: boolean; onChange: (game: string) => void };

/** Choose which game's discs to list when the picked files hold several games. */
const GameSelect = ({ games, game, locked, onChange }: GameSelectProps) => {
  const localizer = useUiLocalizer();
  if (games.length < 2) return null;
  return (
    <label className="checkrow">
      <span>{localizer.message("ui.playlist.game")}</span>
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
  problem: GameNameProblem | null;
  locked: boolean;
  onChange: (name: string) => void;
};

/** The game name input, showing the playlist's name until one is typed, and why a name cannot be used. */
const GameNameField = ({ name, plan, problem, locked, onChange }: GameNameFieldProps) => {
  const localizer = useUiLocalizer();
  return (
    <>
      <label className="checkrow">
        <span>{localizer.message("ui.playlist.gameName")}</span>
        <input
          aria-invalid={problem ? "true" : undefined}
          className="input mono"
          disabled={locked}
          id="playlist-name"
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={plan ? getGameName(plan) : ""}
          spellCheck={false}
          type="text"
          value={name}
        />
      </label>
      {problem ? (
        <Notice level="error">{localizer.message(NAME_PROBLEM_MESSAGES[problem], { name: name.trim() })}</Notice>
      ) : null}
    </>
  );
};

type RenameChoiceProps = {
  renaming: boolean;
  disabled: boolean;
  name: string;
  /** Why the output cannot be made; empty when it can. */
  reason: string;
  /** Whether the plan that failed renamed the discs without compressing them. It picks what the warning calls the failure. */
  reasonFromRename: boolean;
  onChange: (rename: boolean) => void;
};

/** The checkbox to rename the discs after the game. It also says why the ZIP or the rename cannot be made. */
const RenameChoice = ({ renaming, disabled, name, reason, reasonFromRename, onChange }: RenameChoiceProps) => {
  const localizer = useUiLocalizer();
  const [before, after] = localizer.message("ui.playlist.renameDiscs", { name: NAME_SLOT }).split(NAME_SLOT);
  return (
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
          {before}
          <span className="mono">{name.trim() || "Game"} (Disc N)</span>
          {after}
        </span>
      </label>
      {reason ? (
        <Notice level="warn">
          {localizer.message(reasonFromRename ? "ui.playlist.cannotRename" : "ui.playlist.cannotZip", { reason })}
        </Notice>
      ) : null}
    </>
  );
};

type LayoutChoiceProps = { layout: PlaylistLayout; locked: boolean; onChange: (layout: PlaylistLayout) => void };

/** Choose where a ZIP puts the playlist and discs for the frontend. */
const LayoutChoice = ({ layout, locked, onChange }: LayoutChoiceProps) => {
  const localizer = useUiLocalizer();
  return (
    <label className="checkrow">
      <span>{localizer.message("ui.playlist.layout")}</span>
      <select
        className="select"
        disabled={locked}
        id="playlist-layout"
        onChange={(event) => onChange(event.currentTarget.value as PlaylistLayout)}
        value={layout}
      >
        {PLAYLIST_LAYOUTS.map((option) => (
          <option key={option.layout} value={option.layout}>
            {localizer.message(option.label)}
          </option>
        ))}
      </select>
    </label>
  );
};

type ChdChoiceProps = { chd: boolean; locked: boolean; onChange: (chd: boolean) => void };

/** The checkbox to compress the discs in the ZIP to CHD. */
const ChdChoice = ({ chd, locked, onChange }: ChdChoiceProps) => {
  const localizer = useUiLocalizer();
  return (
    <label className="checkrow">
      <input
        checked={chd}
        disabled={locked}
        id="playlist-chd"
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <Disc aria-hidden="true" />
      <span>{localizer.message("ui.playlist.compressChd")}</span>
    </label>
  );
};

/** An error from the form, which the user can dismiss. */
const ErrorNotice = ({ error, onDismiss }: { error: string; onDismiss: () => void }) =>
  error ? (
    <Notice level="error" onDismiss={onDismiss}>
      {error}
    </Notice>
  ) : null;

type OpenFolderButtonProps = { opening: boolean; locked: boolean; onClick: () => void };

/** Opens the game's folder, which lets the page save the playlist into it and rename its discs. */
const OpenFolderButton = ({ opening, locked, onClick }: OpenFolderButtonProps) => {
  const localizer = useUiLocalizer();
  return (
    <button className="btn slim ghost" disabled={locked} onClick={onClick} type="button">
      <FolderOpen aria-hidden="true" />
      {localizer.message(opening ? "ui.playlist.openingFolder" : "ui.playlist.openFolder")}
    </button>
  );
};

type PlaylistEntriesProps = {
  plan: BrowserPlaylistPlan | null;
  planning: boolean;
  /** The plan with the rename and layout applied; null when the playlist is saved as it is. */
  outputPlan: BrowserPlaylistPlan | null;
};

/** The playlist's lines, one card per disc, or a status while the first plan is read. */
const PlaylistEntries = ({ plan, planning, outputPlan }: PlaylistEntriesProps) => {
  const localizer = useUiLocalizer();
  if (!plan) return planning ? <p role="status">{localizer.message("ui.playlist.readingSheets")}</p> : null;
  const lines = (outputPlan ?? plan).entries;
  return (
    <div className="cards" id="playlist-entries">
      {lines.map((line, index) => (
        <FileCard
          key={line}
          meta={<span className="meta-fmt mono">{localizer.message("ui.playlist.discNumber", { n: index + 1 })}</span>}
          name={<span className="nm mono">{line}</span>}
        />
      ))}
    </div>
  );
};

/** The files the rename-in-place plan renames, one card per file; nothing without that plan. */
const RenameCards = ({ renamePlan }: { renamePlan: BrowserPlaylistPlan | null }) => {
  if (!renamePlan) return null;
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

/** The files a ZIP plan holds, one card per file; nothing without that plan. */
const BundleCards = ({ zipPlan }: { zipPlan: BrowserPlaylistPlan | null }) => {
  if (!zipPlan) return null;
  return (
    <div className="cards" id="playlist-bundle">
      {zipPlan.bundle.map((file) => (
        <FileCard
          key={file.path}
          meta={file.source ? <span className="meta-fmt mono">← {getBaseName(file.source)}</span> : undefined}
          name={<span className="nm mono">{file.path}</span>}
        />
      ))}
    </div>
  );
};

/** The hint under the save options, or the notice that this browser cannot write folders. */
const FolderSupportNote = ({ canWriteFolders, folderHint }: { canWriteFolders: boolean; folderHint: string }) => {
  const localizer = useUiLocalizer();
  if (!canWriteFolders) return <Notice level="info">{localizer.message("ui.playlist.supportNote")}</Notice>;
  return folderHint ? <p className="hint">{folderHint}</p> : null;
};

type Busy = "open" | "save" | "rename" | "zip" | null;

type SaveActionsProps = {
  busy: Busy;
  mode: OutputMode;
  plan: BrowserPlaylistPlan | null;
  /** How far the ZIP is written, or null when unknown. */
  zipPercent: number | null;
  actionsReady: boolean;
  outputReady: boolean;
  canSaveToFolder: boolean;
  onCancel: () => void;
  onDownloadZip: () => void;
  onRename: () => void;
  onSaveToFolder: () => void;
};

const getZipLabel = (localizer: Localizer, busy: Busy, plan: BrowserPlaylistPlan | null, zipPercent: number | null) => {
  const fileName = plan ? `${getGameName(plan)}.zip` : "ZIP";
  if (busy !== "zip") return localizer.message("ui.playlist.zipDownload", { fileName });
  if (typeof zipPercent !== "number") return localizer.message("ui.playlist.zipCreating", { fileName });
  return localizer.message("ui.playlist.zipCreatingPercent", { fileName, percent: Math.round(zipPercent) });
};

/** The buttons that finish the playlist. They rename in place, download the ZIP, or save into the folder. */
const SaveActions = ({
  busy,
  mode,
  plan,
  zipPercent,
  actionsReady,
  outputReady,
  canSaveToFolder,
  onCancel,
  onDownloadZip,
  onRename,
  onSaveToFolder,
}: SaveActionsProps) => {
  const localizer = useUiLocalizer();
  const zipLabel = getZipLabel(localizer, busy, plan, zipPercent);
  // Renaming in place is the main action there; the ZIP is the main action everywhere else.
  const zipButton =
    mode === "in-place" ? (
      <button
        className="btn ghost"
        disabled={!actionsReady}
        id="playlist-download-zip"
        onClick={onDownloadZip}
        type="button"
      >
        <Archive aria-hidden="true" />
        {zipLabel}
      </button>
    ) : (
      <RunButton
        disabled={!(actionsReady && outputReady)}
        icon={<Archive aria-hidden="true" />}
        id="playlist-download-zip"
        onClick={onDownloadZip}
      >
        {zipLabel}
      </RunButton>
    );
  return (
    <>
      {mode === "in-place" ? (
        <RunButton
          disabled={!(actionsReady && outputReady)}
          icon={<FolderPen aria-hidden="true" />}
          id="playlist-rename"
          onClick={onRename}
        >
          {localizer.message(busy === "rename" ? "ui.playlist.renamingDiscs" : "ui.playlist.renameAndSave")}
        </RunButton>
      ) : null}
      {zipButton}
      {mode === "m3u" ? (
        <button
          className="btn ghost"
          disabled={!(canSaveToFolder && actionsReady)}
          id="playlist-save-folder"
          onClick={onSaveToFolder}
          type="button"
        >
          <Save aria-hidden="true" />
          {localizer.message(busy === "save" ? "ui.playlist.saving" : "ui.playlist.saveToFolder")}
        </button>
      ) : null}
      {busy === "zip" ? (
        <button className="btn ghost" id="playlist-cancel" onClick={onCancel} type="button">
          {localizer.message("ui.common.cancel")}
        </button>
      ) : null}
    </>
  );
};

const PlaylistForm = ({ onSessionChange, pageDrop }: PlaylistFormProps) => {
  const localizer = useUiLocalizer();
  const [canWriteFolders, setCanWriteFolders] = useState(false);
  const [source, setSource] = useState<PlaylistSource | null>(null);
  const [survey, setSurvey] = useState<BrowserPlaylistPlan | null>(null);
  const [game, setGame] = useState("");
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<BrowserPlaylistPlan | null>(null);
  const [rename, setRename] = useState(false);
  const [layout, setLayout] = useState<PlaylistLayout>("flat");
  const [chd, setChd] = useState(false);
  const [outputPlan, setOutputPlan] = useState<BrowserPlaylistPlan | null>(null);
  const [outputReason, setOutputReason] = useState("");
  // Whether the plan behind `outputReason` renamed the discs without compressing them.
  // The checkboxes may have changed since.
  const [reasonFromRename, setReasonFromRename] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [zipPercent, setZipPercent] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const handledDropRef = useRef(0);
  const planRunRef = useRef(0);
  const surveyRef = useRef<BrowserPlaylistPlan | null>(null);
  const plannedSourceRef = useRef<PlaylistSource | null>(null);
  const busyRef = useRef(false);
  const { disposeZip, keepZip, zipAbortRef } = useKeptZip();
  const nameProblem = checkGameName(name);

  useEffect(() => {
    // Read after hydration: the prerendered page cannot know the browser.
    setCanWriteFolders(canWritePlaylistFolders());
  }, []);
  useEffect(() => {
    onSessionChange(busy === "rename" || busy === "zip");
  }, [busy, onSessionChange]);
  useEffect(() => {
    setWorkbenchActivity(
      PLAYLIST_ACTIVITY_KEY,
      getPlaylistActivity({ busy: !!busy, done, error, hasSource: !!source, localizer, planning }),
    );
  }, [busy, done, error, localizer, planning, source]);
  useEffect(() => () => setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "idle" }), []);

  const games = useMemo(() => [...new Set((survey?.discs ?? []).map((disc) => disc.game))], [survey]);
  const allAtTop = !!plan && isAllAtTop(plan);
  const canRename = canWriteFolders && !!source?.directory;
  // A click must ask for folder access while it still counts as a user action, so the writer loads before the click.
  useEffect(() => {
    if (canRename) void import("../../storage/browser/playlist-folder-write.ts");
  }, [canRename]);
  const mode = getOutputMode({ canRename, chd, layout, plan, rename });

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
          await planPlaylistSource(
            {
              cachedSurvey: surveyRef.current,
              choices: { canRename, chd, layout, rename },
              isCurrent: () => planRunRef.current === run,
              request,
            },
            {
              onOutput: ({ outputPlan: planned, reason }) => {
                setOutputPlan(planned);
                setOutputReason(reason);
                // With CHD on, the failure may come from compressing, not from renaming.
                setReasonFromRename(rename && !chd);
              },
              onPlan: (next) => {
                setPlan(next);
                setError("");
              },
              onSurvey: (all) => {
                if (!request.typedName) surveyRef.current = all;
                setSurvey(all);
              },
            },
          );
        } catch (cause) {
          if (planRunRef.current !== run || isAbort(cause)) return;
          setPlan(null);
          setOutputPlan(null);
          setOutputReason("");
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
  }, [canRename, chd, game, layout, name, nameProblem, rename, source]);

  const replaceSource = useCallback(
    (next: PlaylistSource | null) => {
      planRunRef.current += 1;
      surveyRef.current = null;
      disposeZip();
      setSource(next);
      setSurvey(null);
      setPlan(null);
      setOutputPlan(null);
      setOutputReason("");
      // Renaming moves files, so a new folder starts without the last folder's choice.
      setRename(false);
      setGame("");
      setError("");
      setDone("");
      setPlanning(false);
    },
    [disposeZip],
  );

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
      const directory = await trackFilePicker(() => picker.call(window, { id: "rom-weaver-playlist", mode: "read" }));
      replaceSource({ directory, files: await readFolder(directory, localizer), folderName: directory.name });
    });
  };

  const reloadFolder = async (directory: FileSystemDirectoryHandle) => {
    replaceSource({ directory, files: await readFolder(directory, localizer), folderName: directory.name });
  };

  const saveToFolder = () => {
    const directory = source?.directory;
    if (!(directory && plan)) return;
    void runAction("save", async () => {
      const folder = await import("../../storage/browser/playlist-folder-write.ts");
      await folder.requestPlaylistFolderAccess(directory);
      await folder.savePlaylistToFolder(directory, plan.file_name, plan.text);
      setDone(localizer.message("ui.playlist.doneSaved", { fileName: plan.file_name, folder: directory.name }));
    });
  };

  const renameDiscs = () => {
    const directory = source?.directory;
    if (!(directory && outputPlan && source)) return;
    const planned = new Map(
      source.files.map((entry) => [entry.path, { lastModified: entry.file.lastModified, size: entry.file.size }]),
    );
    void runAction("rename", async () => {
      const folder = await import("../../storage/browser/playlist-folder-write.ts");
      await folder.requestPlaylistFolderAccess(directory);
      await folder.renamePlaylistFolder({
        directory,
        planned,
        playlist: { fileName: outputPlan.file_name, text: outputPlan.text },
        renames: outputPlan.renames,
      });
      setRename(false);
      await reloadFolder(directory);
      setDone(
        localizer.messageCount("ui.playlist.doneRenamed", outputPlan.renames.length, {
          fileName: outputPlan.file_name,
          folder: directory.name,
        }),
      );
    });
  };

  const downloadZip = () => {
    if (!(plan && source)) return;
    const { discs } = plan;
    const name = getGameName(plan);
    void runAction("zip", async () => {
      const abort = new AbortController();
      zipAbortRef.current = abort;
      setZipPercent(null);
      // Free the last ZIP first. A second one then needs no more free space than the first.
      disposeZip();
      try {
        const { writeBrowserPlaylistZip } = await import("../../platform/browser/browser-playlist-api.ts");
        const output = await writeBrowserPlaylistZip({
          discs: discs.map((disc) => disc.path),
          files: source.files,
          name,
          onEvent: (event) => {
            if (!abort.signal.aborted && typeof event.percent === "number") setZipPercent(event.percent);
          },
          signal: abort.signal,
          zip: { chd, layout, rename },
        });
        if (!keepZip(output, abort.signal)) return;
        await output.saveAs({ fileName: `${name}.zip`, interactive: true });
        setDone(localizer.message("ui.playlist.doneZip", { fileName: `${name}.zip` }));
      } catch (cause) {
        if (!abort.signal.aborted) throw cause;
      } finally {
        zipAbortRef.current = null;
        setZipPercent(null);
      }
    });
  };

  // Save into folder writes the playlist alone. The ZIP's playlist lists bare file names, so the list follows the action that runs.
  const savesPlaylistAlone = mode === "m3u" && canRename;
  const locked = !!busy;
  const actionsReady = !!plan && !planning && !locked && !nameProblem;
  // The ZIP is planned in every mode but a rename in place. A clash that stops it holds the download.
  const zipReady = actionsReady && (mode === "in-place" || !!outputPlan);

  useAgentWorkflow(PLAYLIST_ACTIVITY_KEY, {
    actions: {
      downloadZip: {
        description:
          "Download a ZIP of the playlist and the discs, renamed, arranged, and compressed as the page's Rename, Layout, and CHD choices say.",
        enabled: zipReady,
        execute: () => downloadZip(),
      },
    },
    getState: () => ({
      busy,
      chd,
      entries: (savesPlaylistAlone ? plan : outputPlan)?.entries ?? plan?.entries ?? [],
      error: error || null,
      fileName: plan?.file_name ?? null,
      files: source?.files.length ?? 0,
      layout,
      planning,
      rename,
    }),
  });

  const folderHint = getFolderHint(localizer, { allAtTop, hasFolder: !!source?.directory, plan });

  return (
    <section className="panel" id="playlist-container">
      {/* Without a source the steps below are hidden, so a failed folder pick reports here. */}
      {source ? null : <ErrorNotice error={error} onDismiss={() => setError("")} />}
      <UnifiedDropZone
        addLabel={localizer.message("ui.playlist.addDiscs")}
        // Below the drop target, not in the header: on phones the whole header is the add-files button.
        afterDropZone={<OpenFolderButton locked={locked} onClick={openFolder} opening={busy === "open"} />}
        big={!source}
        disabled={locked}
        guide={WORKFLOW_GUIDES.playlist}
        heroLabel={localizer.message("ui.playlist.dropDiscs")}
        heroLabelCoarse={localizer.message("ui.playlist.tapDiscs")}
        info={<p>{localizer.message("ui.playlist.dropInfo")}</p>}
        inputId="playlist-input-picker"
        lead={{ description: "ui.hero.playlistDescription", line1: "ui.hero.playlistThesis" }}
        onFiles={addFiles}
        supported={[
          {
            extensions: ["cue", "gdi", "ccd", "mds", "chd", "iso", "cso", "pbp", "rvz"],
            label: localizer.message("ui.playlist.discFiles"),
          },
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
            { num: "0x02", title: localizer.message("ui.playlist.stepPlaylist") },
            { num: "0x03", title: localizer.message("ui.playlist.stepSave") },
          ]}
        />
      )}
      {source ? (
        <>
          <StepSection
            fault={!!error}
            meta={source.folderName ? <span className="mono">{source.folderName}</span> : undefined}
            num="0x02"
            title={localizer.message("ui.playlist.stepPlaylist")}
          >
            <GameSelect games={games} game={game} locked={locked} onChange={setGame} />
            <GameNameField locked={locked} name={name} onChange={setName} plan={plan} problem={nameProblem} />
            <PlaylistEntries outputPlan={savesPlaylistAlone ? null : outputPlan} plan={plan} planning={planning} />
            <ErrorNotice error={error} onDismiss={() => setError("")} />
          </StepSection>
          <StepSection num="0x03" title={localizer.message("ui.playlist.stepSave")} woven={!!done}>
            <RenameChoice
              disabled={locked}
              name={name}
              onChange={setRename}
              reason={outputReason}
              reasonFromRename={reasonFromRename}
              renaming={rename}
            />
            <LayoutChoice layout={layout} locked={locked} onChange={setLayout} />
            <ChdChoice chd={chd} locked={locked} onChange={setChd} />
            <RenameCards renamePlan={mode === "in-place" ? outputPlan : null} />
            <BundleCards zipPlan={mode === "zip" ? outputPlan : null} />
            <FolderSupportNote canWriteFolders={canWriteFolders} folderHint={folderHint} />
            <div className="outbar">
              <SaveActions
                actionsReady={actionsReady}
                busy={busy}
                canSaveToFolder={canWriteFolders && !!source.directory}
                mode={mode}
                onCancel={() => zipAbortRef.current?.abort()}
                onDownloadZip={downloadZip}
                onRename={renameDiscs}
                onSaveToFolder={saveToFolder}
                outputReady={!!outputPlan}
                plan={plan}
                zipPercent={zipPercent}
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
