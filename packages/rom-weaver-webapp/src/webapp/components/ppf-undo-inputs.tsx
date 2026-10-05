import { useCallback, useEffect, useRef, useState } from "react";
import { createArchiveOutput } from "../../lib/output/archive-output-service.ts";
import { isCueEntryFileName, isGdiEntryFileName } from "../../lib/input/archive.ts";
import { useCandidateSelection } from "../../public/react/candidate-selection.tsx";
import type { SourceMetadata } from "../../types/workflow-source.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";

type PreparedUndoInput = {
  file: File;
  kind: "patch" | "rom";
  output?: PublicOutput;
  companions?: PublicOutput[];
  target?: string;
  metadata?: SourceMetadata;
};

const usePpfUndoInputs = (
  onInputs: (rom?: File | null, patch?: File | null) => void,
  onError: (message: string) => void,
) => {
  const { candidateSelectionDialog, selectFile } = useCandidateSelection();
  const [opening, setOpening] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const owned = useRef(new Map<File, PreparedUndoInput>());
  const abortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      const entries = [...owned.current.values()];
      owned.current.clear();
      for (const entry of entries) {
        for (const output of [entry.output, ...(entry.companions || [])]) void output?.dispose();
      }
    },
    [],
  );

  const stage = useCallback(
    async (files: File[]) => {
      if (!files.length || abortRef.current) return;
      const abort = new AbortController();
      abortRef.current = abort;
      setOpening(true);
      setWarnings([]);
      const outputs: PublicOutput[] = [];
      try {
        const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
        if (!browserRuntime.ingest?.run) throw new Error("Input ingestion is unavailable");
        const candidates: PreparedUndoInput[] = [];
        const notices: string[] = [];
        let invalidPatch = false;
        let sources: Array<{ source: File | PublicOutput; name: string }> = files.map((file) => ({
          source: file,
          name: file.name,
        }));
        if (files.some((file) => isCueEntryFileName(file.name) || isGdiEntryFileName(file.name))) {
          const packed = await createArchiveOutput({
            compression: "zip",
            entries: files.map((file) => ({ filename: file.name, file })),
            options: { signal: abort.signal },
            outputName: "disc-inputs.zip",
            overrides: { zipCodec: "store" },
            runtime: browserRuntime,
          });
          outputs.push(packed);
          sources = [{ source: packed, name: packed.fileName }];
        }
        for (const { source, name } of sources) {
          const file = source instanceof File ? source : files[0];
          if (!file) throw new Error("No input source is available");
          const ingested = await browserRuntime.ingest.run({
            source,
            fileName: name,
            identify: false,
            select: ["**"],
            interactiveSelectionEnabled: false,
            signal: abort.signal,
          });
          outputs.push(...ingested.outputs, ...ingested.patchOutputs);
          const asFile = async (output: PublicOutput | undefined, name: string) => {
            if (!output) return file;
            const blob = await output.vfs.getFile?.(output.path);
            if (!blob) throw new Error(`Extracted input is unavailable: ${name}`);
            return new File([blob], name, { type: "application/octet-stream" });
          };
          for (const asset of ingested.result.assets) {
            if (asset.kind === "cue" || asset.kind === "gdi" || asset.cueText || asset.gdiText) continue;
            const output = ingested.outputs.find((entry) => entry.path === asset.path);
            const group = asset.discGroupId
              ? ingested.result.assets.filter((entry) => entry.discGroupId === asset.discGroupId)
              : [];
            const sheet = group.find(
              (entry) => entry.kind === "cue" || entry.kind === "gdi" || entry.cueText || entry.gdiText,
            );
            const sheetOutput = sheet ? ingested.outputs.find((entry) => entry.path === sheet.path) : undefined;
            const companions = sheet
              ? ingested.outputs.filter(
                  (entry) => group.some((member) => member.path === entry.path) && entry !== sheetOutput,
                )
              : [];
            if (sheet && !sheetOutput)
              throw new Error("Disc sheet is unavailable; add the disc and its tracks together in an archive.");
            const trackPath = (asset.path || asset.fileName).split("/");
            const sheetDirectory = sheet?.path.split("/").slice(0, -1) || [];
            while (sheetDirectory.length && sheetDirectory[0] === trackPath[0]) {
              sheetDirectory.shift();
              trackPath.shift();
            }
            const target = [...sheetDirectory.map(() => ".."), ...trackPath].join("/");
            candidates.push({
              file: await asFile(output, asset.fileName),
              kind: "rom",
              output: sheetOutput || output,
              companions,
              metadata: {
                recommendedFormat: asset.recommendedFormat,
                format: asset.discFormat || sheet?.discFormat,
                cuePath: sheetOutput?.path,
              },
              ...(sheet ? { target: target.replace(/[[*?]/g, (character) => `[${character}]`) } : {}),
            });
          }
          for (const patch of ingested.result.patches) {
            if (!patch.isValidPatch || patch.format.toLowerCase() !== "ppf") {
              invalidPatch = true;
              notices.push(`Ignored ${patch.fileName}: PPF Undo requires a valid PPF patch.`);
              continue;
            }
            const output = ingested.patchOutputs.find((entry) => entry.path === patch.leafPath);
            candidates.push({ file: await asFile(output, patch.fileName), kind: "patch", output });
          }
          if (!(ingested.result.assets.length || ingested.result.patches.length)) {
            notices.push(`No ROM or PPF patch was found in ${file.name}.`);
          }
        }
        const chosen: Partial<Record<PreparedUndoInput["kind"], PreparedUndoInput>> = {};
        for (const kind of ["rom", "patch"] as const) {
          const options = candidates.filter((candidate) => candidate.kind === kind);
          if (!options.length) continue;
          let selected = options[0];
          if (options.length > 1) {
            const warning = `Choose one ${kind === "rom" ? "patched ROM" : "PPF patch"}; the other inputs will be ignored.`;
            notices.push(warning);
            const choice = await selectFile({
              role: kind === "rom" ? "input" : "patch",
              sourceName: files.map((file) => file.name).join(", "),
              warnings: [warning],
              candidates: options.map((candidate, index) => ({
                type: "file",
                id: String(index),
                fileName: candidate.file.name,
                kind,
                size: candidate.file.size,
                selectable: true,
              })),
            });
            selected = options[Number(choice.id)];
            if (!selected) throw new Error("No input was selected");
          }
          if (selected) chosen[kind] = selected;
        }
        if (abort.signal.aborted) return;
        for (const entry of Object.values(chosen)) owned.current.set(entry.file, entry);
        onInputs(chosen.rom?.file, chosen.patch?.file ?? (invalidPatch ? null : undefined));
        setWarnings(notices);
        if (!chosen.patch && invalidPatch) {
          onError("No valid PPF patch was selected. Replace the invalid input to continue.");
        }
      } catch (cause) {
        if (!abort.signal.aborted) {
          onInputs(null, null);
          onError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        await Promise.all(
          outputs
            .filter(
              (output) =>
                ![...owned.current.values()].some(
                  (entry) => entry.output === output || entry.companions?.includes(output),
                ),
            )
            .map((output) => output.dispose()),
        );
        if (!abort.signal.aborted) setOpening(false);
        abortRef.current = null;
      }
    },
    [onError, onInputs, selectFile],
  );
  const release = useCallback((file: File | null) => {
    if (!file) return;
    const entry = owned.current.get(file);
    owned.current.delete(file);
    for (const output of [entry?.output, ...(entry?.companions || [])]) void output?.dispose();
  }, []);
  const getPrepared = useCallback((file: File | null) => (file ? owned.current.get(file) : undefined), []);
  return { stage, opening, warnings, release, getPrepared, dialog: candidateSelectionDialog };
};

export { usePpfUndoInputs };
