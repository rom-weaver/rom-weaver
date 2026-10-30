// Case registry, process runner, assertions and reporting for the CLI apply matrix.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class Skip extends Error {}
export class Fail extends Error {}

const cases = [];
/**
 * Register a case. `id` is `<group>.<feature>.<name>`; `tags` are extra filter words;
 * `opts.knownBug` marks a case that currently fails because of a reported product bug
 * (expected-fail: an unexpected pass is flagged so the marker gets removed).
 */
export const add = (id, tags, fn, opts = {}) => cases.push({ id, tags, fn, ...opts });
export const allCases = () => cases;

export const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export const sameBytes = (a, b) => {
  const left = fs.readFileSync(a);
  const right = fs.readFileSync(b);
  return left.length === right.length && left.equals(right);
};

export const fail = (message) => {
  throw new Fail(message);
};
export const skip = (reason) => {
  throw new Skip(reason);
};
export const check = (condition, message) => {
  if (!condition) fail(typeof message === "function" ? message() : message);
};

const PANIC = /panicked at|thread '.*' panicked|RUST_BACKTRACE|stack overflow|SIGSEGV|assertion failed:/;

export class Ctx {
  constructor({ bin, work, id, fixtures, verbose }) {
    this.bin = bin;
    this.work = work;
    this.id = id;
    this.fixtures = fixtures;
    this.verbose = verbose;
    this.runs = [];
    this.notes = [];
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
  }

  /** Record an observation that is reported but does not fail the case. */
  note(message) {
    this.notes.push(message);
  }

  fx(name) {
    return this.fixtures.path(name);
  }
  bytes(name) {
    return fs.readFileSync(this.fx(name));
  }
  tmp(name) {
    const target = path.join(this.work, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return target;
  }
  write(name, data) {
    const target = this.tmp(name);
    fs.writeFileSync(target, data);
    return target;
  }
  exists(file) {
    return fs.existsSync(file);
  }

  /** Run the rom-weaver binary. Never throws; panics are recorded and fail the case at the end. */
  run(args, { env = {}, input, timeout = 180000, cwd, killSignal } = {}) {
    const started = Date.now();
    const childCwd = path.resolve(cwd ?? this.work);
    const result = spawnSync(this.bin, args, {
      encoding: "buffer",
      input,
      timeout,
      killSignal,
      cwd: childCwd,
      // The CLI derives its private temp root from $PWD, so it must match the child cwd.
      env: { ...process.env, NO_COLOR: "1", PWD: childCwd, ...env },
      maxBuffer: 256 * 1024 * 1024,
    });
    const stdout = result.stdout?.toString("utf8") ?? "";
    const stderr = result.stderr?.toString("utf8") ?? "";
    const out = {
      args,
      code: result.status,
      signal: result.signal,
      stdout,
      stderr,
      all: `${stdout}\n${stderr}`,
      ms: Date.now() - started,
      stdoutBytes: result.stdout,
      timedOut: result.error?.code === "ETIMEDOUT",
    };
    out.interrupted = Boolean(killSignal) && out.timedOut;
    out.panic = (Boolean(out.signal) && !out.interrupted) || out.code === 101 || PANIC.test(out.all);
    this.runs.push(out);
    if (this.verbose) console.error(`    $ rom-weaver ${args.join(" ")} -> ${out.code} (${out.ms} ms)`);
    return out;
  }

  /** Apply a patch chain: `apply(rom, [patch...], out, extra)` with --no-compress by default. */
  apply(rom, patches, output, extra = [], { compress = false, env } = {}) {
    const args = ["patch", "apply", "--input", rom];
    for (const patch of [].concat(patches)) args.push("--patch", patch);
    if (output) args.push("--output", output);
    if (!compress) args.push("--no-compress");
    return this.run([...args, ...extra], { env });
  }

  describe(result) {
    return `exit=${result.code}${result.signal ? ` signal=${result.signal}` : ""} :: ${result.all.trim().split("\n").slice(0, 4).join(" | ").slice(0, 400)}`;
  }

  ok(result, what = "command") {
    check(!result.timedOut, `${what} timed out`);
    check(result.code === 0, () => `${what} expected exit 0, got ${this.describe(result)}`);
    return result;
  }

  /** Expect a clean failure: exit code in `codes`, message matching `message`, no panic. */
  failed(result, { codes = [1, 2], message, what = "command" } = {}) {
    check(!result.timedOut, `${what} timed out`);
    check(!result.panic, () => `${what} panicked/crashed: ${this.describe(result)}`);
    check(codes.includes(result.code), () => `${what} expected exit ${codes.join("/")}, got ${this.describe(result)}`);
    if (message) check(message.test(result.all), () => `${what} message did not match ${message}: ${this.describe(result)}`);
    return result;
  }

  json(result) {
    const text = result.stdout.trim();
    try {
      return JSON.parse(text);
    } catch {
      const lines = text.split("\n").filter(Boolean);
      try {
        return JSON.parse(lines[lines.length - 1]);
      } catch {
        return fail(`stdout is not JSON: ${text.slice(0, 200)}`);
      }
    }
  }

  same(actual, expected, what = "output") {
    check(this.exists(actual), `${what} missing: ${actual}`);
    const left = fs.readFileSync(actual);
    const right = fs.readFileSync(expected);
    check(left.equals(right), () => {
      let first = -1;
      for (let index = 0; index < Math.min(left.length, right.length); index++)
        if (left[index] !== right[index]) {
          first = index;
          break;
        }
      return `${what} differs from expected (len ${left.length} vs ${right.length}, first diff @${first})`;
    });
  }

  finish() {
    const panicked = this.runs.find((run) => run.panic);
    if (panicked) fail(`panic/crash detected: rom-weaver ${panicked.args.join(" ")} :: ${this.describe(panicked)}`);
  }
}

const pad = (text, width) => String(text).padEnd(width);

export const runCases = async ({ selected, bin, workRoot, fixtures, verbose, strict, failFast }) => {
  const results = [];
  for (const entry of selected) {
    const work = path.join(workRoot, entry.id.replace(/[^\w.-]/g, "_"));
    const ctx = new Ctx({ bin, work, id: entry.id, fixtures, verbose });
    const started = Date.now();
    let status = "pass";
    let message = "";
    try {
      await entry.fn(ctx);
      ctx.finish();
    } catch (error) {
      if (error instanceof Skip) {
        status = "skip";
        message = error.message;
      } else if (error instanceof Fail) {
        status = "fail";
        message = error.message;
      } else {
        status = "fail";
        message = `harness error: ${error?.stack ?? error}`;
      }
    }
    if (entry.knownBug) {
      if (status === "fail") status = strict ? "fail" : "xfail";
      else if (status === "pass") {
        status = "fail";
        message = `unexpected pass of known-bug case (${entry.knownBug}); remove the marker`;
      }
      if (status === "xfail" || (status === "fail" && strict)) message = `[${entry.knownBug}] ${message}`;
    }
    results.push({ id: entry.id, status, message, ms: Date.now() - started, notes: ctx.notes });
    const tag = { pass: "PASS", fail: "FAIL", skip: "SKIP", xfail: "XFAIL" }[status];
    console.log(`${pad(tag, 6)} ${pad(entry.id, 64)} ${String(results.at(-1).ms).padStart(6)}ms${message ? `  ${message.split("\n")[0].slice(0, 180)}` : ""}`);
    if (status === "fail" && failFast) break;
    if (status === "pass" && !process.env.APPLY_MATRIX_KEEP) fs.rmSync(work, { recursive: true, force: true });
  }
  return results;
};

export const summarize = (results) => {
  const groups = new Map();
  for (const result of results) {
    const parts = result.id.split(".");
    const key = ["patch", "container", "output", "fuzz"].includes(parts[0]) ? parts.slice(0, 2).join(".") : parts[0];
    const group = groups.get(key) ?? { pass: 0, fail: 0, skip: 0, xfail: 0 };
    group[result.status]++;
    groups.set(key, group);
  }
  const lines = [`${pad("group", 34)} ${pad("pass", 6)} ${pad("fail", 6)} ${pad("xfail", 6)} skip`];
  const totals = { pass: 0, fail: 0, skip: 0, xfail: 0 };
  for (const [key, group] of [...groups].sort()) {
    lines.push(`${pad(key, 34)} ${pad(group.pass, 6)} ${pad(group.fail, 6)} ${pad(group.xfail, 6)} ${group.skip}`);
    for (const name of Object.keys(totals)) totals[name] += group[name];
  }
  lines.push(`${pad("TOTAL", 34)} ${pad(totals.pass, 6)} ${pad(totals.fail, 6)} ${pad(totals.xfail, 6)} ${totals.skip}`);
  return { text: lines.join("\n"), totals };
};

export const defaultCacheDir = () =>
  process.env.APPLY_MATRIX_CACHE || path.join(os.homedir(), ".cache", "agents", "apply-matrix-fixtures");
