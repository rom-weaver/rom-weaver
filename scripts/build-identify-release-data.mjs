#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveIdentifyPackGroups } from "./identify-pack-groups.mjs";

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
  const indexPath = join(input, "index.json");
  const catalogPath = join(input, "catalog.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  if (!Array.isArray(index.systems) || index.systems.length === 0) {
    throw new Error(`${indexPath} lists no identify systems`);
  }

  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  const allSystems = [...index.systems]
    .sort((left, right) => compare(left.slug, right.slug))
    .map((system) => {
      if (basename(system.file) !== system.file || basename(system.slug) !== system.slug) {
        throw new Error(`unsafe identify system path: ${system.file}`);
      }
      const inputPack = join(input, system.file);
      const zstdFile = `${system.slug}.pack.zst`;
      if (statSync(inputPack).size !== system.rawBytes || sha256File(inputPack) !== system.sha256) {
        throw new Error(`${system.file} does not match index.json`);
      }
      return {
        ...system,
        zstdFile: `packs/${zstdFile}`,
      };
    });
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const resolvedGroups = resolveIdentifyPackGroups(index);
  const groups = resolvedGroups.groups.length
    ? resolvedGroups.groups
    : [
        {
          default: true,
          id: "default",
          label: "Built-in systems",
          systems: allSystems.map(({ slug }) => slug),
        },
      ];

  rmSync(out, { force: true, recursive: true });
  for (const name of readdirSync(dirname(archive))) {
    if (/^rom-weaver-identify-data-.+\.tar\.zst$/u.test(name)) {
      rmSync(join(dirname(archive), name), { force: true });
    }
  }
  const buildArchive = (group, archivePath, treeRoot) => {
    const dataDir = join(treeRoot, dataRelativeDir);
    const packsDir = join(dataDir, "packs");
    mkdirSync(packsDir, { recursive: true });
    const slugs = new Set(group.systems);
    const systems = allSystems
      .filter((system) => slugs.has(system.slug))
      .map((system) => {
        const inputPack = join(input, system.file);
        const outputPack = join(dataDir, system.zstdFile);
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
          zstdSha256: sha256File(outputPack),
        };
      });
    const archiveGroups = group.default ? groups : [group];
    const groupIndex = { ...index, groups: archiveGroups, systems };
    const groupCatalog = Array.isArray(catalog.platforms)
      ? {
          ...catalog,
          platforms: catalog.platforms.filter((platform) => slugs.has(platform.packSlug)),
        }
      : catalog;
    writeFileSync(join(dataDir, "catalog.json"), `${JSON.stringify(groupCatalog, null, 2)}\n`);
    writeFileSync(join(dataDir, "index.json"), `${JSON.stringify(groupIndex, null, 2)}\n`);
    mkdirSync(dirname(archivePath), { recursive: true });
    const temporaryTar = `${archivePath}.tar`;
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
      treeRoot,
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
      archivePath,
    ]);
    rmSync(temporaryTar);
    return {
      archive: archivePath,
      dataDir,
      group: group.id,
      sha256: sha256File(archivePath),
      systems: systems.length,
    };
  };

  const defaultGroups = groups.filter((group) => group.default);
  const defaultGroup = {
    default: true,
    id: "default",
    label: "Built-in systems",
    systems: [...new Set(defaultGroups.flatMap((group) => group.systems))].sort(compare),
  };
  const primary = buildArchive(defaultGroup, archive, out);
  const optional = groups
    .filter((group) => !group.default)
    .map((group) =>
      buildArchive(
        group,
        join(dirname(archive), `rom-weaver-identify-data-${group.id}.tar.zst`),
        join(out, `optional-${group.id}`),
      ),
    );
  return { ...primary, optional };
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
