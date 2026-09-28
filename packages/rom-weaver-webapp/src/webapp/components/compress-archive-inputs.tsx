import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { getErrorCode } from "../../presentation/errors.ts";
import { useCandidateSelection } from "../../public/react/candidate-selection.tsx";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import {
  disposeOpenedOutputs,
  extractCompressEntries,
  type ListedCompressEntry,
  listCompressInput,
  type OpenedCompressEntry,
} from "../compress-service.ts";

type PendingArchive = {
  id: number;
  name: string;
  percent: number | null;
  phase: "extracting" | "reading";
  size: number;
};
type StagedArchiveEntry = { file: File; id: number; sourceName: string };
type CompressArchiveInputsOptions = {
  nextId: () => number;
  onAdd: (entries: StagedArchiveEntry[]) => void;
  onError: (message: string) => void;
};

const logger = createLogger("compress-archive-inputs");

/**
 * Opens dropped archives and compressed disc images for Compress, the way Apply opens its inputs:
 * list the entries, ask which ones to add, then extract only those. Nothing is extracted before the
 * answer, so Keep packed and unpicked entries cost no storage. The picker always opens, even for one
 * entry, because its Keep packed switch adds the archive unchanged. An archive that cannot be listed
 * or extracted is added unchanged with an error.
 * The hook owns each staged entry's stored copy until `release` or unmount disposes it.
 */
const useCompressArchiveInputs = ({ nextId, onAdd, onError }: CompressArchiveInputsOptions) => {
  const localizer = useUiLocalizer();
  const { candidateSelectionDialog, selectFile } = useCandidateSelection();
  const [pending, setPending] = useState<PendingArchive[]>([]);
  const abortsRef = useRef(new Map<number, AbortController>());
  const ownedRef = useRef(new Map<number, PublicOutput>());
  // Fallback-extracted files waiting on a picker that may never answer if the form unmounts.
  const heldRef = useRef(new Map<number, PublicOutput[]>());
  const mountedRef = useRef(true);

  const chooseEntries = useCallback(
    async (sourceName: string, listed: ListedCompressEntry[]): Promise<string[] | "keep"> => {
      const choice = await selectFile({
        candidates: listed.map((entry, index) => ({
          defaultSelected: true,
          fileName: entry.path.split("/").filter(Boolean).join(" › "),
          id: String(index),
          kind: "rom",
          selectable: true,
          ...(typeof entry.size === "number" ? { size: entry.size } : {}),
          type: "file",
        })),
        keepSourceLabel: localizer.message("ui.compress.keepPacked"),
        multiSelect: true,
        role: "input",
        sourceName,
        warnings: [],
      });
      if (choice.keepSource) return "keep";
      const ids = new Set(choice.ids ?? [choice.id]);
      return listed.filter((_entry, index) => ids.has(String(index))).map((entry) => entry.path);
    },
    [localizer, selectFile],
  );

  const open = useCallback(
    async (file: File) => {
      const pendingId = nextId();
      const abort = new AbortController();
      abortsRef.current.set(pendingId, abort);
      const updatePending = (changes: Partial<PendingArchive>) =>
        setPending((previous) => previous.map((entry) => (entry.id === pendingId ? { ...entry, ...changes } : entry)));
      setPending((previous) => [
        ...previous,
        { id: pendingId, name: file.name, percent: null, phase: "reading", size: file.size },
      ]);
      const progress = {
        onProgress: (event: { percent?: number | null }) => {
          if (!abort.signal.aborted && typeof event.percent === "number") updatePending({ percent: event.percent });
        },
        signal: abort.signal,
      };
      let entries: OpenedCompressEntry[] = [];
      try {
        const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
        const listing = await listCompressInput(file, browserRuntime, progress);
        // A listing that fell back to full extraction already holds its files; `finally` disposes
        // whatever is not staged.
        entries = listing.extracted ?? [];
        if (entries.length)
          heldRef.current.set(
            pendingId,
            entries.map((entry) => entry.output),
          );
        if (abort.signal.aborted || !mountedRef.current) return;
        if (!listing.entries.length) throw new Error(`No files were found in ${file.name}`);
        const chosen = await chooseEntries(file.name, listing.entries);
        if (abort.signal.aborted || !mountedRef.current) return;
        if (chosen === "keep") {
          logger.trace("open.kept", { fileName: file.name });
          onAdd([{ file, id: nextId(), sourceName: file.name }]);
          return;
        }
        let picked: OpenedCompressEntry[];
        if (listing.extracted) {
          const chosenPaths = new Set(chosen);
          picked = entries.filter((entry) => chosenPaths.has(entry.path));
          entries = entries.filter((entry) => !chosenPaths.has(entry.path));
        } else {
          updatePending({ percent: null, phase: "extracting" });
          entries = await extractCompressEntries(file, chosen, browserRuntime, progress);
          if (abort.signal.aborted || !mountedRef.current) return;
          picked = entries;
          entries = [];
        }
        const staged = picked.map((entry) => {
          const id = nextId();
          ownedRef.current.set(id, entry.output);
          return { file: entry.file, id, sourceName: file.name };
        });
        logger.trace("open.staged", { chosen: staged.length, fileName: file.name, listed: listing.entries.length });
        onAdd(staged);
      } catch (cause) {
        if (abort.signal.aborted || !mountedRef.current) return;
        if (getErrorCode(cause) === "WORKFLOW_SELECTION_SKIPPED") return;
        // A file that cannot be opened still packs as-is, so it is added unchanged rather than dropped.
        const reason = cause instanceof Error ? cause.message : String(cause);
        logger.debug("open.failed; adding unchanged", { fileName: file.name, reason });
        onAdd([{ file, id: nextId(), sourceName: file.name }]);
        onError(`${file.name} could not be opened, so it was added unchanged. ${reason}`);
      } finally {
        abortsRef.current.delete(pendingId);
        heldRef.current.delete(pendingId);
        void disposeOpenedOutputs(entries.map((entry) => entry.output));
        if (mountedRef.current) setPending((previous) => previous.filter((entry) => entry.id !== pendingId));
      }
    },
    [chooseEntries, nextId, onAdd, onError],
  );

  const cancel = useCallback((pendingId: number) => abortsRef.current.get(pendingId)?.abort(), []);

  const release = useCallback((stagedId: number) => {
    const output = ownedRef.current.get(stagedId);
    if (!output) return;
    ownedRef.current.delete(stagedId);
    void disposeOpenedOutputs([output]);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const aborts = abortsRef.current;
    const held = heldRef.current;
    const owned = ownedRef.current;
    return () => {
      mountedRef.current = false;
      for (const abort of aborts.values()) abort.abort();
      void disposeOpenedOutputs([...[...held.values()].flat(), ...owned.values()]);
      held.clear();
      owned.clear();
    };
  }, []);

  return { cancel, dialog: candidateSelectionDialog, open, pending, release };
};

export { useCompressArchiveInputs };
