#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_DIST_DIR = path.join(PACKAGE_ROOT, "packages", "rom-weaver-webapp", "dist");

export function preparePagesAssets(distDir = DEFAULT_DIST_DIR) {
  const cheatDir = path.join(distDir, "cheats");
  const manifest = JSON.parse(fs.readFileSync(path.join(cheatDir, "manifest.json"), "utf8"));
  const rawPaths = new Set();

  for (const system of Object.values(manifest.systems ?? {})) {
    const sourcePath = system && typeof system === "object" ? system.path : undefined;
    if (typeof sourcePath !== "string" || !sourcePath.startsWith("/cheats/")) {
      throw new Error(`Invalid cheat shard path in the manifest: ${String(sourcePath)}`);
    }
    const url = new URL(sourcePath, "https://rom-weaver.invalid");
    if (url.origin !== "https://rom-weaver.invalid") {
      throw new Error(`Invalid cheat shard path in the manifest: ${sourcePath}`);
    }
    const pathname = url.pathname;
    const name = pathname.startsWith("/cheats/") ? pathname.slice("/cheats/".length) : "";
    if (!name || name.includes("/") || !name.endsWith(".json")) {
      throw new Error(`Invalid cheat shard path in the manifest: ${String(system.path)}`);
    }
    const rawPath = path.join(cheatDir, name);
    const sidecarPath = `${rawPath}.br`;
    if (!fs.existsSync(rawPath) || !fs.existsSync(sidecarPath)) {
      throw new Error(`Cheat shard pair is incomplete: ${name}`);
    }
    rawPaths.add(rawPath);
  }

  const unexpected = fs
    .readdirSync(cheatDir)
    .filter((name) => name !== "manifest.json" && name.endsWith(".json"))
    .map((name) => path.join(cheatDir, name))
    .filter((rawPath) => !rawPaths.has(rawPath));
  if (unexpected.length > 0) {
    throw new Error(
      `Raw cheat shards are absent from the manifest: ${unexpected.map((entry) => path.basename(entry)).join(", ")}`,
    );
  }
  for (const rawPath of rawPaths) fs.rmSync(rawPath);
  return [...rawPaths].map((rawPath) => path.basename(rawPath));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const removed = preparePagesAssets(process.env.PAGES_DIST_DIR || undefined);
  process.stdout.write(
    `Prepared ${removed.length} Brotli-only cheat shards for Cloudflare Pages.\n`,
  );
}
