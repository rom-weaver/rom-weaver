import type { LogLevel } from "../../types/logging.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import type {
  PlaylistDryRunPlan,
  PlaylistLayout,
  RomWeaverRunJsonEvent,
} from "../../wasm/generated/rom-weaver-rust-types.d.ts";
import { getRomWeaverRunEventDetails } from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { toRomWeaverOptions } from "./run-options.ts";
import { asRecord, ensureRomWeaverSuccess, getTerminalEvent } from "./run-result-parsing.ts";
import { runRomWeaverJson } from "./wasm-command-shared.ts";

type RuntimePlaylistInput = {
  /** Compress each disc of a `.zip` or folder output to CHD. */
  chd?: boolean;
  /** The `.zip` compression, such as `store`; only a `.zip` output takes one. */
  codec?: string;
  /** Guest paths of the disc files to list. */
  inputs: string[];
  /** Every staged guest path, mapped to itself, so sheet tracks resolve through the staging map. */
  knownPaths: string[];
  /** How a `.zip` or folder output arranges the playlist and discs. */
  layout?: PlaylistLayout;
  logLevel?: LogLevel | string;
  name?: string;
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  output?: string;
  /** Name the discs `<game> (Disc N)` in a `.zip` or folder output. */
  rename?: boolean;
  renameInPlace?: boolean;
  signal?: AbortSignal;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

type PlanRecord = ReturnType<typeof asRecord>;

const isOptionalString = (value: unknown) => value === undefined || value === null || typeof value === "string";

const isPlannedDisc = (disc: PlanRecord) => typeof disc?.path === "string" && typeof disc.game === "string";

const isPlannedRename = (rename: PlanRecord) =>
  typeof rename?.from === "string" && typeof rename.to === "string" && isOptionalString(rename.text);

const isPlannedBundleFile = (file: PlanRecord) =>
  typeof file?.path === "string" && isOptionalString(file.source) && isOptionalString(file.text);

const parsePlaylistPlan = (value: unknown): PlaylistDryRunPlan => {
  const plan = asRecord(value);
  const discs = Array.isArray(plan?.discs) ? plan.discs.map(asRecord) : null;
  const renames = Array.isArray(plan?.renames) ? plan.renames.map(asRecord) : null;
  const bundle = Array.isArray(plan?.bundle) ? plan.bundle.map(asRecord) : null;
  if (
    !(
      plan &&
      isStringArray(plan.entries) &&
      typeof plan.file_name === "string" &&
      typeof plan.text === "string" &&
      discs?.every(isPlannedDisc) &&
      renames?.every(isPlannedRename) &&
      bundle?.every(isPlannedBundleFile)
    )
  ) {
    throw new Error("The playlist plan is missing or malformed.");
  }
  return plan as unknown as PlaylistDryRunPlan;
};

/** Run the engine's `playlist` command: a dry run plans, a run writes. */
const runRomWeaverPlaylist = async (input: RuntimePlaylistInput, dryRun: boolean) => {
  const command = createRomWeaverCommand("playlist", {
    input: input.inputs,
    staged_paths: Object.fromEntries(input.knownPaths.map((path) => [path, path])),
    ...(input.output ? { output: input.output } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.layout ? { layout: input.layout } : {}),
    ...(input.rename ? { rename: true } : {}),
    ...(input.chd ? { chd: true } : {}),
    ...(input.codec ? { codec: input.codec } : {}),
    ...(input.renameInPlace ? { rename_in_place: true } : {}),
  });
  const result = await runRomWeaverJson(
    { command, dry_run: dryRun },
    toRomWeaverOptions({
      interactiveSelectionEnabled: false,
      invalidateMountCacheBeforeRun: true,
      knownInputPaths: input.knownPaths,
      logLevel: input.logLevel,
      onEvent: input.onEvent,
      signal: input.signal,
    }),
  );
  ensureRomWeaverSuccess(result, dryRun ? "Could not plan the playlist." : "Could not write the playlist.");
  return result;
};

/**
 * Plan a playlist with the engine's dry run. It reads the disc sheets, opens each file it would
 * copy, and writes nothing.
 */
const invokeRomWeaverPlaylistPlan = async (input: RuntimePlaylistInput): Promise<PlaylistDryRunPlan> => {
  const result = await runRomWeaverPlaylist(input, true);
  const terminal = getTerminalEvent(result);
  return parsePlaylistPlan(asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null)?.playlist);
};

/** Write the `.zip` or folder a playlist plan describes. */
const invokeRomWeaverPlaylistWrite = async (input: RuntimePlaylistInput): Promise<void> => {
  await runRomWeaverPlaylist(input, false);
};

export { invokeRomWeaverPlaylistPlan, invokeRomWeaverPlaylistWrite };
