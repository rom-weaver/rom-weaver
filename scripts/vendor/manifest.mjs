import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inside } from "./tree.mjs";

export const DEPENDENCIES = ["chd-rs", "libarchive", "lzma-sdk", "nod", "xdvdfs"];
export const QUEUE_ROOT = "crates/rom-weaver-containers/vendor-patches";
const STAGES = new Set(["source", "integration", "build", "wasm", "arm64"]);

export function readManifest(root, name) {
  if (!DEPENDENCIES.includes(name)) throw new Error(`Unknown dependency: ${name}`);
  const directory = inside(root, `${QUEUE_ROOT}/${name}`);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || manifest.name !== name)
    throw new Error(`${name}: unsupported manifest version or name`);
  const source = manifest.source;
  if (
    !source ||
    !/^[a-f0-9]{64}$/.test(source.sha256) ||
    !source.revision ||
    !["tar", "7z"].includes(source.format)
  ) {
    throw new Error(`${name}: source requires a revision, SHA-256, and tar/7z format`);
  }
  if (new URL(source.url).protocol !== "https:")
    throw new Error(`${name}: source URL must use HTTPS`);
  inside(directory, source.root, { allowRoot: true });
  inside(root, manifest.destination);
  if (!manifest.destination.startsWith("crates/rom-weaver-containers/"))
    throw new Error(`${name}: destination must stay inside containers`);
  if (typeof manifest.materialized !== "boolean")
    throw new Error(`${name}: materialized must be boolean`);
  for (const field of ["include", "exclude", "preserve"]) {
    if (manifest[field] !== undefined && !Array.isArray(manifest[field]))
      throw new Error(`${name}: ${field} must be an array`);
    for (const path of manifest[field] ?? []) inside(directory, path);
  }
  for (const path of manifest.preserve ?? []) {
    if (!existsSync(inside(root, `${manifest.destination}/${path}`)))
      throw new Error(`${name}: preserved file is missing: ${path}`);
  }
  for (const entry of source.extraFiles ?? []) {
    inside(directory, entry.from);
    inside(directory, entry.to);
  }
  if (!Array.isArray(manifest.patches) || !manifest.patches.length)
    throw new Error(`${name}: patch queue is empty`);
  const seen = new Set();
  for (const patch of manifest.patches) {
    inside(directory, patch.file);
    if (seen.has(patch.file)) throw new Error(`${name}: duplicate patch ${patch.file}`);
    seen.add(patch.file);
    if (
      !STAGES.has(patch.stage) ||
      !patch.reason ||
      !patch.upstream?.status ||
      !Array.isArray(patch.tests) ||
      !patch.tests.length
    ) {
      throw new Error(
        `${name}: ${patch.file} needs a stage, reason, upstream status, and regression checks`,
      );
    }
    if (manifest.materialized && !["source", "integration"].includes(patch.stage))
      throw new Error(`${name}: materialized sources cannot contain target-specific patches`);
  }
  for (const adapter of manifest.adapters ?? []) {
    inside(root, `crates/rom-weaver-containers/${adapter.file}`);
    inside(directory, adapter.target);
    if (!["copy", "append"].includes(adapter.mode))
      throw new Error(`${name}: unsupported adapter mode ${adapter.mode}`);
  }
  return { ...manifest, directory };
}
