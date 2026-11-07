import type { LogLevel } from "../../types/logging.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import type { PlaylistDryRunPlan } from "../../wasm/generated/rom-weaver-rust-types.d.ts";
import { getRomWeaverRunEventDetails } from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { toRomWeaverOptions } from "./run-options.ts";
import { asRecord, ensureRomWeaverSuccess, getTerminalEvent } from "./run-result-parsing.ts";
import { runRomWeaverJson } from "./wasm-command-shared.ts";

type RuntimePlaylistPlanInput = {
  /** Guest paths of the disc files to list. */
  inputs: string[];
  /** Every staged guest path, mapped to itself, so sheet tracks resolve through the staging map. */
  knownPaths: string[];
  logLevel?: LogLevel | string;
  name?: string;
  output?: string;
  renameInPlace?: boolean;
  signal?: AbortSignal;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const parsePlaylistPlan = (value: unknown): PlaylistDryRunPlan => {
  const plan = asRecord(value);
  const discs = Array.isArray(plan?.discs) ? plan.discs.map(asRecord) : null;
  const renames = Array.isArray(plan?.renames) ? plan.renames.map(asRecord) : null;
  if (
    !(
      plan &&
      isStringArray(plan.entries) &&
      typeof plan.file_name === "string" &&
      typeof plan.text === "string" &&
      discs?.every((disc) => typeof disc?.path === "string" && typeof disc.game === "string") &&
      renames?.every(
        (rename) =>
          typeof rename?.from === "string" &&
          typeof rename.to === "string" &&
          (rename.text === undefined || rename.text === null || typeof rename.text === "string"),
      )
    )
  ) {
    throw new Error("The playlist plan is missing or malformed.");
  }
  return plan as unknown as PlaylistDryRunPlan;
};

/** Plan a playlist with the engine's dry run, which reads only the disc sheets and writes nothing. */
const invokeRomWeaverPlaylistPlan = async (input: RuntimePlaylistPlanInput): Promise<PlaylistDryRunPlan> => {
  const command = createRomWeaverCommand("playlist", {
    input: input.inputs,
    staged_paths: Object.fromEntries(input.knownPaths.map((path) => [path, path])),
    ...(input.output ? { output: input.output } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.renameInPlace ? { rename_in_place: true } : {}),
  });
  const result = await runRomWeaverJson(
    { command, dry_run: true },
    toRomWeaverOptions({
      interactiveSelectionEnabled: false,
      invalidateMountCacheBeforeRun: true,
      knownInputPaths: input.knownPaths,
      logLevel: input.logLevel,
      signal: input.signal,
    }),
  );
  ensureRomWeaverSuccess(result, "Could not plan the playlist.");
  const terminal = getTerminalEvent(result);
  return parsePlaylistPlan(asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null)?.playlist);
};

export { invokeRomWeaverPlaylistPlan };
