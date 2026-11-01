// Independent reference tools used to judge what the webapp writes (host binaries only; a missing tool
// turns the dependent assertion into a skip, never into a pass).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_ROOT = process.env.RW_MATRIX_SCRATCH || path.join(os.homedir(), ".cache/agents/scratch/exh-web");

const found = new Map();
export const have = (command) => {
  if (!found.has(command)) {
    const probe = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
    found.set(command, probe.status === 0 ? probe.stdout.trim() : null);
  }
  return found.get(command);
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 << 20, timeout: 300_000, ...options });
  return {
    ok: result.status === 0,
    out: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    status: result.status,
  };
};

export const withTempDir = (fn) => {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, "tool-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
};

const listFiles = (root) => {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push({ bytes: fs.readFileSync(full), name: path.relative(root, full) });
    }
  };
  walk(root);
  return files;
};

/** Extract a zip / 7z with host 7z (bsdtar as zip fallback). Returns { files } or { error }. */
export function extractWithHost(bytes, fileName) {
  return withTempDir((dir) => {
    const input = path.join(dir, `in${path.extname(fileName)}`);
    fs.writeFileSync(input, bytes);
    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    let result = have("7z") ? run("7z", ["x", "-y", `-o${out}`, input]) : { ok: false, out: "no 7z" };
    if (!result.ok && have("bsdtar")) result = run("bsdtar", ["-xf", input, "-C", out]);
    if (!result.ok) return { error: result.out.split("\n").slice(-3).join(" | "), files: [] };
    return { files: listFiles(out) };
  });
}

/** Integrity test with host 7z (`t`): returns null when fine, else the message. */
export function testWithHost(bytes, fileName) {
  if (!have("7z")) return "no 7z";
  return withTempDir((dir) => {
    const input = path.join(dir, `in${path.extname(fileName)}`);
    fs.writeFileSync(input, bytes);
    const result = run("7z", ["t", input]);
    return result.ok ? null : result.out.split("\n").slice(-3).join(" | ");
  });
}

/** Read the first zip entry's compression method (0 store, 8 deflate, 93 zstd, 14 lzma ...). */
export const zipMethods = (bytes) => {
  const methods = [];
  const view = Buffer.from(bytes);
  for (let at = 0; at + 30 <= view.length;) {
    if (view.readUInt32LE(at) !== 0x04034b50) break;
    const flags = view.readUInt16LE(at + 6);
    methods.push(view.readUInt16LE(at + 8));
    const name = view.readUInt16LE(at + 26);
    const extra = view.readUInt16LE(at + 28);
    let size = view.readUInt32LE(at + 18);
    if (flags & 8 || size === 0xffffffff) break; // streamed entries: only the first method is reliable
    at += 30 + name + extra + size;
  }
  return methods;
};

/** chdman verify + extract (raw) of a CHD; returns { ok, info, bytes? }. */
export function chdInspect(bytes, { dvd = false } = {}) {
  if (!have("chdman")) return null;
  return withTempDir((dir) => {
    const input = path.join(dir, "in.chd");
    fs.writeFileSync(input, bytes);
    const info = run("chdman", ["info", "-i", input, "-v"]);
    const verify = run("chdman", ["verify", "-i", input]);
    const raw = path.join(dir, "out.raw");
    const extracted = run("chdman", ["extractraw", "-i", input, "-o", raw]);
    return {
      bytes: extracted.ok && fs.existsSync(raw) ? fs.readFileSync(raw) : null,
      error: verify.ok
        ? extracted.ok
          ? ""
          : extracted.out.split("\n").slice(-2).join(" | ")
        : verify.out.split("\n").slice(-3).join(" | "),
      info: info.out,
      ok: verify.ok,
      dvd,
    };
  });
}

/**
 * Decode a CHD to its user data: CD-ROM CHDs go through extractcd and, for single MODE1 tracks, the
 * 2048-byte payload of every sector is returned; everything else uses extractraw.
 */
export function chdUserData(bytes) {
  if (!have("chdman")) return null;
  return withTempDir((dir) => {
    const input = path.join(dir, "in.chd");
    fs.writeFileSync(input, bytes);
    const verify = run("chdman", ["verify", "-i", input]);
    if (!verify.ok) return { error: `chdman verify: ${verify.out.split("\n").slice(-3).join(" | ")}`, ok: false };
    const cue = path.join(dir, "o.cue");
    const bin = path.join(dir, "o.bin");
    const cd = run("chdman", ["extractcd", "-i", input, "-o", cue, "-ob", bin]);
    if (cd.ok && fs.existsSync(bin)) {
      const sheet = fs.readFileSync(cue, "utf8");
      const raw = fs.readFileSync(bin);
      const modes = [...sheet.matchAll(/TRACK \d+ (\S+)/g)].map((match) => match[1]);
      if (modes.length === 1 && modes[0] === "MODE1/2352") {
        const sectors = Math.floor(raw.length / 2352);
        const out = Buffer.alloc(sectors * 2048);
        for (let i = 0; i < sectors; i++) raw.copy(out, i * 2048, i * 2352 + 16, i * 2352 + 16 + 2048);
        return { bytes: out, kind: "cd-mode1-2352", ok: true };
      }
      if (modes.length === 1 && modes[0] === "MODE1/2048") return { bytes: raw, kind: "cd-mode1-2048", ok: true };
      return { bytes: raw, kind: `cd-${modes.join("+")}`, ok: true };
    }
    const rawOut = path.join(dir, "o.raw");
    const ex = run("chdman", ["extractraw", "-i", input, "-o", rawOut]);
    return ex.ok
      ? { bytes: fs.readFileSync(rawOut), kind: "raw", ok: true }
      : { error: ex.out.split("\n").slice(-2).join(" | "), ok: false };
  });
}

/** dolphin-tool verify + convert back to ISO; returns { ok, bytes?, error }. */
export function rvzInspect(bytes) {
  if (!have("dolphin-tool")) return null;
  return withTempDir((dir) => {
    const input = path.join(dir, "in.rvz");
    fs.writeFileSync(input, bytes);
    const iso = path.join(dir, "out.iso");
    const converted = run("dolphin-tool", [
      "convert",
      "-u",
      path.join(dir, "user"),
      "-i",
      input,
      "-o",
      iso,
      "-f",
      "iso",
    ]);
    return {
      bytes: converted.ok && fs.existsSync(iso) ? fs.readFileSync(iso) : null,
      error: converted.ok ? "" : converted.out.split("\n").slice(-3).join(" | "),
      ok: converted.ok,
    };
  });
}

/** Apply a patch with a trusted external applier. kind: xdelta | flips (bps/ips/ups). */
export function applyWithReference(kind, source, patchBytes, patchName) {
  return withTempDir((dir) => {
    const src = path.join(dir, "src.bin");
    const patch = path.join(dir, `p${path.extname(patchName)}`);
    const out = path.join(dir, "out.bin");
    fs.writeFileSync(src, source);
    fs.writeFileSync(patch, patchBytes);
    let result;
    if (kind === "xdelta") {
      if (!have("xdelta3")) return null;
      result = run("xdelta3", ["-d", "-f", "-s", src, patch, out]);
    } else if (kind === "flips") {
      if (!have("flips")) return null;
      result = run("flips", ["--apply", patch, src, out]);
    } else return null;
    return result.ok && fs.existsSync(out)
      ? { bytes: fs.readFileSync(out), ok: true }
      : { error: result.out, ok: false };
  });
}
