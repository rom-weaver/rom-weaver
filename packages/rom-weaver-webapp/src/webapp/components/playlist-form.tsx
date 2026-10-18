import { ArrowDown, ArrowUp, Download, ListMusic } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import { type PlaylistDisc, subscribePlaylistHandoff, takePlaylistHandoff } from "../../lib/playlist-handoff.ts";
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

const toDisc = (file: File): PlaylistDisc => ({ name: file.name, size: file.size, source: file });

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
  // The playlist lines in playlist order. The shared `playlist` command orders them from the file
  // names; the up/down buttons then edit this list.
  const [entries, setEntries] = useState<string[]>([]);
  const [format, setFormat] = useState("m3u");
  const [outputName, setOutputName] = useState("playlist");
  const [output, setOutput] = useState<PublicOutput | null>(null);
  const [error, setError] = useState("");
  const [ordering, setOrdering] = useState(false);
  const [busy, setBusy] = useState(false);
  const outputRef = useRef<PublicOutput | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const orderRunRef = useRef(0);
  const filesRef = useRef<PlaylistDisc[]>([]);
  const handledDropRef = useRef(0);
  const workflowEmpty = useFlatTransitionFlag(files.length === 0);

  useEffect(() => {
    outputRef.current = output;
  }, [output]);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      void outputRef.current?.dispose();
      setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "idle" });
    },
    [],
  );
  useEffect(() => {
    if (busy || ordering) setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { stage: "Build playlist", state: "running" });
    else if (error) setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "failed" });
    else if (output) setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { stage: "Playlist ready", state: "done" });
    else if (files.length) setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "ready" });
    else setWorkbenchActivity(PLAYLIST_ACTIVITY_KEY, { state: "idle" });
  }, [busy, error, files.length, ordering, output]);

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
      setEntries([]);
      setOrdering(false);
      return;
    }
    setOrdering(true);
    try {
      const { buildPlaylist } = await import("../../platform/browser/browser-api.ts");
      const ordered = await buildPlaylist({
        archive: false,
        files: next.map((disc) => disc.source),
        outputName: "order.m3u",
        sort: true,
      });
      void ordered.output.dispose();
      if (run === orderRunRef.current) setEntries(ordered.entries);
    } catch (cause) {
      if (run === orderRunRef.current) {
        setEntries([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (run === orderRunRef.current) setOrdering(false);
    }
  }, []);

  const updateFiles = useCallback(
    (next: PlaylistDisc[]) => {
      filesRef.current = next;
      setFiles(next);
      void orderFiles(next);
    },
    [orderFiles],
  );
  const addFiles = useCallback(
    (incoming: PlaylistDisc[]) => {
      clearOutput();
      const previous = filesRef.current;
      const known = new Set(previous.map((file) => file.name.toLowerCase()));
      const fresh = incoming.filter((file) => {
        const key = file.name.toLowerCase();
        if (known.has(key)) return false;
        known.add(key);
        return true;
      });
      if (fresh.length === 0) return;
      const next = [...previous, ...fresh];
      if (previous.length === 0 && next[0]) setOutputName(gameNameOf(next[0].name));
      updateFiles(next);
    },
    [clearOutput, updateFiles],
  );
  const removeEntry = (name: string) => {
    clearOutput();
    updateFiles(filesRef.current.filter((file) => file.name !== name));
  };
  const moveEntry = (index: number, delta: -1 | 1) => {
    clearOutput();
    setEntries((previous) => {
      const target = index + delta;
      if (target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      const moved = next[index];
      const swapped = next[target];
      if (moved === undefined || swapped === undefined) return previous;
      next[index] = swapped;
      next[target] = moved;
      return next;
    });
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
      if (handed.length) addFiles(handed);
    };
    take();
    return subscribePlaylistHandoff(take);
  }, [addFiles]);

  const byName = new Map(files.map((file) => [file.name, file]));
  const extras = files.filter((file) => !entries.includes(file.name));
  const canRun = files.length > 0 && entries.length > 0 && !!outputName.trim() && !busy && !ordering && !error;

  const run = async () => {
    if (!canRun) return;
    clearOutput();
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    try {
      const { buildPlaylist } = await import("../../platform/browser/browser-api.ts");
      const discs = entries.flatMap((name) => byName.get(name) ?? []);
      const archive = format === "zip";
      const built = await buildPlaylist({
        archive,
        files: [...discs, ...extras].map((disc) => disc.source),
        outputName: `${outputName.trim()}.${archive ? "zip" : "m3u"}`,
        signal: abort.signal,
        sort: false,
      });
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
      discs: entries,
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
        disabled={busy}
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
              {entries.map((name, index) => {
                const file = byName.get(name);
                return (
                  <li key={name}>
                    <FileCard
                      handle={
                        <span className="playlist-order-buttons">
                          <button
                            aria-label={`Move ${name} up`}
                            className="rm"
                            disabled={index === 0 || busy}
                            onClick={() => moveEntry(index, -1)}
                            type="button"
                          >
                            <ArrowUp aria-hidden="true" />
                          </button>
                          <button
                            aria-label={`Move ${name} down`}
                            className="rm"
                            disabled={index === entries.length - 1 || busy}
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
                          <span className="fsize mono">{file ? formatByteSize(file.size) : ""}</span>
                          <span className="meta-fmt mono">{`Disc ${index + 1}`}</span>
                        </>
                      }
                      name={<span className="nm mono">{name}</span>}
                      onRemove={busy ? undefined : () => removeEntry(name)}
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
