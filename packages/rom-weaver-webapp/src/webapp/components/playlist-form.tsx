import { ArrowDown, ArrowUp, Download, ListMusic } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import {
  createPlaylistHandoffId,
  isSamePlaylistFile,
  type PlaylistDisc,
  releasePlaylistDisc,
  retainPlaylistDisc,
  subscribePlaylistHandoff,
  takePlaylistHandoff,
} from "../../lib/playlist-handoff.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { FileCard } from "../../public/react/components/ds/file-card.tsx";
import { useFlatTransitionFlag } from "../../public/react/components/ds/flat-transition.ts";
import { GhostSteps } from "../../public/react/components/ds/ghost-steps.tsx";
import { StepSection } from "../../public/react/components/ds/layout.tsx";
import { OutputCard } from "../../public/react/components/ds/output-card.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import { WORKFLOW_GUIDES } from "../../public/react/workflow-guides.ts";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import { useAgentWorkflow } from "../agent/workflow-registry.ts";

const PLAYLIST_ACTIVITY_KEY = "playlist";
const DISC_EXTENSIONS = ["cue", "gdi", "chd", "iso", "pbp", "ccd", "mds", "cso", "rvz", "wbfs", "gcz", "ciso", "bin"];
const FORMAT_OPTIONS = [
  { label: "M3U playlist", value: "m3u" },
  { label: "ZIP with discs", value: "zip" },
];

/** Where a disc sits in the staging folder: its path below the extraction root, else its name. */
const discKey = (disc: PlaylistDisc) => (disc.relativePath || disc.name).toLowerCase();
const toDisc = (file: File): PlaylistDisc => ({ name: file.name, size: file.size, source: file });

const folderOf = (disc: PlaylistDisc) => {
  const path = disc.relativePath || "";
  return path.slice(0, Math.max(0, path.lastIndexOf("/"))).toLowerCase();
};
const isWithinFolder = (folder: string, parent: string) =>
  parent === "" || folder === parent || folder.startsWith(`${parent}/`);

const stemOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/** `Game (Disc 1).cue` and `Game.disc01.cue` both name the game `Game`. */
const gameNameOf = (name: string) =>
  stemOf(name)
    .replace(/[\s._-]*[([]?\b(?:disc|disk|cd)[\s._-]*\d+(?:\s+of\s+\d+)?[)\]]?/i, "")
    .trim() || "playlist";

type PlaylistFormProps = {
  pageDrop?: PageFileDrop | null;
};

const PlaylistForm = ({ pageDrop }: PlaylistFormProps) => {
  const [files, setFiles] = useState<PlaylistDisc[]>([]);
  // The discs in playlist order. The shared `playlist` command orders them from the file names and
  // says which files are discs; the up/down buttons then edit this list.
  const [ordered, setOrdered] = useState<PlaylistDisc[]>([]);
  const [format, setFormat] = useState("m3u");
  const [outputName, setOutputName] = useState("playlist");
  const [output, setOutput] = useState<PublicOutput | null>(null);
  const [error, setError] = useState("");
  const [ordering, setOrdering] = useState(false);
  // Ordering failed, so nothing is ordered; every added file still lists, removable, until it succeeds.
  const [orderFailed, setOrderFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Copying handed-over discs, or removing one (it probes the remaining files first).
  const [adopting, setAdopting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const outputRef = useRef<PublicOutput | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const orderRunRef = useRef(0);
  const orderPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const orderedRef = useRef<PlaylistDisc[]>([]);
  const removingRef = useRef(false);
  // Set once the user moves a disc; from then on a changed file list keeps their order.
  const customOrderRef = useRef(false);
  // Bumped on every change to the file list, so a build that started before it is not offered.
  const listVersionRef = useRef(0);
  const filesRef = useRef<PlaylistDisc[]>([]);
  const handledDropRef = useRef(0);
  const mountedRef = useRef(true);
  const workflowEmpty = useFlatTransitionFlag(files.length === 0);

  useEffect(() => {
    outputRef.current = output;
  }, [output]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      for (const disc of filesRef.current) releasePlaylistDisc(disc);
      void outputRef.current?.dispose();
      setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "idle" });
    },
    [],
  );
  useEffect(() => {
    if (busy || ordering || adopting || removing)
      setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { stage: "Build playlist", state: "running" });
    else if (error) setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "failed" });
    else if (output) setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { stage: "Playlist ready", state: "done" });
    else if (files.length) setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "ready" });
    else setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "idle" });
  }, [adopting, busy, error, files.length, ordering, output, removing]);

  // When ordering fails nothing is ordered; every added file still shows, removable, so the user can fix it.
  const listed = ordered.length === 0 && orderFailed ? files : ordered;
  const extras = files.filter((file) => !listed.includes(file));
  const idle = !(busy || ordering || adopting || removing);
  const canRun = files.length > 0 && ordered.length > 0 && !!outputName.trim() && idle && !error;

  const clearOutput = useCallback(() => {
    const previous = outputRef.current;
    outputRef.current = null;
    setOutput(null);
    setError("");
    if (previous) void previous.dispose();
  }, []);

  /** Ask the shared command for the disc order of `next`; the output it writes is not kept. */
  const orderFiles = useCallback(async (next: PlaylistDisc[]) => {
    const run = ++orderRunRef.current;
    if (next.length === 0) {
      orderedRef.current = [];
      setOrdered([]);
      setOrdering(false);
      return;
    }
    setOrdering(true);
    setOrderFailed(false);
    try {
      const { buildPlaylist } = await import("../../platform/browser/browser-api.ts");
      const result = await buildPlaylist({
        archive: false,
        files: next.map((disc) => disc.source),
        outputName: "order.m3u",
        sort: true,
      });
      void result.output.dispose();
      if (run === orderRunRef.current) {
        const sorted = result.discIndexes.flatMap((index) => next[index] ?? []);
        // Keep the user's order for the discs still listed; discs they have not placed yet follow.
        orderedRef.current = customOrderRef.current
          ? [
              ...orderedRef.current.filter((disc) => sorted.includes(disc)),
              ...sorted.filter((disc) => !orderedRef.current.includes(disc)),
            ]
          : sorted;
        setOrdered(orderedRef.current);
      }
    } catch (cause) {
      if (run === orderRunRef.current) {
        orderedRef.current = [];
        setOrdered([]);
        setOrderFailed(true);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (run === orderRunRef.current) setOrdering(false);
    }
  }, []);

  const updateFiles = useCallback(
    (next: PlaylistDisc[]) => {
      filesRef.current = next;
      listVersionRef.current += 1;
      if (next.length === 0) customOrderRef.current = false;
      setFiles(next);
      orderPromiseRef.current = orderFiles(next);
    },
    [orderFiles],
  );
  const addFiles = useCallback(
    (incoming: PlaylistDisc[]) => {
      clearOutput();
      const previous = filesRef.current;
      const fresh: PlaylistDisc[] = [];
      let clash: PlaylistDisc | undefined;
      for (const file of incoming) {
        const held = [...previous, ...fresh];
        if (held.some((other) => isSamePlaylistFile(other, file))) continue;
        // Files are staged into one folder unless a copy keeps its folder, so two different files
        // cannot share a path: a sheet would silently read the other disc's track.
        clash ??= held.some((other) => discKey(other) === discKey(file)) ? file : undefined;
        fresh.push(file);
      }
      const discard = () => {
        for (const file of incoming) if (!previous.includes(file)) releasePlaylistDisc(file);
      };
      if (clash) {
        discard();
        setError(`A different file named ${clash.name} is already in the list. Remove it or rename one of them first.`);
        return;
      }
      for (const file of incoming) if (!(fresh.includes(file) || previous.includes(file))) releasePlaylistDisc(file);
      if (fresh.length === 0) return;
      const next = [...previous, ...fresh];
      if (previous.length === 0 && next[0]) setOutputName(gameNameOf(next[0].name));
      updateFiles(next);
    },
    [clearOutput, updateFiles],
  );
  // Copy outputs another tool keeps alive, then add them; the copies are the playlist's to delete.
  const adoptFiles = useCallback(
    async (handed: PlaylistDisc[]) => {
      const retained: PlaylistDisc[] = [];
      const handoffId = createPlaylistHandoffId();
      setAdopting(true);
      try {
        for (const disc of handed) {
          if (filesRef.current.some((held) => isSamePlaylistFile(held, disc))) continue;
          retained.push(await retainPlaylistDisc(disc, handoffId));
        }
      } catch (cause) {
        for (const disc of retained) releasePlaylistDisc(disc);
        if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
        return;
      } finally {
        if (mountedRef.current) setAdopting(false);
      }
      if (!mountedRef.current) {
        for (const disc of retained) releasePlaylistDisc(disc);
        return;
      }
      addFiles(retained);
    },
    [addFiles],
  );
  /** Remove a disc and, if it is a sheet, the track files only it names. */
  const removeDisc = async (disc: PlaylistDisc) => {
    if (removingRef.current) return;
    removingRef.current = true;
    setRemoving(true);
    try {
      clearOutput();
      // Let an ordering pass in flight finish, so the extras below are the ones the list really has.
      await orderPromiseRef.current;
      const candidates = filesRef.current.filter((file) => file !== disc && !orderedRef.current.includes(file));
      let gone = [disc];
      if (candidates.length) {
        try {
          const { buildPlaylist } = await import("../../platform/browser/browser-api.ts");
          const probe = await buildPlaylist({
            archive: false,
            files: [disc.source, ...candidates.map((file) => file.source)],
            outputName: "order.m3u",
            sort: false,
          });
          void probe.output.dispose();
          // The command lists a track file as a disc only when no sheet in the input names it.
          // Only the sheet's own folder can hold its tracks: a same-named track of another
          // disc's folder (Disc 2/Track 01.bin) is that disc's.
          const listed = new Set(probe.discIndexes);
          const folder = folderOf(disc);
          gone = [
            disc,
            ...candidates.filter((file, index) => !listed.has(index + 1) && isWithinFolder(folderOf(file), folder)),
          ];
        } catch {
          // Fall back to removing just the chosen disc.
        }
      }
      for (const file of gone) releasePlaylistDisc(file);
      updateFiles(filesRef.current.filter((file) => !gone.includes(file)));
    } finally {
      removingRef.current = false;
      if (mountedRef.current) setRemoving(false);
    }
  };
  const moveEntry = (index: number, delta: -1 | 1) => {
    clearOutput();
    customOrderRef.current = true;
    const previous = orderedRef.current;
    const target = index + delta;
    const moved = previous[index];
    const swapped = previous[target];
    if (moved === undefined || swapped === undefined) return;
    const next = [...previous];
    next[index] = swapped;
    next[target] = moved;
    orderedRef.current = next;
    setOrdered(next);
  };

  useEffect(() => {
    if (!(pageDrop && pageDrop.id !== handledDropRef.current)) return;
    handledDropRef.current = pageDrop.id;
    addFiles(pageDrop.files.map(toDisc));
    pageDrop.onConsumed?.();
  }, [addFiles, pageDrop]);
  // Discs handed over by Extract or Compress.
  useEffect(() => {
    const take = () => {
      const handed = takePlaylistHandoff();
      if (handed.length) void adoptFiles(handed);
    };
    take();
    return subscribePlaylistHandoff(take);
  }, [adoptFiles]);

  const run = async () => {
    if (!canRun) return;
    clearOutput();
    const version = listVersionRef.current;
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    try {
      const { buildPlaylist } = await import("../../platform/browser/browser-api.ts");
      const archive = format === "zip";
      const built = await buildPlaylist({
        archive,
        files: [...ordered, ...extras].map((disc) => disc.source),
        outputName: `${outputName.trim()}.${archive ? "zip" : "m3u"}`,
        signal: abort.signal,
        sort: false,
      });
      // A file added while this ran makes the build stale: drop it rather than offer it.
      if (version !== listVersionRef.current || !mountedRef.current) {
        void built.output.dispose();
        return;
      }
      outputRef.current = built.output;
      setOutput(built.output);
      await built.output.saveAs();
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };
  const download = async () => {
    if (!output) return;
    try {
      await output.saveAs({ fileName: output.fileName, interactive: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useAgentWorkflow("playlist", {
    getState: () => ({
      busy,
      discs: ordered.map((disc) => disc.name),
      error: error || null,
      files: files.map((disc) => ({ name: disc.name, size: disc.size })),
      options: { format, outputName },
      output: output ? { fileName: output.fileName, size: output.size } : null,
    }),
    actions: {
      run: {
        description: "Build the playlist from the listed discs.",
        enabled: canRun,
        execute: () => void run(),
      },
      download: {
        description: "Download the playlist again.",
        enabled: !!output && !busy,
        execute: () => void download(),
      },
      cancel: {
        description: "Cancel the active playlist build.",
        enabled: busy,
        execute: () => abortRef.current?.abort(),
      },
    },
  });

  const ActionIcon = output ? Download : ListMusic;
  return (
    <section className="panel" id="playlist-container">
      <UnifiedDropZone
        addLabel="Add more discs"
        big={workflowEmpty}
        disabled={busy || adopting || removing}
        guide={WORKFLOW_GUIDES.playlist}
        heroLabel="Drop the discs of a multi-disc game"
        heroLabelCoarse="Tap to add the discs of a multi-disc game"
        info={
          <p>Add every disc, plus the track files their cue sheets name. Discs are ordered by names like Disc 1.</p>
        }
        inputId="playlist-input-picker"
        lead={{ line1: "ui.hero.toolsThesis", description: "ui.hero.toolsDescription" }}
        onFiles={(dropped) => addFiles(dropped.map(toDisc))}
        supported={[{ extensions: DISC_EXTENSIONS, label: "Disc files" }]}
      />
      {adopting ? <p role="status">Copying discs…</p> : null}
      {workflowEmpty && error ? (
        <Notice level="error" onDismiss={() => setError("")}>
          {error}
        </Notice>
      ) : null}
      {workflowEmpty ? (
        <GhostSteps
          steps={[
            { num: "0x02", title: "Disc order" },
            { num: "0x03", title: "Playlist" },
          ]}
        />
      ) : (
        <>
          <StepSection num="0x02" title="Disc order">
            {ordering ? <p role="status">Ordering discs…</p> : null}
            <ol aria-label="Discs in playlist order" className="cards">
              {listed.map((file, index) => {
                const name = file.name;
                return (
                  <li key={discKey(file)}>
                    <FileCard
                      handle={
                        <span className="playlist-order-buttons">
                          <button
                            aria-label={`Move ${name} up`}
                            className="rm"
                            disabled={index === 0 || !idle || ordered.length === 0}
                            onClick={() => moveEntry(index, -1)}
                            type="button"
                          >
                            <ArrowUp aria-hidden="true" />
                          </button>
                          <button
                            aria-label={`Move ${name} down`}
                            className="rm"
                            disabled={index === listed.length - 1 || !idle || ordered.length === 0}
                            onClick={() => moveEntry(index, 1)}
                            type="button"
                          >
                            <ArrowDown aria-hidden="true" />
                          </button>
                        </span>
                      }
                      index={index + 1}
                      meta={
                        <>
                          <span className="fsize mono">{formatByteSize(file.size)}</span>
                          <span className="meta-fmt mono">{`Disc ${index + 1}`}</span>
                        </>
                      }
                      name={<span className="nm mono">{name}</span>}
                      onRemove={busy || adopting || removing ? undefined : () => void removeDisc(file)}
                      removeLabel={`Remove ${name}`}
                    />
                  </li>
                );
              })}
            </ol>
            {extras.length ? (
              <p className="playlist-extras">
                Also included with the discs: <span className="mono">{extras.map((file) => file.name).join(", ")}</span>
              </p>
            ) : null}
          </StepSection>
          <StepSection fault={!!error} num="0x03" title="Playlist" woven={!!output}>
            <OutputCard
              action={
                <RunButton
                  ariaLabel={output ? `Download ${output.fileName}` : undefined}
                  disabled={busy || !(output || canRun)}
                  download={
                    output
                      ? {
                          format: format === "zip" ? "ZIP" : "M3U",
                          name: output.fileName,
                          size: formatByteSize(output.size),
                        }
                      : undefined
                  }
                  icon={<ActionIcon aria-hidden="true" />}
                  onClick={() => void (output ? download() : run())}
                >
                  {busy ? "Building playlist…" : "Build playlist"}
                </RunButton>
              }
              disabled={busy}
              fileName={outputName}
              format={format}
              formatId="playlist-output-format"
              formatOptions={FORMAT_OPTIONS}
              onFileNameChange={(value) => {
                clearOutput();
                setOutputName(value);
              }}
              onFormatChange={(value) => {
                clearOutput();
                setFormat(value);
              }}
            />
            {error ? (
              <Notice level="error" onDismiss={() => setError("")}>
                {error}
              </Notice>
            ) : null}
          </StepSection>
        </>
      )}
    </section>
  );
};

export { PlaylistForm };
export type { PlaylistFormProps };
