import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copy, files, inside, sha256 } from "./tree.mjs";

function sevenZip() {
  for (const command of ["7zz", "7z", "7za"]) {
    const probe = spawnSync(command, ["i"], { stdio: "ignore", timeout: 10000 });
    if (!probe.error && probe.status === 0) return { command, tar: false };
  }
  const probe = spawnSync("bsdtar", ["--version"], { stdio: "ignore", timeout: 10000 });
  if (!probe.error && probe.status === 0) return { command: "bsdtar", tar: true };
  throw new Error("LZMA SDK extraction requires 7zz, 7z, 7za, or bsdtar");
}

export async function sourceArchive(manifest, cache, offline) {
  mkdirSync(cache, { recursive: true });
  const archive = inside(
    cache,
    `${manifest.source.sha256}.${manifest.source.format === "tar" ? "tar.gz" : "7z"}`,
  );
  if (!existsSync(archive)) {
    if (offline)
      throw new Error(`${manifest.name}: source archive is not cached; run without --offline once`);
    const response = await fetch(manifest.source.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok)
      throw new Error(`${manifest.name}: download returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== manifest.source.sha256)
      throw new Error(`${manifest.name}: source SHA-256 mismatch`);
    const pending = `${archive}.${process.pid}.download`;
    writeFileSync(pending, bytes, { flag: "wx" });
    renameSync(pending, archive);
  }
  if (sha256(readFileSync(archive)) !== manifest.source.sha256)
    throw new Error(`${manifest.name}: cached source SHA-256 mismatch`);
  return archive;
}

export function extractSource(manifest, archive, work) {
  const extracted = join(work, "extracted");
  const pristine = join(work, "pristine");
  mkdirSync(extracted);
  mkdirSync(pristine);
  const tool = manifest.source.format === "tar" ? { command: "tar", tar: true } : sevenZip();
  if (tool.tar) {
    const names = execFileSync(tool.command, ["-tf", archive], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    for (const name of names.trim().split("\n")) inside(extracted, name, { allowRoot: true });
    const entries = execFileSync(tool.command, ["-tvf", archive], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (entries.split("\n").some((line) => /^[lh]/.test(line)))
      throw new Error(`${manifest.name}: archive links are unsupported`);
    execFileSync(tool.command, ["-xf", archive, "-C", extracted], { stdio: "pipe" });
  } else {
    execFileSync(tool.command, ["x", "-y", `-o${extracted}`, archive], { stdio: "pipe" });
  }
  files(extracted);
  const upstream = inside(extracted, manifest.source.root, { allowRoot: true });
  if (manifest.include) {
    for (const path of manifest.include) copy(inside(upstream, path), inside(pristine, path));
  } else {
    copy(upstream, pristine);
  }
  for (const entry of manifest.source.extraFiles ?? [])
    copy(inside(extracted, entry.from), inside(pristine, entry.to));
  for (const path of manifest.exclude ?? [])
    rmSync(inside(pristine, path), { recursive: true, force: true });
  return pristine;
}
