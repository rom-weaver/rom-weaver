import { expect } from "vitest";
import { runBrowserFullFormatMatrixCore } from "../../src/wasm/browser-format-matrix.ts";
import { createRomWeaverCommand } from "../../src/wasm/rom-weaver-command.ts";
import { createBrowserWorkerClient } from "../../src/wasm/workers/browser-worker-client.ts";

const OPFS_GUEST_ROOT = "/work";
const TEXT_ENCODER = new TextEncoder();

const VCDIFF_SOURCE_FIXTURE_URL = new URL("../../../../tests/fixtures/vcdiff/secondary-source.bin", import.meta.url);
const VCDIFF_PATCH_FIXTURE_URL = new URL("../../../../tests/fixtures/vcdiff/secondary-djw.xdelta", import.meta.url);
const VCDIFF_TARGET_FIXTURE_URL = new URL("../../../../tests/fixtures/vcdiff/secondary-target.bin", import.meta.url);
const HDIFF_SOURCE_FIXTURE_URL = new URL(
  "../../../../crates/rom-weaver-patches/tests/fixtures/hdiffpatch/source.bin",
  import.meta.url,
);
const HDIFF_PATCH_FIXTURE_URL = new URL(
  "../../../../crates/rom-weaver-patches/tests/fixtures/hdiffpatch/upstream-hdiff13-zstd.hdiff",
  import.meta.url,
);
const HDIFF_TARGET_FIXTURE_URL = new URL(
  "../../../../crates/rom-weaver-patches/tests/fixtures/hdiffpatch/target.bin",
  import.meta.url,
);

let fixtureBytesPromise = null;

export function toTypedRunInput(input) {
  return Array.isArray(input) ? commandArgsToRunRequest(input) : input;
}

function wrapTypedTestWorker(worker) {
  return new Proxy(worker, {
    get(target, property, receiver) {
      if (property === "runJson") {
        return (input, options) => target.runJson(toTypedRunInput(input), options);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function withTempFixture(run, options = {}) {
  const {
    prefix = "rom-weaver-wasm-test-",
    sourceFileName = "input.bin",
    sourceContents = "rom-weaver wasm test fixture",
    clientOptions = {},
    initOptions = {},
  } = options;

  const root = await navigator.storage.getDirectory();
  const fixtureName = `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fixtureHandle = await root.getDirectoryHandle(fixtureName, { create: true });
  const worker = wrapTypedTestWorker(createBrowserWorkerClient(clientOptions));

  try {
    const init = await worker.init({
      opfsHandle: fixtureHandle,
      runtimeMounts: [OPFS_GUEST_ROOT],
      wasmUrl: new URL("../../src/wasm/rom-weaver-app.wasm", import.meta.url).href,
      workGuestPath: OPFS_GUEST_ROOT,
      ...initOptions,
    });
    expect(init.mode).toBe("browser-opfs");

    const sourcePath = joinGuestPath(OPFS_GUEST_ROOT, sourceFileName);
    await writeGuestFile(fixtureHandle, sourcePath, toBytes(sourceContents));

    const fixtures = await loadMatrixFixtures();
    const vcdiffSourcePath = joinGuestPath(OPFS_GUEST_ROOT, "fixtures", "secondary-source.bin");
    const vcdiffPatchPath = joinGuestPath(OPFS_GUEST_ROOT, "fixtures", "secondary-djw.xdelta");
    const vcdiffTargetPath = joinGuestPath(OPFS_GUEST_ROOT, "fixtures", "secondary-target.bin");
    const hdiffSourcePath = joinGuestPath(OPFS_GUEST_ROOT, "fixtures", "hdiff-source.bin");
    const hdiffPatchPath = joinGuestPath(OPFS_GUEST_ROOT, "fixtures", "upstream-hdiff13-zstd.hdiff");
    const hdiffTargetPath = joinGuestPath(OPFS_GUEST_ROOT, "fixtures", "hdiff-target.bin");
    await writeGuestFile(fixtureHandle, vcdiffSourcePath, fixtures.vcdiff.source);
    await writeGuestFile(fixtureHandle, vcdiffPatchPath, fixtures.vcdiff.patch);
    await writeGuestFile(fixtureHandle, vcdiffTargetPath, fixtures.vcdiff.target);
    await writeGuestFile(fixtureHandle, hdiffSourcePath, fixtures.hdiff.source);
    await writeGuestFile(fixtureHandle, hdiffPatchPath, fixtures.hdiff.patch);
    await writeGuestFile(fixtureHandle, hdiffTargetPath, fixtures.hdiff.target);

    await run({
      dir: OPFS_GUEST_ROOT,
      fixtures: {
        hdiffPatchPath,
        hdiffSourcePath,
        hdiffTargetPath,
        vcdiffPatchPath,
        vcdiffSourcePath,
        vcdiffTargetPath,
      },
      init,
      opfsHandle: fixtureHandle,
      sourcePath,
      workDir: OPFS_GUEST_ROOT,
      worker,
    });
  } finally {
    try {
      worker.terminate();
    } catch {
      // ignore best-effort cleanup failures
    }
    await removeFixtureDirectory(root, fixtureName);
  }
}

function getTerminalEvent(result) {
  const failureMessage = [
    `exitCode=${result?.exitCode}`,
    `ok=${result?.ok}`,
    `stdout=${JSON.stringify(result?.stdout ?? "")}`,
    `stderr=${JSON.stringify(result?.stderr ?? "")}`,
    `error=${JSON.stringify(errorMessage(result?.error))}`,
    `stack=${JSON.stringify(errorStack(result?.error))}`,
  ].join(" ");
  expect(Array.isArray(result.events), failureMessage).toBe(true);
  expect(result.events.length, failureMessage).toBeGreaterThan(0);
  return result.events.at(-1);
}

export function assertRunJsonSucceeded(result, options = {}) {
  const { command } = options;
  const terminal = getTerminalEvent(result);
  const failureMessage = [
    `expected ${command ?? "command"} to succeed`,
    `exitCode=${result.exitCode}`,
    `ok=${result.ok}`,
    `label=${JSON.stringify(terminal?.label ?? "")}`,
    `details=${JSON.stringify(terminal?.details ?? null)}`,
    `stderr=${JSON.stringify(result.stderr ?? "")}`,
    `error=${JSON.stringify(errorMessage(result.error))}`,
    `stack=${JSON.stringify(errorStack(result.error))}`,
  ].join(" ");
  expect(result.exitCode, failureMessage).toBe(0);
  expect(result.ok, failureMessage).toBe(true);
  expect(terminal.status).toBe("succeeded");
  if (typeof command === "string") {
    expect(terminal.command).toBe(command);
  }
  return terminal;
}

function commandArgsToRunRequest(args) {
  const { command, index: commandIndex, subcommand } = locateCommand(args);
  const parsed = parseCommandTokens(args, commandIndex);
  const output = {};
  if (parsed.flags.has("json")) output.json = true;
  if (parsed.flags.has("trace")) output.trace = true;
  if (parsed.flags.has("progress")) output.progress = true;
  if (parsed.flags.has("no-progress")) output.progress = false;

  const commandRequest = createCommandRequest(command, subcommand);
  const commandArgs = command === "patch" ? commandRequest.args.args : commandRequest.args;
  switch (command === "patch" ? `patch-${subcommand}` : command) {
    case "probe":
      Object.assign(commandArgs, {
        source: requirePositional(parsed, 0, "probe source"),
        ...(readOptionValues(parsed, "select").length ? { select: readOptionValues(parsed, "select") } : {}),
        ...(parsed.flags.has("rom-filter") ? { rom_filter: true } : {}),
        ...(parsed.flags.has("patch-filter") ? { patch_filter: true } : {}),
        ...(parsed.flags.has("no-extract") ? { no_extract: true } : {}),
        ...(parsed.flags.has("no-ignore") ? { no_ignore: true } : {}),
      });
      break;
    case "compress":
      Object.assign(commandArgs, {
        input: parsed.positionals,
        output: requireOptionValue(parsed, "output"),
        ...(readOptionalValue(parsed, "format") ? { format: readOptionalValue(parsed, "format") } : {}),
        ...(readOptionValues(parsed, "codec").length ? { codec: readOptionValues(parsed, "codec") } : {}),
        ...(readOptionalValue(parsed, "level") ? { level: readOptionalValue(parsed, "level") } : {}),
      });
      break;
    case "extract":
      Object.assign(commandArgs, {
        out_dir: requireOptionValue(parsed, "out-dir"),
        source: requirePositional(parsed, 0, "extract source"),
        ...(readOptionValues(parsed, "select").length ? { select: readOptionValues(parsed, "select") } : {}),
        ...(parsed.flags.has("rom-filter") ? { rom_filter: true } : {}),
        ...(parsed.flags.has("patch-filter") ? { patch_filter: true } : {}),
        ...(readOptionValues(parsed, "checksum").length ? { checksum: readOptionValues(parsed, "checksum") } : {}),
        ...(parsed.flags.has("split-bin") ? { split_bin: true } : {}),
        ...(parsed.flags.has("no-ignore") ? { no_ignore: true } : {}),
        ...(parsed.flags.has("no-nested-extract") ? { no_nested_extract: true } : {}),
        ...(parsed.flags.has("no-overwrite") ? { no_overwrite: true } : {}),
      });
      break;
    case "checksum":
      Object.assign(commandArgs, {
        algo: readOptionValues(parsed, "algo"),
        source: requirePositional(parsed, 0, "checksum source"),
        ...(readOptionValues(parsed, "select").length ? { select: readOptionValues(parsed, "select") } : {}),
        ...(parsed.flags.has("rom-filter") ? { rom_filter: true } : {}),
        ...(parsed.flags.has("patch-filter") ? { patch_filter: true } : {}),
        ...(parsed.flags.has("no-extract") ? { no_extract: true } : {}),
        ...(parsed.flags.has("no-ignore") ? { no_ignore: true } : {}),
        ...(parsed.flags.has("strip-header") ? { strip_header: true } : {}),
        ...(parsed.flags.has("no-trim-fix") ? { no_trim_fix: true } : {}),
        ...(readOptionalNumber(parsed, "start") === null ? {} : { start: readOptionalNumber(parsed, "start") }),
        ...(readOptionalNumber(parsed, "length") === null ? {} : { length: readOptionalNumber(parsed, "length") }),
      });
      break;
    case "patch-create":
      Object.assign(commandArgs, {
        format: requireOptionValue(parsed, "format"),
        modified: requireOptionValue(parsed, "modified"),
        original: requireOptionValue(parsed, "original"),
        output: requireOptionValue(parsed, "output"),
        ...(parsed.flags.has("ignore-checksum-validation") ? { ignore_checksum_validation: true } : {}),
        ...(readOptionalValue(parsed, "xdelta-secondary")
          ? { xdelta_secondary: readOptionalValue(parsed, "xdelta-secondary") }
          : {}),
      });
      break;
    case "patch-apply":
      Object.assign(commandArgs, {
        input: requireOptionValue(parsed, "input"),
        output: requireOptionValue(parsed, "output"),
        patches: readOptionValues(parsed, "patch"),
        ...(readOptionValues(parsed, "select").length ? { select: readOptionValues(parsed, "select") } : {}),
        ...(parsed.flags.has("rom-filter") ? { rom_filter: true } : {}),
        ...(parsed.flags.has("patch-filter") ? { patch_filter: true } : {}),
        ...(parsed.flags.has("no-extract") ? { no_extract: true } : {}),
        ...(parsed.flags.has("no-ignore") ? { no_ignore: true } : {}),
        ...(parsed.flags.has("no-compress") ? { no_compress: true } : {}),
        ...(readOptionalValue(parsed, "compress-format")
          ? { compress_format: readOptionalValue(parsed, "compress-format") }
          : {}),
        ...(readOptionValues(parsed, "compress-codec").length
          ? { compress_codec: readOptionValues(parsed, "compress-codec") }
          : {}),
        ...(readOptionalValue(parsed, "compress-level")
          ? { compress_level: readOptionalValue(parsed, "compress-level") }
          : {}),
        ...(readOptionValues(parsed, "checksum-cache").length
          ? { checksum_cache: readOptionValues(parsed, "checksum-cache") }
          : {}),
        ...(readOptionValues(parsed, "validate-with-checksum").length
          ? { validate_with_checksums: readOptionValues(parsed, "validate-with-checksum") }
          : {}),
        ...(readOptionValues(parsed, "patch-header").length
          ? { patch_header: readOptionValues(parsed, "patch-header") }
          : {}),
        ...(readOptionalValue(parsed, "output-header")
          ? { output_header: readOptionalValue(parsed, "output-header") }
          : {}),
        ...(parsed.flags.has("repair-checksum") ? { repair_checksum: true } : {}),
        ...(readOptionalValue(parsed, "n64-byte-order")
          ? { n64_byte_order: readOptionalValue(parsed, "n64-byte-order") }
          : {}),
        ...(parsed.flags.has("ignore-checksum-validation") ? { ignore_checksum_validation: true } : {}),
      });
      break;
    case "patch-validate":
      Object.assign(commandArgs, {
        input: requireOptionValue(parsed, "input"),
        patches: readOptionValues(parsed, "patch"),
        ...(readOptionValues(parsed, "select").length ? { select: readOptionValues(parsed, "select") } : {}),
        ...(parsed.flags.has("rom-filter") ? { rom_filter: true } : {}),
        ...(parsed.flags.has("patch-filter") ? { patch_filter: true } : {}),
        ...(parsed.flags.has("no-extract") ? { no_extract: true } : {}),
        ...(parsed.flags.has("no-ignore") ? { no_ignore: true } : {}),
        ...(readOptionValues(parsed, "checksum-cache").length
          ? { checksum_cache: readOptionValues(parsed, "checksum-cache") }
          : {}),
        ...(readOptionValues(parsed, "validate-with-checksum").length
          ? { validate_with_checksums: readOptionValues(parsed, "validate-with-checksum") }
          : {}),
        ...(readOptionalNumber(parsed, "validate-with-size") === null
          ? {}
          : { validate_with_size: readOptionalNumber(parsed, "validate-with-size") }),
        ...(readOptionalNumber(parsed, "validate-with-min-size") === null
          ? {}
          : { validate_with_min_size: readOptionalNumber(parsed, "validate-with-min-size") }),
        ...(parsed.flags.has("strip-header") ? { strip_header: true } : {}),
        ...(readOptionalValue(parsed, "n64-byte-order")
          ? { n64_byte_order: readOptionalValue(parsed, "n64-byte-order") }
          : {}),
        ...(parsed.flags.has("ignore-checksum-validation") ? { ignore_checksum_validation: true } : {}),
      });
      break;
    default:
      break;
  }

  const threads = readOptionalThreadBudget(parsed);
  if (threads !== null) commandArgs.threads = threads;

  return Object.keys(output).length > 0 ? { command: commandRequest, output } : commandRequest;
}

function locateCommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] ?? "")
      .trim()
      .toLowerCase();
    if (token === "patch-apply") return { command: "patch", index, subcommand: "apply" };
    if (token === "patch-create") return { command: "patch", index, subcommand: "create" };
    if (token === "patch-validate") return { command: "patch", index, subcommand: "validate" };
    if (token === "patch") {
      const subcommand = String(args[index + 1] ?? "")
        .trim()
        .toLowerCase();
      if (subcommand === "apply" || subcommand === "create" || subcommand === "validate") {
        return { command: "patch", index, subcommand };
      }
      return { command: "patch", index, subcommand: "" };
    }
    if (token === "probe" || token === "compress" || token === "extract" || token === "checksum") {
      return { command: token, index, subcommand: "" };
    }
  }
  return { command: String(args[0] ?? "").trim(), index: 0, subcommand: "" };
}

function createCommandRequest(command, subcommand) {
  if (command === "patch") {
    if (subcommand === "apply" || subcommand === "create" || subcommand === "validate") {
      return createRomWeaverCommand(`patch-${subcommand}`, {});
    }
    throw new Error(`unsupported patch subcommand in test args: ${subcommand || "(missing)"}`);
  }
  if (!["probe", "compress", "extract", "checksum"].includes(command)) {
    return { args: {}, type: command };
  }
  return createRomWeaverCommand(command, {});
}

function parseCommandTokens(args, commandIndex) {
  const flags = new Set();
  const options = new Map();
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    if (index === commandIndex) {
      if (
        String(args[index] ?? "")
          .trim()
          .toLowerCase() === "patch"
      )
        index += 1;
      continue;
    }
    const raw = String(args[index] ?? "");
    if (!raw.startsWith("--")) {
      if (index > commandIndex) positionals.push(raw);
      continue;
    }

    const withoutPrefix = raw.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    let value = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : null;
    if (
      value === null &&
      index > commandIndex &&
      index + 1 < args.length &&
      !String(args[index + 1] ?? "").startsWith("--")
    ) {
      value = String(args[index + 1]);
      index += 1;
    }
    if (value === null) {
      flags.add(name);
      continue;
    }
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  }

  return { flags, options, positionals };
}

function readOptionValues(parsed, name) {
  return parsed.options.get(name) ?? [];
}

function readOptionalValue(parsed, name) {
  return readOptionValues(parsed, name)[0] ?? null;
}

function readOptionalNumber(parsed, name) {
  const value = readOptionalValue(parsed, name);
  if (value === null) return null;
  const parsedNumber = Number.parseInt(value, 10);
  if (!Number.isFinite(parsedNumber) || parsedNumber < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsedNumber;
}

function readOptionalThreadBudget(parsed) {
  const value = readOptionalValue(parsed, "threads");
  if (value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "auto") return "auto";
  const parsedNumber = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsedNumber) || parsedNumber <= 0) {
    throw new Error("threads must be auto or a positive integer");
  }
  return parsedNumber;
}

function requireOptionValue(parsed, name) {
  const value = readOptionalValue(parsed, name);
  if (!value) throw new Error(`missing required --${name}`);
  return value;
}

function requirePositional(parsed, index, label) {
  const value = parsed.positionals[index];
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function errorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object" && typeof error.message === "string") return error.message;
  return String(error);
}

function errorStack(error) {
  if (error && typeof error === "object" && typeof error.stack === "string") return error.stack;
  return "";
}

export async function runProgressMatrix({ runJson, opfsHandle, dir, sourcePath, appliedOutputName }) {
  const archivePath = joinGuestPath(OPFS_GUEST_ROOT, "archive.zip");
  const sevenZSourcePath = joinGuestPath(dir, "seven-z-progress-source.bin");
  const sevenZArchivePath = joinGuestPath(OPFS_GUEST_ROOT, "archive-progress.7z");
  const extractDir = joinGuestPath(OPFS_GUEST_ROOT, "extract");
  const originalPath = joinGuestPath(dir, "original.bin");
  const modifiedPath = joinGuestPath(dir, "modified.bin");
  const patchPath = joinGuestPath(OPFS_GUEST_ROOT, "update.ips");
  const appliedPath = joinGuestPath(OPFS_GUEST_ROOT, appliedOutputName ?? "applied-output.bin");

  await writeGuestFile(opfsHandle, originalPath, toBytes("abcdefgh"));
  await writeGuestFile(opfsHandle, modifiedPath, toBytes("a1XYZf!!!"));
  const sevenZSource = new Uint8Array(1024 * 1024);
  for (let index = 0; index < sevenZSource.length; index += 1) {
    sevenZSource[index] = index % 251;
  }
  await writeGuestFile(opfsHandle, sevenZSourcePath, sevenZSource);

  const compressEvents = [];
  const compressResult = await runJson(
    ["compress", sourcePath, "--format", "zip", "--output", archivePath, "--threads", "1"],
    {
      onEvent(event) {
        compressEvents.push(event);
      },
    },
  );
  assertRunJsonSucceeded(compressResult, { command: "compress" });
  expect(
    compressEvents.some(
      (event) => event.command === "compress" && event.status === "running" && event.format === "zip",
    ),
  ).toBe(true);

  const sevenZCompressEvents = [];
  const sevenZCompressResult = await runJson(
    [
      "compress",
      sevenZSourcePath,
      "--format",
      "7z",
      "--codec",
      "lzma2",
      "--output",
      sevenZArchivePath,
      "--threads",
      "2",
    ],
    {
      onEvent(event) {
        sevenZCompressEvents.push(event);
      },
    },
  );
  assertRunJsonSucceeded(sevenZCompressResult, { command: "compress" });
  expect(
    sevenZCompressEvents.some(
      (event) =>
        event.command === "compress" &&
        event.status === "running" &&
        event.format === "7z" &&
        event.stage === "create" &&
        event.label === "queueing input for `7z`",
    ),
  ).toBe(false);
  expect(
    sevenZCompressEvents.some(
      (event) =>
        event.command === "compress" &&
        event.status === "running" &&
        event.format === "7z" &&
        event.stage === "create" &&
        event.label === "compressing `7z`" &&
        typeof event.percent === "number" &&
        event.percent > 0 &&
        event.percent < 100,
    ),
  ).toBe(true);
  expect(
    sevenZCompressEvents.some(
      (event) =>
        event.command === "compress" &&
        event.status === "running" &&
        event.format === "7z" &&
        event.stage === "write" &&
        event.percent === null &&
        Number(event.details?.compressedBytesWritten || 0) > 0,
    ),
  ).toBe(false);

  const extractEvents = [];
  const extractResult = await runJson(["extract", archivePath, "--out-dir", extractDir, "--threads", "1"], {
    onEvent(event) {
      extractEvents.push(event);
    },
  });
  assertRunJsonSucceeded(extractResult, { command: "extract" });
  expect(
    extractEvents.some((event) => event.command === "extract" && event.status === "running" && event.format === "zip"),
  ).toBe(true);

  const patchCreateResult = await runJson([
    "patch",
    "create",
    "--original",
    originalPath,
    "--modified",
    modifiedPath,
    "--format",
    "ips",
    "--output",
    patchPath,
    "--threads",
    "1",
  ]);
  assertRunJsonSucceeded(patchCreateResult, { command: "patch-create" });

  const patchApplyEvents = [];
  const patchApplyResult = await runJson(
    [
      "patch",
      "apply",
      "--input",
      originalPath,
      "--patch",
      patchPath,
      "--output",
      appliedPath,
      "--compress-format",
      "zip",
      "--threads",
      "1",
    ],
    {
      onEvent(event) {
        patchApplyEvents.push(event);
      },
    },
  );
  assertRunJsonSucceeded(patchApplyResult, { command: "patch-apply" });
  expect(
    patchApplyEvents.some(
      (event) => event.command === "patch-apply" && event.status === "running" && event.format === "IPS",
    ),
  ).toBe(true);
  expect(
    patchApplyEvents.some(
      (event) =>
        event.command === "patch-apply" &&
        event.status === "running" &&
        event.stage === "compress" &&
        typeof event.format === "string" &&
        event.format.length > 0,
    ),
  ).toBe(true);
}

export async function runPatchMatrix({ runJson, opfsHandle, dir, sourcePath, fixtures }) {
  const chdSourcePath = joinGuestPath(dir, "chd-source.bin");
  const chdPath = joinGuestPath(OPFS_GUEST_ROOT, "archive.chd");
  const chdExtractDir = joinGuestPath(OPFS_GUEST_ROOT, "chd-extract");
  const zipPath = joinGuestPath(OPFS_GUEST_ROOT, "archive.zip");
  const zipExtractDir = joinGuestPath(OPFS_GUEST_ROOT, "zip-extract");
  const sevenZPath = joinGuestPath(OPFS_GUEST_ROOT, "archive.7z");
  const sevenZLzma2Path = joinGuestPath(OPFS_GUEST_ROOT, "archive-lzma2.7z");
  const sevenZDefaultExtractDir = joinGuestPath(OPFS_GUEST_ROOT, "7z-default-extract");
  const sevenZLzma2ExtractDir = joinGuestPath(OPFS_GUEST_ROOT, "7z-lzma2-extract");
  const originalPath = joinGuestPath(dir, "original.bin");
  const modifiedPath = joinGuestPath(dir, "modified.bin");
  const ipsPath = joinGuestPath(OPFS_GUEST_ROOT, "update.ips");
  const upsPath = joinGuestPath(OPFS_GUEST_ROOT, "update.ups");
  const rupPath = joinGuestPath(OPFS_GUEST_ROOT, "update.rup");
  const bpsPath = joinGuestPath(OPFS_GUEST_ROOT, "update.bps");
  const appliedIpsPath = joinGuestPath(OPFS_GUEST_ROOT, "applied-ips.bin");
  const appliedBpsPath = joinGuestPath(OPFS_GUEST_ROOT, "applied-bps.bin");
  const appliedUpsPath = joinGuestPath(OPFS_GUEST_ROOT, "applied-ups.bin");
  const appliedRupPath = joinGuestPath(OPFS_GUEST_ROOT, "applied-rup.bin");
  const appliedXdeltaPath = joinGuestPath(OPFS_GUEST_ROOT, "applied-xdelta.bin");

  const chdSource = new Uint8Array(64 * 1024);
  for (let index = 0; index < chdSource.length; index += 1) {
    chdSource[index] = index % 251;
  }
  await writeGuestFile(opfsHandle, chdSourcePath, chdSource);
  await writeGuestFile(opfsHandle, originalPath, toBytes("abcdefgh"));
  await writeGuestFile(opfsHandle, modifiedPath, toBytes("a1XYZf!!!"));

  assertRunJsonSucceeded(
    await runJson(["compress", chdSourcePath, "--format", "chd", "--output", chdPath, "--threads", "1"]),
    { command: "compress" },
  );
  assertRunJsonSucceeded(await runJson(["probe", chdPath, "--no-extract"]), { command: "probe" });
  assertRunJsonSucceeded(await runJson(["extract", chdPath, "--out-dir", chdExtractDir, "--threads", "1"]), {
    command: "extract",
  });

  assertRunJsonSucceeded(
    await runJson(["compress", sourcePath, "--format", "zip", "--output", zipPath, "--threads", "1"]),
    { command: "compress" },
  );
  assertRunJsonSucceeded(await runJson(["probe", zipPath, "--no-extract"]), { command: "probe" });
  assertRunJsonSucceeded(await runJson(["extract", zipPath, "--out-dir", zipExtractDir, "--threads", "1"]), {
    command: "extract",
  });

  for (const [format, patchPath] of [
    ["ips", ipsPath],
    ["ups", upsPath],
    ["rup", rupPath],
    ["bps", bpsPath],
  ]) {
    assertRunJsonSucceeded(
      await runJson([
        "patch",
        "create",
        "--original",
        originalPath,
        "--modified",
        modifiedPath,
        "--format",
        format,
        "--output",
        patchPath,
        "--threads",
        "1",
      ]),
      { command: "patch-create" },
    );
  }

  for (const [patchPath, outputPath] of [
    [ipsPath, appliedIpsPath],
    [upsPath, appliedUpsPath],
    [bpsPath, appliedBpsPath],
    [rupPath, appliedRupPath],
  ]) {
    assertRunJsonSucceeded(
      await runPatchApplyNoCompress(runJson, {
        inputPath: originalPath,
        outputPath,
        patchPath,
      }),
      { command: "patch-apply" },
    );
  }

  assertRunJsonSucceeded(
    await runJson(["compress", sourcePath, "--format", "7z", "--output", sevenZPath, "--threads", "1"]),
    { command: "compress" },
  );
  assertRunJsonSucceeded(
    await runJson([
      "compress",
      sourcePath,
      "--format",
      "7z",
      "--output",
      sevenZLzma2Path,
      "--codec",
      "lzma2",
      "--threads",
      "1",
    ]),
    { command: "compress" },
  );

  assertRunJsonSucceeded(
    await runJson(["extract", sevenZPath, "--out-dir", sevenZDefaultExtractDir, "--threads", "1"]),
    { command: "extract" },
  );
  assertRunJsonSucceeded(
    await runJson(["extract", sevenZLzma2Path, "--out-dir", sevenZLzma2ExtractDir, "--threads", "1"]),
    { command: "extract" },
  );

  assertRunJsonSucceeded(
    await runPatchApplyNoCompress(runJson, {
      inputPath: fixtures.vcdiffSourcePath,
      outputPath: appliedXdeltaPath,
      patchPath: fixtures.vcdiffPatchPath,
    }),
    { command: "patch-apply" },
  );
}

export async function runFullFormatMatrix({ runJson, opfsHandle, dir, fixtures, profile }) {
  return runBrowserFullFormatMatrixCore({ dir, fixtures, opfsHandle, profile, runJson });
}

async function runPatchApplyNoCompress(runJson, { inputPath, patchPath, outputPath }, runOptions = undefined) {
  return runJson(
    [
      "patch",
      "apply",
      "--input",
      inputPath,
      "--patch",
      patchPath,
      "--output",
      outputPath,
      "--threads",
      "1",
      "--no-compress",
    ],
    runOptions,
  );
}

async function loadMatrixFixtures() {
  if (fixtureBytesPromise === null) {
    fixtureBytesPromise = Promise.all([
      fetchBytes(VCDIFF_SOURCE_FIXTURE_URL),
      fetchBytes(VCDIFF_PATCH_FIXTURE_URL),
      fetchBytes(VCDIFF_TARGET_FIXTURE_URL),
      fetchBytes(HDIFF_SOURCE_FIXTURE_URL),
      fetchBytes(HDIFF_PATCH_FIXTURE_URL),
      fetchBytes(HDIFF_TARGET_FIXTURE_URL),
    ]).then(([vcdiffSource, vcdiffPatch, vcdiffTarget, hdiffSource, hdiffPatch, hdiffTarget]) => ({
      hdiff: {
        patch: hdiffPatch,
        source: hdiffSource,
        target: hdiffTarget,
      },
      vcdiff: {
        patch: vcdiffPatch,
        source: vcdiffSource,
        target: vcdiffTarget,
      },
    }));
  }

  return fixtureBytesPromise;
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch fixture ${url}: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function toBytes(value) {
  if (typeof value === "string") {
    return TEXT_ENCODER.encode(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new TypeError("expected string, Uint8Array, or ArrayBuffer");
}

export function joinGuestPath(...parts) {
  const tokens = [];
  for (const part of parts) {
    const value = String(part);
    for (const token of value.split("/")) {
      if (token.length === 0) {
        continue;
      }
      tokens.push(token);
    }
  }
  return `/${tokens.join("/")}`;
}

function pathBasename(path) {
  const normalized = String(path).replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index < 0) {
    return normalized;
  }
  return normalized.slice(index + 1);
}

function pathDirname(path) {
  const normalized = String(path).replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}

function toGuestRelativePath(guestPath) {
  const normalized = String(guestPath);
  if (normalized === OPFS_GUEST_ROOT) {
    return "";
  }

  const prefix = `${OPFS_GUEST_ROOT}/`;
  if (!normalized.startsWith(prefix)) {
    throw new Error(`guest path must start with ${prefix}: ${guestPath}`);
  }

  return normalized.slice(prefix.length);
}

function splitRelativePath(relativePath) {
  if (relativePath.length === 0) {
    return [];
  }
  return relativePath.split("/").filter((token) => token.length > 0);
}

async function getOrCreateDirectoryHandle(rootHandle, relativeDirectoryPath) {
  const segments = splitRelativePath(relativeDirectoryPath);
  let current = rootHandle;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

async function getGuestFileHandle(rootHandle, guestPath, { create = false } = {}) {
  const relativePath = toGuestRelativePath(guestPath);
  const fileName = pathBasename(relativePath);
  const parentPath = pathDirname(relativePath);
  const parentHandle = await getOrCreateDirectoryHandle(rootHandle, parentPath === "/" ? "" : parentPath);
  return parentHandle.getFileHandle(fileName, { create });
}

export async function writeGuestFile(rootHandle, guestPath, contents) {
  const fileHandle = await getGuestFileHandle(rootHandle, guestPath, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(contents);
  await writable.close();
}

// Deterministic per-offset byte scramble (integer finalizer mix). Well-distributed with no long
// runs, so a mutated region built from it neither compresses nor matches any contiguous window of
// the un-mutated ramp - which is what forces a delta patch to carry the region as literals.
function scrambleByte(offset) {
  let x = (offset ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x & 0xff;
}

export async function writeGuestPatternFile(rootHandle, guestPath, byteLength, options = {}) {
  const { chunkSizeBytes = 1024 * 1024, phaseShift = 0, mutateFromOffset = null } = options;

  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new TypeError("byteLength must be a non-negative integer");
  }
  if (!Number.isInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new TypeError("chunkSizeBytes must be a positive integer");
  }
  if (!Number.isInteger(phaseShift)) {
    throw new TypeError("phaseShift must be an integer");
  }
  if (!(mutateFromOffset === null || (Number.isInteger(mutateFromOffset) && mutateFromOffset >= 0))) {
    throw new TypeError("mutateFromOffset must be null or a non-negative integer");
  }

  const fileHandle = await getGuestFileHandle(rootHandle, guestPath, { create: true });
  const writable = await fileHandle.createWritable();
  let writeError = null;

  try {
    const chunk = new Uint8Array(Math.max(1, Math.min(chunkSizeBytes, byteLength)));
    let offset = 0;

    while (offset < byteLength) {
      const size = Math.min(chunk.length, byteLength - offset);
      for (let index = 0; index < size; index += 1) {
        const absoluteOffset = offset + index;
        const inMutatedTail = mutateFromOffset !== null && absoluteOffset >= mutateFromOffset;
        chunk[index] = inMutatedTail ? scrambleByte(absoluteOffset) : (absoluteOffset + phaseShift) % 251;
      }
      await writable.write(chunk.subarray(0, size));
      offset += size;
    }
  } catch (error) {
    writeError = error;
    try {
      await writable.abort();
    } catch {
      // ignore abort failures; original error is more relevant
    }
    throw error;
  } finally {
    if (writeError === null) {
      await writable.close();
    }
  }
}

export async function writeGuestGeneratedFile(rootHandle, guestPath, byteLength, fillChunk, options = {}) {
  const { chunkSizeBytes = 1024 * 1024 } = options;
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new TypeError("byteLength must be a non-negative integer");
  }
  if (!Number.isInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new TypeError("chunkSizeBytes must be a positive integer");
  }
  if (typeof fillChunk !== "function") {
    throw new TypeError("fillChunk must be a function");
  }

  const fileHandle = await getGuestFileHandle(rootHandle, guestPath, { create: true });
  const writable = await fileHandle.createWritable();
  let writeError = null;

  try {
    const chunk = new Uint8Array(Math.max(1, Math.min(chunkSizeBytes, byteLength)));
    let offset = 0;
    while (offset < byteLength) {
      const size = Math.min(chunk.length, byteLength - offset);
      fillChunk(chunk.subarray(0, size), offset);
      await writable.write(chunk.subarray(0, size));
      offset += size;
    }
  } catch (error) {
    writeError = error;
    try {
      await writable.abort();
    } catch {
      // ignore abort failures; original error is more relevant
    }
    throw error;
  } finally {
    if (writeError === null) {
      await writable.close();
    }
  }
}

export async function getGuestFileSize(rootHandle, guestPath) {
  const fileHandle = await getGuestFileHandle(rootHandle, guestPath);
  const file = await fileHandle.getFile();
  return file.size;
}

async function removeFixtureDirectory(rootHandle, directoryName) {
  try {
    await rootHandle.removeEntry(directoryName, { recursive: true });
  } catch {
    // ignore best-effort cleanup failures
  }
}
