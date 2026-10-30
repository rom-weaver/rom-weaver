// Differential oracle: run the native CLI (if built) on the same inputs and compare outcomes.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliPath } from "../../fixtures/apply-matrix/generate.mjs";

/** Apply `patches` (paths) to `input` natively. Returns { ok, bytes?, stderr }. */
export function cliApply(input, patches, extraArgs = []) {
  const bin = cliPath();
  if (!bin) return { ok: null, stderr: "native CLI not built" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-matrix-cli-"));
  try {
    const out = path.join(dir, "out.bin");
    const args = [
      "patch",
      "apply",
      "--input",
      input,
      ...patches.flatMap((patch) => ["--patch", patch]),
      "--output",
      out,
      "--no-compress",
      "--force",
      "--no-progress",
      ...extraArgs,
    ];
    const result = spawnSync(bin, args, { encoding: "utf8", timeout: 120_000 });
    if (result.status === 0 && fs.existsSync(out))
      return { bytes: fs.readFileSync(out), ok: true, stderr: result.stderr };
    return { ok: false, stderr: `${result.stderr}${result.stdout}`.trim().split("\n").pop() };
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

/** Extract a produced artifact natively and return [{ name, bytes }] for every file inside. */
export function cliExtract(bytes, fileName) {
  const bin = cliPath();
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-matrix-ex-"));
  try {
    const input = path.join(dir, "in", fileName.replace(/[/\\]/g, "_"));
    fs.mkdirSync(path.dirname(input), { recursive: true });
    fs.writeFileSync(input, bytes);
    const outDir = path.join(dir, "out");
    const result = spawnSync(bin, ["extract", "--input", input, "--output", outDir, "--no-progress"], {
      encoding: "utf8",
      timeout: 120_000,
    });
    if (result.status !== 0) return { error: `${result.stderr}${result.stdout}`.trim().split("\n").pop(), files: [] };
    const files = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push({ bytes: fs.readFileSync(full), name: path.relative(outDir, full) });
      }
    };
    if (fs.existsSync(outDir)) walk(outDir);
    return { files };
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

/** Build a cheat patch natively (`patch create --code`), apply it, and return the patched ROM. */
export function cliPatchCreateFromCode(rom, code, dir) {
  const bin = cliPath();
  if (!bin) return null;
  const patch = path.join(dir, `cheat-${code}.ips`);
  const created = spawnSync(
    bin,
    ["patch", "create", "--original", rom, "--code", code, "--output", patch, "--force", "--no-progress"],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (created.status !== 0 || !fs.existsSync(patch))
    return { error: `${created.stderr}${created.stdout}`.trim().split("\n").pop() };
  const applied = cliApply(rom, [patch]);
  return applied.ok ? { bytes: applied.bytes } : { error: applied.stderr };
}
