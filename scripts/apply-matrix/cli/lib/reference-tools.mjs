// Helpers for the reference-tool cases (dolphin-tool, xdelta3, flips, 7z, rar/unrar): tool probing, an
// isolated-HOME runner, deterministic byte generators and a small IPS record parser.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Fail, check, fail, skip } from "./harness.mjs";
import { have } from "./fixture-defs.mjs";

/** Skip the case, with the reason, when the reference tool is not on PATH. */
export const needTool = (...tools) => {
  // quality-reason: the case needs an optional host tool, build option or native CLI that is not present on every host; the skip message names it, and the same code paths are covered by Rust tests and the other matrix cases.
  for (const tool of tools) if (!have(tool)) skip(`${tool} not installed on this host`);
};

/**
 * Run a reference tool without a shell. HOME and XDG_* point into `home` so the tool never reads or writes the
 * real user configuration. Never throws; `ok` is true on exit 0.
 */
export const runTool = (cmd, args, { home, cwd, input, timeout = 300000, env = {} } = {}) => {
  const result = spawnSync(cmd, args, {
    encoding: "buffer",
    input,
    timeout,
    cwd,
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, ...(home ? { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"), XDG_CACHE_HOME: path.join(home, ".cache") } : {}), ...env },
  });
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr?.toString("utf8") ?? "";
  return {
    cmd,
    args,
    code: result.status,
    signal: result.signal,
    stdout,
    stderr,
    text: `${stdout.toString("utf8")}\n${stderr}`.trim(),
    ok: result.status === 0 && !result.error,
    timedOut: result.error?.code === "ETIMEDOUT",
  };
};

/** Context-bound tool runner: isolated HOME inside the case work dir, cwd defaults to the work dir. */
export const toolIn = (ctx) => (cmd, args, options = {}) => {
  const home = ctx.tmp("tool-home");
  fs.mkdirSync(home, { recursive: true });
  return runTool(cmd, args, { home, cwd: ctx.work, ...options });
};

export const describeTool = (result) => `${result.cmd} ${result.args.join(" ")} -> exit=${result.code}${result.signal ? ` signal=${result.signal}` : ""} :: ${result.text.split("\n").slice(0, 3).join(" | ").slice(0, 300)}`;

/** Fail the case when a reference tool that must succeed did not. */
export const toolMust = (result, what = result.cmd) => {
  if (result.timedOut) fail(`${what} timed out`);
  if (!result.ok) throw new Fail(`${what} failed: ${describeTool(result)}`);
  return result;
};

/**
 * The reference tool itself rejected an option combination (older build, unsupported feature). That is a limit of
 * the tool, not of rom-weaver, so the case is skipped with the tool's own message.
 */
export const toolOrSkip = (result, what) => {
  if (result.timedOut) fail(`${what} timed out`);
  // quality-reason: the case needs an optional host tool, build option or native CLI that is not present on every host; the skip message names it, and the same code paths are covered by Rust tests and the other matrix cases.
  if (!result.ok) skip(`${what}: reference tool cannot produce this variant (${describeTool(result)})`);
  return result;
};

export const prngBytes = (length, seed) => {
  let state = seed >>> 0 || 1;
  return Uint8Array.from({ length }, () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 255;
  });
};

/** All regular files below `dir`, as absolute paths (sorted). */
export const filesUnder = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
        .sort()
    : [];

/** Extract `input` with rom-weaver and return the single payload path. */
export const extractOne = (ctx, input, dirName = "ex", extra = []) => {
  const dir = ctx.tmp(dirName);
  ctx.ok(ctx.run(["extract", "--input", input, "--output", dir, ...extra]), `extract ${path.basename(input)}`);
  const files = filesUnder(dir);
  check(files.length === 1, () => `expected one extracted file from ${path.basename(input)}, got ${files.map((file) => path.relative(dir, file)).join(",") || "none"}`);
  return files[0];
};

/** Parse an IPS patch: records with RLE flag plus the optional 3-byte truncate extension. */
export const parseIps = (bytes) => {
  const records = [];
  check(Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "PATCH", "not an IPS patch");
  let at = 5;
  while (at + 3 <= bytes.length) {
    const offset = (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];
    if (offset === 0x454f46 && bytes.length - at === 3) return { records, truncate: null, eofAt: at };
    if (offset === 0x454f46 && bytes.length - at === 6) return { records, truncate: (bytes[at + 3] << 16) | (bytes[at + 4] << 8) | bytes[at + 5], eofAt: at };
    const size = (bytes[at + 3] << 8) | bytes[at + 4];
    if (size === 0) {
      records.push({ offset, rle: true, length: (bytes[at + 5] << 8) | bytes[at + 6], value: bytes[at + 7] });
      at += 8;
    } else {
      records.push({ offset, rle: false, length: size });
      at += 5 + size;
    }
  }
  return fail("IPS patch has no EOF marker");
};
