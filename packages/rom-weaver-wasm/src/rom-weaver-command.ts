import {
  assertKnownRomWeaverBundleCommandType,
  assertKnownRomWeaverCommandType,
  assertKnownRomWeaverPatchCommandType,
} from "./generated/rom-weaver-command-types.ts";
import type {
  RomWeaverCommand,
  RomWeaverDefaultThreads,
  RomWeaverRunInput,
  RomWeaverRunOutputOptions,
  RomWeaverRunRequest,
} from "./rom-weaver-types.d.ts";

export { KNOWN_COMMAND_TYPES, KNOWN_PATCH_COMMAND_TYPES } from "./generated/rom-weaver-command-types.ts";

type RomWeaverPatchCommand = Extract<RomWeaverCommand, { type: "patch" }>["args"];
type RomWeaverPatchCommandType = RomWeaverPatchCommand["type"];
type RomWeaverBundleCommand = Extract<RomWeaverCommand, { type: "bundle" }>["args"];
type RomWeaverBundleCommandType = RomWeaverBundleCommand["type"];
type RomWeaverToolsCommand = Extract<RomWeaverCommand, { type: "tools" }>["args"];
type RomWeaverToolsCommandType = RomWeaverToolsCommand["type"];
type RomWeaverTopLevelCommand = Exclude<RomWeaverCommand, { type: "bundle" } | { type: "patch" } | { type: "tools" }>;
type RomWeaverTopLevelCommandType = RomWeaverTopLevelCommand["type"];
type RomWeaverPatchCommandLabel = `patch-${RomWeaverPatchCommandType}`;
type RomWeaverPatchCommandBranch = {
  [TType in RomWeaverPatchCommandType]: {
    args: Extract<RomWeaverPatchCommand, { type: TType }>["args"];
    type: `patch-${TType}`;
  };
}[RomWeaverPatchCommandType];
type RomWeaverBundleCommandLabel = `bundle-${RomWeaverBundleCommandType}`;
type RomWeaverBundleCommandBranch = {
  [TType in RomWeaverBundleCommandType]: {
    args: Extract<RomWeaverBundleCommand, { type: TType }>["args"];
    type: `bundle-${TType}`;
  };
}[RomWeaverBundleCommandType];
type RomWeaverToolsCommandLabel = `tools-${RomWeaverToolsCommandType}`;
type RomWeaverToolsCommandBranch = {
  [TType in RomWeaverToolsCommandType]: {
    args: Extract<RomWeaverToolsCommand, { type: TType }>["args"];
    type: `tools-${TType}`;
  };
}[RomWeaverToolsCommandType];
type RomWeaverTopLevelCommandBranch = {
  [TType in RomWeaverTopLevelCommandType]: {
    args: Extract<RomWeaverTopLevelCommand, { type: TType }>["args"];
    type: TType;
  };
}[RomWeaverTopLevelCommandType];

export type RomWeaverCommandLabel =
  | RomWeaverTopLevelCommandType
  | RomWeaverPatchCommandLabel
  | RomWeaverBundleCommandLabel
  | RomWeaverToolsCommandLabel;
type RomWeaverCommandBranch =
  | RomWeaverTopLevelCommandBranch
  | RomWeaverPatchCommandBranch
  | RomWeaverBundleCommandBranch
  | RomWeaverToolsCommandBranch;
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
    case "ingest":
    case "compress":
    case "trim":
    case "plan-extract-batch":
      return { args, type } as RomWeaverCommand;
    case "patch-apply":
      return { args: { args, type: "apply" }, type: "patch" } as RomWeaverCommand;
    case "patch-validate":
      return { args: { args, type: "validate" }, type: "patch" } as RomWeaverCommand;
    case "patch-create":
      return { args: { args, type: "create" }, type: "patch" } as RomWeaverCommand;
    case "bundle-parse":
      return { args: { args, type: "parse" }, type: "bundle" } as RomWeaverCommand;
    case "bundle-create":
      return { args: { args, type: "create" }, type: "bundle" } as RomWeaverCommand;
    case "tools-ppf-undo":
      return { args: { args, type: "ppf-undo" }, type: "tools" } as RomWeaverCommand;
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
  return { command, output };
}

function normalizeRomWeaverCommand(command: RomWeaverCommand): RomWeaverCommand {
  if (!isObjectRecord(command)) {
    throw new TypeError("rom-weaver typed command must be an object");
  }
  const type = assertKnownRomWeaverCommandType(command.type, "rom-weaver typed command");
  if (type === "patch") {
    return normalizeRomWeaverPatchCommand((command as Extract<RomWeaverCommand, { type: "patch" }>).args);
  }
  if (type === "bundle") {
    return normalizeRomWeaverBundleCommand((command as Extract<RomWeaverCommand, { type: "bundle" }>).args);
  }
  if (type === "tools") {
    return normalizeRomWeaverToolsCommand((command as Extract<RomWeaverCommand, { type: "tools" }>).args);
  }

  const args = isObjectRecord(command.args) ? { ...command.args } : {};
  switch (type) {
    case "probe":
    case "extract":
    case "checksum":
    case "ingest":
    case "compress":
    case "trim":
    case "plan-extract-batch":
      return { args, type } as RomWeaverCommand;
    default:
      return assertNever(type);
  }
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

function readRomWeaverCommandBranch(command: RomWeaverCommand): RomWeaverCommandBranch {
  switch (command.type) {
    case "probe":
    case "extract":
    case "checksum":
    case "ingest":
    case "compress":
    case "trim":
    case "plan-extract-batch":
      return {
        args: command.args,
        type: command.type,
      } as RomWeaverTopLevelCommandBranch;
    case "patch":
      return readRomWeaverPatchCommandBranch(command.args);
    case "bundle":
      return readRomWeaverBundleCommandBranch(command.args);
    case "tools":
      return readRomWeaverToolsCommandBranch(command.args);
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
    case "ingest":
      if (command.type !== "ingest" || !command.args.sidecar_only) {
        pushPathValue(paths, command.args.input);
      }
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
    case "bundle":
      collectRomWeaverBundleInputPaths(paths, command.args);
      break;
    case "tools":
      pushPathValue(paths, command.args.args.rom);
      pushPathValue(paths, command.args.args.patch);
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
 * Force a thread-supporting command to use exactly `threads` worker threads, returning the input
 * unchanged for thread-less commands (probe/list) or when it already requests that count. Used to
 * hand each concurrently-dispatched operation its fair slice of the shared thread budget so K
 * operations running at once never collectively oversubscribe the WASI thread-worker pool (which
 * surfaces as `EAGAIN`/`os error 6` and a silent single-thread fallback).
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

export function romWeaverCommandSupportsThreads(command: RomWeaverCommand): boolean {
  switch (command.type) {
    case "probe":
      return false;
    case "extract":
    case "checksum":
    case "ingest":
    case "compress":
    case "trim":
      return true;
    case "patch":
      switch (command.args.type) {
        case "apply":
        case "validate":
        case "create":
          return true;
        default:
          return assertNever(command.args);
      }
    case "bundle":
      switch (command.args.type) {
        case "parse":
        case "create":
          return true;
        default:
          return assertNever(command.args);
      }
    case "tools":
      return false;
    case "plan-extract-batch":
      // Pure planning: the `threads` field is the budget to plan for, not a worker spawn, so it is
      // passed through untouched (no clamp/inject/force).
      return false;
    default:
      return assertNever(command);
  }
}

function normalizeRomWeaverPatchCommand(patchCommand: RomWeaverPatchCommand): RomWeaverCommand {
  if (!isObjectRecord(patchCommand) || Array.isArray(patchCommand)) {
    throw new TypeError("rom-weaver patch command requires an object `args` payload");
  }
  const patchType = assertKnownRomWeaverPatchCommandType(
    patchCommand.type,
    "rom-weaver patch command",
    "nested `type` field",
  );
  const patchArgs =
    isObjectRecord(patchCommand.args) && !Array.isArray(patchCommand.args) ? { ...patchCommand.args } : {};
  switch (patchType) {
    case "apply":
    case "validate":
    case "create":
      return {
        args: {
          args: patchArgs,
          type: patchType,
        },
        type: "patch",
      } as RomWeaverCommand;
    default:
      return assertNever(patchType);
  }
}

function normalizeRomWeaverBundleCommand(bundleCommand: RomWeaverBundleCommand): RomWeaverCommand {
  if (!isObjectRecord(bundleCommand) || Array.isArray(bundleCommand)) {
    throw new TypeError("rom-weaver bundle command requires an object `args` payload");
  }
  const bundleType = assertKnownRomWeaverBundleCommandType(
    bundleCommand.type,
    "rom-weaver bundle command",
    "nested `type` field",
  );
  const bundleArgs =
    isObjectRecord(bundleCommand.args) && !Array.isArray(bundleCommand.args) ? { ...bundleCommand.args } : {};
  switch (bundleType) {
    case "parse":
    case "create":
      return {
        args: {
          args: bundleArgs,
          type: bundleType,
        },
        type: "bundle",
      } as RomWeaverCommand;
    default:
      return assertNever(bundleType);
  }
}

function normalizeRomWeaverToolsCommand(toolsCommand: RomWeaverToolsCommand): RomWeaverCommand {
  if (!isObjectRecord(toolsCommand) || Array.isArray(toolsCommand)) {
    throw new TypeError("rom-weaver tools command requires an object `args` payload");
  }
  if (toolsCommand.type !== "ppf-undo") {
    throw new TypeError(`unsupported tools command: ${String(toolsCommand.type)}`);
  }
  const toolsArgs =
    isObjectRecord(toolsCommand.args) && !Array.isArray(toolsCommand.args) ? { ...toolsCommand.args } : {};
  return { args: { args: toolsArgs, type: "ppf-undo" }, type: "tools" } as RomWeaverCommand;
}

function readRomWeaverBundleCommandBranch(command: RomWeaverBundleCommand): RomWeaverBundleCommandBranch {
  switch (command.type) {
    case "parse":
      return { args: command.args, type: "bundle-parse" };
    case "create":
      return { args: command.args, type: "bundle-create" };
    default:
      return assertNever(command);
  }
}

function readRomWeaverToolsCommandBranch(command: RomWeaverToolsCommand): RomWeaverToolsCommandBranch {
  if (command.type === "ppf-undo") return { args: command.args, type: "tools-ppf-undo" };
  throw new TypeError(`unsupported tools command: ${String(command.type)}`);
}

function collectRomWeaverBundleInputPaths(paths: Set<string>, command: RomWeaverBundleCommand) {
  switch (command.type) {
    case "parse":
      pushPathValue(paths, command.args.input);
      return;
    case "create":
      pushPathValue(paths, command.args.rom);
      pushPathValues(paths, command.args.patch);
      return;
    default:
      assertNever(command);
  }
}

function readRomWeaverPatchCommandBranch(command: RomWeaverPatchCommand): RomWeaverPatchCommandBranch {
  switch (command.type) {
    case "apply":
      return { args: command.args, type: "patch-apply" };
    case "validate":
      return { args: command.args, type: "patch-validate" };
    case "create":
      return { args: command.args, type: "patch-create" };
    default:
      return assertNever(command);
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

function replaceRomWeaverCommandArgs(command: RomWeaverCommand, args: Record<string, unknown>): RomWeaverCommand {
  switch (command.type) {
    case "probe":
    case "extract":
    case "checksum":
    case "ingest":
    case "compress":
    case "trim":
    case "plan-extract-batch":
      return {
        ...command,
        args,
      } as RomWeaverCommand;
    case "patch":
    case "bundle":
    case "tools":
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

function assertNever(value: never): never {
  throw new Error(`Unhandled rom-weaver command shape: ${JSON.stringify(value)}`);
}
