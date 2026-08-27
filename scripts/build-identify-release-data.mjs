#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultInput = join(repoRoot, "crates", "rom-weaver-cli", "data", "identify", "v1");
const defaultOut = join(repoRoot, "target", "identify-release");
const defaultArchive = join(repoRoot, "target", "rom-weaver-identify-data.tar.zst");
const dataRelativeDir = join("share", "rom-weaver", "identify", "v1");

const parseArgs = (argv) => {
  const options = { archive: defaultArchive, input: defaultInput, out: defaultOut };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return resolve(next);
    };
    if (arg === "--archive") options.archive = value();
    else if (arg === "--input") options.input = value();
    else if (arg === "--out") options.out = value();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
};

const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

export const buildIdentifyReleaseData = (options) => {
  const input = resolve(options.input);
  const out = resolve(options.out);
  const archive = resolve(options.archive);
  const dataDir = join(out, dataRelativeDir);
  const packsDir = join(dataDir, "packs");
  const indexPath = join(input, "index.json");
  const catalogPath = join(input, "catalog.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  if (!Array.isArray(index.systems) || index.systems.length === 0) {
    throw new Error(`${indexPath} lists no identify systems`);
  }

  rmSync(out, { force: true, recursive: true });
  mkdirSync(packsDir, { recursive: true });
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  const systems = [...index.systems]
    .sort((left, right) => compare(left.slug, right.slug))
    .map((system) => {
      if (basename(system.file) !== system.file || basename(system.slug) !== system.slug) {
        throw new Error(`unsafe identify system path: ${system.file}`);
      }
      const inputPack = join(input, system.file);
      const zstdFile = `${system.slug}.pack.zst`;
      const outputPack = join(packsDir, zstdFile);
      if (statSync(inputPack).size !== system.rawBytes || sha256File(inputPack) !== system.sha256) {
        throw new Error(`${system.file} does not match index.json`);
      }
      run("zstd", [
        "--compress",
        "-19",
        "--threads=1",
        "--force",
        "--quiet",
        inputPack,
        "-o",
        outputPack,
      ]);
      return {
        ...system,
        zstdBytes: statSync(outputPack).size,
        zstdFile: `packs/${zstdFile}`,
        zstdSha256: sha256File(outputPack),
      };
    });

  copyFileSync(catalogPath, join(dataDir, "catalog.json"));
  writeFileSync(join(dataDir, "index.json"), `${JSON.stringify({ ...index, systems }, null, 2)}\n`);
  mkdirSync(dirname(archive), { recursive: true });
  const temporaryTar = `${archive}.tar`;
  rmSync(temporaryTar, { force: true });
  run("tar", [
    "--create",
    "--file",
    temporaryTar,
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--format=ustar",
    "--directory",
    out,
    "share",
  ]);
  run("zstd", [
    "--compress",
    "-19",
    "--threads=1",
    "--force",
    "--quiet",
    temporaryTar,
    "-o",
    archive,
  ]);
  rmSync(temporaryTar);
  return { archive, dataDir, sha256: sha256File(archive), systems: systems.length };
};

export const main = (argv = process.argv.slice(2)) => {
  const result = buildIdentifyReleaseData(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error.stack || error.message || error}`);
    process.exitCode = 1;
  }
}
