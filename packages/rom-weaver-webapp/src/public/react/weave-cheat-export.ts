import type { CheatRecord } from "../../lib/cheats/model.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { SourceRef } from "../../types/source.ts";
import { createVfsFileRef } from "../../storage/vfs/source-ref.ts";
import { gateWeaveChainChecks } from "../../lib/weave/weave-targets.ts";
import { toCheatPatchNameSuffix } from "./cheat-patch-name.ts";

type WeavePatch = Parameters<NonNullable<NonNullable<WorkflowRuntime["weave"]>["create"]>>[0]["patches"][number];
type WeaveCheatSelection = { record: CheatRecord; position: number };

const prepareWeaveCheatPatches = async ({
  runtime,
  rom,
  patches,
  cheats,
  patchBasis,
  signal,
  onProgress,
}: {
  runtime: WorkflowRuntime;
  rom: SourceRef;
  patches: WeavePatch[];
  cheats: readonly WeaveCheatSelection[];
  patchBasis: "auto" | "base" | "previous";
  signal: AbortSignal;
  onProgress: (label: string) => void;
}): Promise<WeavePatch[]> => {
  if (!cheats.length) return patches;
  const classify = runtime.cheat?.run;
  if (!classify) throw new Error("Cheat patch export is not available in this runtime");
  const groups = new Map<number, CheatRecord[]>();
  for (const { record, position } of cheats) {
    if (!Number.isInteger(position) || position < 0 || position > patches.length) {
      throw new Error(`Cheat position ${position} exceeds the ${patches.length} patch steps`);
    }
    groups.set(position, [...(groups.get(position) || []), record]);
  }
  const expanded: WeavePatch[] = [];
  const target = patches[0]?.target;
  if (patches.some((patch) => JSON.stringify(patch.target) !== JSON.stringify(target))) {
    throw new Error("Cheat weave export requires one ROM target");
  }
  const ids = new Set(patches.flatMap((patch) => (patch.id ? [patch.id] : [])));
  let cheatIndex = 0;
  for (let position = 0; position <= patches.length; position += 1) {
    signal.throwIfAborted();
    const records = groups.get(position);
    if (records) {
      onProgress(`Preparing ${records.length} cheat patch${records.length === 1 ? "" : "es"}`);
      const checks = gateWeaveChainChecks(
        expanded.map((patch) => ({ ...patch, enabled: !patch.optional, authoredInputChecks: !!patch.inputChecks })),
      );
      const prefix = expanded.flatMap((patch, index) => (patch.optional ? [] : [{ ...patch, ...checks[index] }]));
      let prefixOutput: Awaited<ReturnType<NonNullable<WorkflowRuntime["patch"]["applyPatch"]>>> | undefined;
      try {
        let source = rom;
        if (prefix.length) {
          const applyPatch = runtime.patch.applyPatch;
          if (!applyPatch) throw new Error("Patch application is not available in this runtime");
          // Compare codes MUST resolve against the bytes at their chosen position.
          prefixOutput = await applyPatch({
            input: rom,
            patches: prefix.map((patch) => ({ patchFile: patch.source as SourceRef, patchFileName: patch.fileName })),
            options: {
              defaultPatchBasis: patchBasis,
              headerModes: prefix.map((patch) => patch.header || "auto"),
              patchBasis: prefix.map((patch) => patch.basis || patchBasis),
              patchIds: prefix.map((patch) => patch.id || ""),
              patchInputs: prefix.map((patch) => patch.input ?? null),
              patchTargets: prefix.map((patch) => patch.target ?? null),
              patchInputChecks: prefix.map((patch) => patch.inputChecks || ""),
              patchOutputChecks: prefix.map((patch) => patch.outputChecks || ""),
              outputHeader: "keep",
            },
            signal,
          });
          source = createVfsFileRef(prefixOutput.vfs, prefixOutput.path, { fileName: prefixOutput.fileName });
        }
        const result = await classify({ records, source, exportPatches: true, signal });
        signal.throwIfAborted();
        if (result.patches?.length !== records.length) throw new Error("Cheat patch snapshots were missing");
        for (const [index, snapshot] of result.patches.entries()) {
          const record = records[index];
          if (!record) throw new Error("Cheat patch snapshot has no matching record");
          cheatIndex += 1;
          let id = `cheat-${cheatIndex}`;
          while (ids.has(id)) id = `${id}-cheat`;
          ids.add(id);
          const name = record.description || record.id;
          const slug = toCheatPatchNameSuffix(name).replace(/\s+/g, "-") || "cheat";
          const fileName = `cheat-${cheatIndex}-${slug}.${snapshot.format}`;
          expanded.push({
            id,
            name,
            description: record.rawCode || name,
            fileName,
            source: new File([Uint8Array.from(snapshot.bytes)], fileName),
            header: "keep",
            basis: "previous",
            ...(target ? { target } : {}),
          });
        }
      } finally {
        await prefixOutput?.dispose();
      }
    }
    const patch = patches[position];
    if (patch) expanded.push(patch);
  }
  return expanded;
};

export { prepareWeaveCheatPatches };
export type { WeaveCheatSelection };
