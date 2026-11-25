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
      discs?.every((disc) => typeof disc?.path === "string" && typeof disc.game === "string") &&
      renames?.every(
        (rename) =>
          typeof rename?.from === "string" &&
          typeof rename.to === "string" &&
          (rename.text === undefined || rename.text === null || typeof rename.text === "string"),
      ) &&
      bundle?.every(
        (file) =>
          typeof file?.path === "string" &&
          (file.source === undefined || file.source === null || typeof file.source === "string") &&
          (file.text === undefined || file.text === null || typeof file.text === "string"),
      )
    )
  ) {
    throw new Error("The playlist plan is missing or malformed.");
  }
  return plan as unknown as PlaylistDryRunPlan;
};

/** Run the engine's `playlist` command; the plan and the real run differ only in `dryRun`. */
const runRomWeaverPlaylist = async (input: RuntimePlaylistInput, dryRun: boolean) => {
  const command = createRomWeaverCommand("playlist", {
    input: input.inputs,
    staged_paths: Object.fromEntries(input.knownPaths.map((path) => [path, path])),
    ...(input.output ? { output: input.output } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.layout ? { layout: input.layout } : {}),
    ...(input.rename ? { rename: true } : {}),
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

/** Plan a playlist with the engine's dry run, which reads only the disc sheets and writes nothing. */
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
