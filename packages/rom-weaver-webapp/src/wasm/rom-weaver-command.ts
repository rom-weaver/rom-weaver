import {
  assertKnownRomWeaverWeaveCommandType,
  assertKnownRomWeaverCommandType,
  assertKnownRomWeaverPatchCommandType,
  isKnownRomWeaverPatchCommandType,
  isKnownRomWeaverWeaveCommandType,
  isKnownRomWeaverSaveCommandType,
  isKnownRomWeaverToolsCommandType,
} from "./generated/rom-weaver-command-types.ts";
import type {
  RomWeaverCommand,
  RomWeaverDefaultThreads,
  RomWeaverRunInput,
  RomWeaverRunOutputOptions,
  RomWeaverRunRequest,
} from "./rom-weaver-types.d.ts";

export { KNOWN_COMMAND_TYPES, KNOWN_PATCH_COMMAND_TYPES } from "./generated/rom-weaver-command-types.ts";

type CanonicalRomWeaverCommand = Exclude<RomWeaverCommand, { type: "bundle" }>;
type RomWeaverBundleCommand = Extract<RomWeaverCommand, { type: "bundle" }>["args"];
type RomWeaverBundleCommandType = RomWeaverBundleCommand["type"];
type RomWeaverBundleCommandBranch = {
  [TType in RomWeaverBundleCommandType]: {
    args: Extract<RomWeaverBundleCommand, { type: TType }>["args"];
    type: `bundle-${TType}`;
  };
}[RomWeaverBundleCommandType];

type RomWeaverPatchCommand = Extract<RomWeaverCommand, { type: "patch" }>["args"];
type RomWeaverPatchCommandType = RomWeaverPatchCommand["type"];
type RomWeaverWeaveCommand = Extract<RomWeaverCommand, { type: "weave" }>["args"];
type RomWeaverWeaveCommandType = RomWeaverWeaveCommand["type"];
type RomWeaverToolsCommand = Extract<RomWeaverCommand, { type: "tools" }>["args"];
type RomWeaverToolsCommandType = RomWeaverToolsCommand["type"];
type RomWeaverSaveCommand = Extract<RomWeaverCommand, { type: "save" }>["args"];
type RomWeaverSaveCommandType = RomWeaverSaveCommand["type"];
type RomWeaverTopLevelCommand = Exclude<
  CanonicalRomWeaverCommand,
  { type: "weave" } | { type: "patch" } | { type: "save" } | { type: "tools" }
>;
type RomWeaverTopLevelCommandType = RomWeaverTopLevelCommand["type"];
type RomWeaverPatchCommandLabel = `patch-${RomWeaverPatchCommandType}`;
type RomWeaverPatchCommandBranch = {
  [TType in RomWeaverPatchCommandType]: {
    args: Extract<RomWeaverPatchCommand, { type: TType }>["args"];
    type: `patch-${TType}`;
  };
}[RomWeaverPatchCommandType];
type RomWeaverWeaveCommandLabel = `weave-${RomWeaverWeaveCommandType}`;
type RomWeaverWeaveCommandBranch = {
  [TType in RomWeaverWeaveCommandType]: {
    args: Extract<RomWeaverWeaveCommand, { type: TType }>["args"];
    type: `weave-${TType}`;
  };
}[RomWeaverWeaveCommandType];
type RomWeaverToolsCommandLabel = `tools-${RomWeaverToolsCommandType}`;
type RomWeaverToolsCommandBranch = {
  [TType in RomWeaverToolsCommandType]: {
    args: Extract<RomWeaverToolsCommand, { type: TType }>["args"];
    type: `tools-${TType}`;
  };
}[RomWeaverToolsCommandType];
type RomWeaverSaveCommandBranch = {
  [TType in RomWeaverSaveCommandType]: {
    args: Extract<RomWeaverSaveCommand, { type: TType }>["args"];
    type: `save-${TType}`;
  };
}[RomWeaverSaveCommandType];
type RomWeaverTopLevelCommandBranch = {
  [TType in RomWeaverTopLevelCommandType]: {
    args: Extract<RomWeaverTopLevelCommand, { type: TType }>["args"];
    type: TType;
  };
}[RomWeaverTopLevelCommandType];

export type RomWeaverCommandLabel =
  | RomWeaverTopLevelCommandType
  | RomWeaverPatchCommandLabel
  | RomWeaverWeaveCommandLabel
  | `bundle-${RomWeaverBundleCommandType}`
  | RomWeaverToolsCommandLabel
  | `save-${RomWeaverSaveCommandType}`;
type RomWeaverCommandBranch =
  | RomWeaverTopLevelCommandBranch
  | RomWeaverPatchCommandBranch
  | RomWeaverWeaveCommandBranch
  | RomWeaverBundleCommandBranch
  | RomWeaverToolsCommandBranch
  | RomWeaverSaveCommandBranch;
export type RomWeaverCommandBranchArgs<TType extends RomWeaverCommandLabel> = Extract<
  RomWeaverCommandBranch,
  { type: TType }
>["args"];

export type RomWeaverCommandInputPathOptions = {
  knownInputPaths?: Iterable<unknown> | null | undefined;
};

export type RomWeaverBrowserThreadRequestOptions = {
  autoThreads?: number | null | undefined;
  defaultThreads?: RomWeaverDefaultThreads;
  maxThreads?: number | null | undefined;
};

export function createRomWeaverCommand<TType extends RomWeaverCommandLabel>(
  type: TType,
  args: RomWeaverCommandBranchArgs<TType>,
): RomWeaverCommand {
  switch (type) {
    case "probe":
    case "extract":
    case "checksum":
    case "identify":
    case "ingest":
    case "cheat":
    case "compress":
    case "trim":
    case "plan-extract-batch":
      return { args, type } as CanonicalRomWeaverCommand;
    case "patch-apply":
    case "patch-validate":
    case "patch-create":
    case "bundle-parse":
    case "weave-parse":
    case "bundle-create":
    case "weave-create":
    case "tools-ppf-undo":
    case "save-identify":
    case "save-create":
    case "save-list-games":
    case "save-inspect":
    case "save-get":
    case "save-set":
    case "save-export-schema": {
      const separator = type.indexOf("-");
      const family = type.slice(0, separator);
      const command = {
        args: { args, type: type.slice(separator + 1) },
        type: family,
      } as RomWeaverCommand;
      return command;
    }
    default:
      return assertNever(type);
  }
}

export function normalizeRomWeaverRunRequest(
  commandOrRequest: RomWeaverRunInput,
  outputOverrides: Partial<RomWeaverRunOutputOptions> = {},
): RomWeaverRunRequest {
  if (!isObjectRecord(commandOrRequest)) {
    throw new TypeError("rom-weaver run requires a typed command or run request object");
  }

  const hasRequestShape = isRomWeaverRunRequestLike(commandOrRequest);
  const command = normalizeRomWeaverCommand(hasRequestShape ? commandOrRequest.command : commandOrRequest);
  const baseOutput = hasRequestShape && isObjectRecord(commandOrRequest.output) ? commandOrRequest.output : {};
  const output = normalizeRomWeaverRunOutputOptions({
    ...baseOutput,
    ...outputOverrides,
  });
  if (hasRequestShape && commandOrRequest.dry_run !== undefined) {
    if (typeof commandOrRequest.dry_run !== "boolean") {
      throw new TypeError("rom-weaver dry_run must be a boolean");
    }
    return { command, dry_run: commandOrRequest.dry_run, output };
  }
  return { command, output };
}

function normalizeRomWeaverCommand(command: RomWeaverCommand): CanonicalRomWeaverCommand {
  if (!isObjectRecord(command)) {
    throw new TypeError("rom-weaver typed command must be an object");
  }
  const rawType = (command as unknown as { type?: unknown }).type;
  const type = assertKnownRomWeaverCommandType(rawType === "bundle" ? "weave" : rawType, "rom-weaver typed command");
  if (type === "patch" || type === "weave" || type === "tools" || type === "save") {
    return normalizeRomWeaverNestedCommand(type, command.args);
  }

  const args = isObjectRecord(command.args) ? { ...command.args } : {};
  return { args, type } as CanonicalRomWeaverCommand;
}

function normalizeRomWeaverRunOutputOptions(
  output: Partial<RomWeaverRunOutputOptions> | null | undefined,
): RomWeaverRunOutputOptions {
  const normalized: RomWeaverRunOutputOptions = {};
  if (output?.json !== undefined) normalized.json = Boolean(output.json);
  if (output?.log_level !== undefined) normalized.log_level = output.log_level;
  if (output?.dep_trace !== undefined) normalized.dep_trace = Boolean(output.dep_trace);
  if (typeof output?.progress === "boolean") normalized.progress = output.progress;
  if (output?.interactive_selection_enabled !== undefined) {
    normalized.interactive_selection_enabled = Boolean(output.interactive_selection_enabled);
  }
  return normalized;
}

export function readRomWeaverRunInputCommand(input: RomWeaverRunInput): RomWeaverCommand {
  return isRomWeaverRunRequestLike(input) ? input.command : input;
}

export function readRomWeaverRunRequestCommand(request: RomWeaverRunRequest): RomWeaverCommand {
  return request.command;
}

function readRomWeaverCommandBranch(inputCommand: RomWeaverCommand): RomWeaverCommandBranch {
  if (inputCommand.type === "bundle") {
    assertKnownRomWeaverWeaveCommandType(inputCommand.args.type, "rom-weaver bundle command");
    return { type: `bundle-${inputCommand.args.type}`, args: inputCommand.args.args } as RomWeaverBundleCommandBranch;
  }
  const command = inputCommand;
  switch (command.type) {
    case "probe":
    case "extract":
    case "checksum":
    case "identify":
    case "ingest":
    case "cheat":
    case "compress":
    case "trim":
    case "plan-extract-batch":
      return {
        args: command.args,
        type: command.type,
      } as RomWeaverTopLevelCommandBranch;
    case "patch":
    case "weave":
    case "tools":
    case "save":
      if (!NESTED_COMMAND_TYPES[command.type](command.args.type)) {
        if (command.type === "tools") throw new TypeError(`unsupported tools command: ${String(command.args.type)}`);
        return unhandledCommandShape(command.args);
      }
      return { args: command.args.args, type: `${command.type}-${command.args.type}` } as RomWeaverCommandBranch;
    default:
      return assertNever(command);
  }
}

function readRomWeaverCommandArgs(command: RomWeaverCommand): Record<string, unknown> {
  return readRomWeaverCommandBranch(command).args as Record<string, unknown>;
}

export function getRomWeaverCommandLabel(command: RomWeaverCommand): RomWeaverCommandLabel {
  return readRomWeaverCommandBranch(command).type;
}

export function collectRomWeaverRunInputPaths(
  commandOrRequest: RomWeaverRunInput,
  options: RomWeaverCommandInputPathOptions = {},
): string[] {
  const command = readRomWeaverRunInputCommand(commandOrRequest);
  const paths = new Set<string>();
  switch (command.type) {
    case "probe":
    case "extract":
    case "checksum":
    case "identify":
    case "ingest":
      if (command.type !== "ingest" || !command.args.sidecar_only) {
        pushPathValue(paths, command.args.input);
      }
      if (command.type === "identify" || command.type === "ingest") {
        pushPathValues(paths, command.args.database);
      }
      break;
    case "cheat":
      pushPathValue(paths, command.args.input);
      break;
    case "compress":
      pushPathValues(paths, command.args.input);
      break;
    case "trim":
      pushPathValues(paths, command.args.input);
      break;
    case "patch":
      collectRomWeaverPatchInputPaths(paths, command.args);
      break;
    case "weave":
    case "bundle":
      collectRomWeaverWeaveInputPaths(paths, command.args);
      break;
    case "tools":
      pushPathValue(paths, command.args.args.rom);
      pushPathValue(paths, command.args.args.patch);
      break;
    case "save":
      if (command.args.type === "create") {
        pushPathValue(paths, command.args.args.template);
      } else if (command.args.type !== "list-games") {
        pushPathValue(paths, command.args.args.input);
      }
      break;
    case "plan-extract-batch":
      // Pure planning over sizes passed in the args - no file inputs to reference.
      break;
    default:
      assertNever(command);
  }

  pushPathValues(paths, options.knownInputPaths);
  return [...paths];
}

export function withRomWeaverDefaultThreads(
  request: RomWeaverRunRequest,
  defaultThreads: RomWeaverDefaultThreads,
): RomWeaverRunRequest {
  if (!(defaultThreads && romWeaverCommandSupportsThreads(request.command))) return request;
  const args = readRomWeaverCommandArgs(request.command);
  if (Object.hasOwn(args, "threads") && args.threads !== undefined && args.threads !== null) {
    return request;
  }
  return replaceRomWeaverRunRequestCommandArgs(request, {
    ...args,
    threads: defaultThreads,
  });
}

export function clampRomWeaverBrowserThreadRequest(
  request: RomWeaverRunRequest,
  options: RomWeaverBrowserThreadRequestOptions = {},
): RomWeaverRunRequest {
  if (!romWeaverCommandSupportsThreads(request.command)) return request;
  const args = readRomWeaverCommandArgs(request.command);
  if (!Object.hasOwn(args, "threads") || args.threads === undefined || args.threads === null) {
    return request;
  }
  const clamped = clampRomWeaverBrowserThreadBudget(args.threads, options);
  if (Object.is(clamped, args.threads)) return request;
  return replaceRomWeaverRunRequestCommandArgs(request, {
    ...args,
    threads: clamped,
  });
}

/**
 * Set a supported command's requested thread budget to its share of the concurrent-work limit.
 * The format and input size still determine how many threads the command uses.
 */
export function withRomWeaverForcedThreads(input: RomWeaverRunInput, threads: number): RomWeaverRunInput {
  const command = readRomWeaverRunInputCommand(input);
  if (!romWeaverCommandSupportsThreads(command)) return input;
  const safeThreads = Math.max(1, Math.floor(threads));
  const args = readRomWeaverCommandArgs(command);
  if (args.threads === safeThreads) return input;
  const nextArgs = { ...args, threads: safeThreads };
  return isRomWeaverRunRequestLike(input)
    ? replaceRomWeaverRunRequestCommandArgs(input, nextArgs)
    : replaceRomWeaverCommandArgs(command, nextArgs);
}

export function readRomWeaverRequestedThreadCount(
  commandOrRequest: RomWeaverRunInput,
  options: RomWeaverBrowserThreadRequestOptions = {},
): number | null {
  const command = readRomWeaverRunInputCommand(commandOrRequest);
  if (!romWeaverCommandSupportsThreads(command)) return null;
  return parseRomWeaverThreadBudgetCount(readRomWeaverCommandArgs(command).threads, options);
}

export function romWeaverCommandSupportsThreads(inputCommand: RomWeaverCommand): boolean {
  const command = inputCommand;
  switch (command.type) {
    case "probe":
    case "cheat":
      return false;
    case "extract":
    case "checksum":
    case "identify":
    case "ingest":
    case "compress":
    case "trim":
      return true;
    case "patch":
    case "weave":
    case "bundle":
      if (!NESTED_COMMAND_TYPES[command.type](command.args.type)) return unhandledCommandShape(command.args);
      return true;
    case "tools":
      return command.args.type === "ppf-undo";
    case "save":
      return false;
    case "plan-extract-batch":
      // Pure planning: the `threads` field is the budget to plan for, not a worker spawn, so it is
      // passed through untouched (no clamp/inject/force).
      return false;
    default:
      return assertNever(command);
  }
}

const NESTED_COMMAND_TYPES = {
  patch: isKnownRomWeaverPatchCommandType,
  weave: isKnownRomWeaverWeaveCommandType,
  bundle: isKnownRomWeaverWeaveCommandType,
  tools: isKnownRomWeaverToolsCommandType,
  save: isKnownRomWeaverSaveCommandType,
};

const LEGACY_WEAVE_FIELDS = [
  ["bundle", "weave"],
  ["bundle_rom", "weave_rom"],
  ["no_bundle_rom", "no_weave_rom"],
  ["emit_bundle", "emit_weave"],
] as const;

function normalizeLegacyWeaveFields(args: Record<string, unknown>): void {
  for (const [legacy, canonical] of LEGACY_WEAVE_FIELDS) {
    if (!Object.hasOwn(args, canonical) && Object.hasOwn(args, legacy)) args[canonical] = args[legacy];
    delete args[legacy];
  }
}

function normalizeRomWeaverNestedCommand(
  family: "patch" | "weave" | "tools" | "save",
  command: unknown,
): CanonicalRomWeaverCommand {
  const label = `rom-weaver ${family} command`;
  if (!isObjectRecord(command)) throw new TypeError(`${label} requires an object \`args\` payload`);
  let type = command.type;
  if (family === "patch" || family === "weave") {
    const assertType = family === "patch" ? assertKnownRomWeaverPatchCommandType : assertKnownRomWeaverWeaveCommandType;
    type = assertType(type, label, "nested `type` field");
  } else {
    if (family === "save") type = String(type || "");
    const isKnownType = family === "save" ? isKnownRomWeaverSaveCommandType : isKnownRomWeaverToolsCommandType;
    if (!isKnownType(type)) throw new TypeError(`unsupported ${family} command: ${String(type)}`);
  }
  const args = isObjectRecord(command.args) ? { ...command.args } : {};
  if (family === "weave" || (family === "patch" && type === "apply")) normalizeLegacyWeaveFields(args);
  return { args: { args, type }, type: family } as CanonicalRomWeaverCommand;
}

function collectRomWeaverWeaveInputPaths(paths: Set<string>, command: RomWeaverWeaveCommand | RomWeaverBundleCommand) {
  switch (command.type) {
    case "parse":
      pushPathValue(paths, command.args.input);
      return;
    case "create":
      pushPathValue(paths, command.args.rom);
      pushPathValue(
        paths,
        Object.hasOwn(command.args, "weave_rom")
          ? (command.args as Record<string, unknown>).weave_rom
          : (command.args as Record<string, unknown>).bundle_rom,
      );
      pushPathValues(paths, command.args.patch);
      return;
    default:
      assertNever(command);
  }
}

function collectRomWeaverPatchInputPaths(paths: Set<string>, command: RomWeaverPatchCommand) {
  switch (command.type) {
    case "apply":
    case "validate":
      pushPathValue(paths, command.args.input);
      pushPathValues(paths, command.args.patches);
      return;
    case "create":
      pushPathValue(paths, command.args.original);
      pushPathValue(paths, command.args.modified);
      return;
    default:
      assertNever(command);
  }
}

function replaceRomWeaverRunRequestCommandArgs(
  request: RomWeaverRunRequest,
  args: Record<string, unknown>,
): RomWeaverRunRequest {
  return {
    ...request,
    command: replaceRomWeaverCommandArgs(request.command, args),
  };
}

function replaceRomWeaverCommandArgs(inputCommand: RomWeaverCommand, args: Record<string, unknown>): RomWeaverCommand {
  if (inputCommand.type === "bundle") {
    return { ...inputCommand, args: { ...inputCommand.args, args } } as RomWeaverCommand;
  }
  const command = inputCommand;
  switch (command.type) {
    case "probe":
    case "extract":
    case "checksum":
    case "identify":
    case "ingest":
    case "cheat":
    case "compress":
    case "trim":
    case "plan-extract-batch":
      return {
        ...command,
        args,
      } as RomWeaverCommand;
    case "patch":
    case "weave":
    case "tools":
    case "save":
      return {
        ...command,
        args: {
          ...command.args,
          args,
        },
      } as RomWeaverCommand;
    default:
      return assertNever(command);
  }
}

function clampRomWeaverBrowserThreadBudget(value: unknown, options: RomWeaverBrowserThreadRequestOptions): unknown {
  const maxThreads = normalizePositiveIntegerOption(options.maxThreads, 64);
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = Math.floor(value);
    return parsed > 0 ? Math.min(parsed, maxThreads) : value;
  }
  if (typeof value === "bigint") {
    if (value <= 0n) return value;
    const max = BigInt(maxThreads);
    return Number(value > max ? max : value);
  }
  const raw = String(value ?? "").trim();
  if (raw.toLowerCase() === "auto") {
    return resolveAutoThreadCount(options);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return value;
  return Math.min(parsed, maxThreads);
}

function parseNumericThreadBudget(value: unknown, maxThreads: number): number | null | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = Math.floor(value);
    return parsed > 0 ? Math.min(parsed, maxThreads) : null;
  }
  if (typeof value === "bigint") {
    if (value <= 0n) return null;
    const max = BigInt(maxThreads);
    return Number(value > max ? max : value);
  }
  return undefined;
}

function parseRomWeaverThreadBudgetCount(value: unknown, options: RomWeaverBrowserThreadRequestOptions): number | null {
  const maxThreads = normalizePositiveIntegerOption(options.maxThreads, 64);
  if (value === undefined || value === null) return null;
  const numeric = parseNumericThreadBudget(value, maxThreads);
  if (numeric !== undefined) return numeric;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "auto") return resolveAutoThreadCount(options);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, maxThreads);
}

function resolveAutoThreadCount(options: RomWeaverBrowserThreadRequestOptions): number {
  const maxThreads = normalizePositiveIntegerOption(options.maxThreads, 64);
  const defaultThreads = normalizePositiveIntegerOption(options.defaultThreads, null);
  if (defaultThreads !== null) return Math.min(defaultThreads, maxThreads);
  const autoThreads = normalizePositiveIntegerOption(options.autoThreads, 4);
  return Math.min(autoThreads, maxThreads);
}

function normalizePositiveIntegerOption<TFallback extends number | null>(
  value: unknown,
  fallback: TFallback,
): number | TFallback {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRomWeaverRunRequestLike(input: unknown): input is RomWeaverRunRequest {
  return isObjectRecord(input) && "command" in input && isObjectRecord(input.command);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pushPathValues(out: Set<string>, value: unknown) {
  if (isIterableValue(value) && typeof value !== "string") {
    for (const entry of value) pushPathValue(out, entry);
    return;
  }
  pushPathValue(out, value);
}

function pushPathValue(out: Set<string>, value: unknown) {
  if (typeof value !== "string") return;
  const path = value.trim();
  if (!path || path.startsWith("-")) return;
  out.add(path);
}

function isIterableValue(value: unknown): value is Iterable<unknown> {
  return Boolean(value && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function");
}

function unhandledCommandShape(value: unknown): never {
  throw new Error(`Unhandled rom-weaver command shape: ${JSON.stringify(value)}`);
}

function assertNever(value: never): never {
  return unhandledCommandShape(value);
}
