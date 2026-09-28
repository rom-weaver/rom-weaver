import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { getErrorCode } from "../../presentation/errors.ts";
import { useCandidateSelection } from "../../public/react/candidate-selection.tsx";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import { disposeOpenedOutputs, type OpenedCompressEntry, openCompressInput } from "../compress-service.ts";

type PendingArchive = { id: number; name: string; percent: number | null; size: number };
type StagedArchiveEntry = { file: File; id: number };
type CompressArchiveInputsOptions = {
  nextId: () => number;
  onAdd: (entries: StagedArchiveEntry[]) => void;
  onError: (message: string) => void;
};

const logger = createLogger("compress-archive-inputs");

/**
 * Opens dropped archives and compressed disc images for Compress, the way Apply opens its inputs:
 * extract every entry, ask which ones to add when there is more than one, then stage the chosen
 * files. The hook owns each staged entry's stored copy until `release` or unmount disposes it.
 */
const useCompressArchiveInputs = ({ nextId, onAdd, onError }: CompressArchiveInputsOptions) => {
  const { candidateSelectionDialog, selectFile } = useCandidateSelection();
  const [pending, setPending] = useState<PendingArchive[]>([]);
  const abortsRef = useRef(new Map<number, AbortController>());
  const openedRef = useRef(new Map<number, PublicOutput[]>());
  const ownedRef = useRef(new Map<number, PublicOutput>());
  const mountedRef = useRef(true);

  const chooseEntries = useCallback(
    async (sourceName: string, entries: OpenedCompressEntry[]): Promise<OpenedCompressEntry[]> => {
      if (entries.length < 2) return entries;
      const choice = await selectFile({
        candidates: entries.map((entry, index) => ({
          defaultSelected: true,
          fileName: entry.path.split("/").join(" › "),
          id: String(index),
          kind: "rom",
          selectable: true,
          size: entry.output.size,
          type: "file",
        })),
        multiSelect: true,
        role: "input",
        sourceName,
        warnings: [],
      });
      const ids = new Set(choice.ids ?? [choice.id]);
      return entries.filter((_entry, index) => ids.has(String(index)));
    },
    [selectFile],
  );

  const open = useCallback(
    async (file: File) => {
      const pendingId = nextId();
      const abort = new AbortController();
      abortsRef.current.set(pendingId, abort);
      setPending((previous) => [...previous, { id: pendingId, name: file.name, percent: null, size: file.size }]);
      let entries: OpenedCompressEntry[] = [];
      try {
        const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
        entries = await openCompressInput(file, browserRuntime, {
          onProgress: (event) => {
            if (abort.signal.aborted || typeof event.percent !== "number") return;
            const percent = event.percent;
            setPending((previous) => previous.map((entry) => (entry.id === pendingId ? { ...entry, percent } : entry)));
          },
          signal: abort.signal,
        });
        if (abort.signal.aborted || !mountedRef.current) return;
        openedRef.current.set(
          pendingId,
          entries.map((entry) => entry.output),
        );
        if (!entries.length) throw new Error(`No files were found in ${file.name}`);
        const chosen = await chooseEntries(file.name, entries);
        if (abort.signal.aborted || !mountedRef.current) return;
        const staged = chosen.map((entry) => {
          const id = nextId();
          ownedRef.current.set(id, entry.output);
          return { file: entry.file, id };
        });
        const stagedOutputs = new Set(chosen.map((entry) => entry.output));
        entries = entries.filter((entry) => !stagedOutputs.has(entry.output));
        logger.trace("open.staged", { chosen: staged.length, fileName: file.name, skipped: entries.length });
        onAdd(staged);
      } catch (cause) {
        if (abort.signal.aborted || !mountedRef.current) return;
        if (getErrorCode(cause) === "WORKFLOW_SELECTION_SKIPPED") return;
        onError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        abortsRef.current.delete(pendingId);
        openedRef.current.delete(pendingId);
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
    const opened = openedRef.current;
    const owned = ownedRef.current;
    return () => {
      mountedRef.current = false;
      for (const abort of aborts.values()) abort.abort();
      // A picker that never answers leaves its extracted files here, so unmount disposes them too.
      void disposeOpenedOutputs([...[...opened.values()].flat(), ...owned.values()]);
      opened.clear();
      owned.clear();
    };
  }, []);

  return { cancel, dialog: candidateSelectionDialog, open, pending, release };
};

export { useCompressArchiveInputs };
