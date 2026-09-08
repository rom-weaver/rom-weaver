#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { resolveIdentifyPackGroups } from "./identify-pack-groups.mjs";
import { brotliCompressFile } from "./wasm/brotli-compress.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultInput = join(repoRoot, "crates", "rom-weaver-cli", "data", "identify", "v1");
const defaultOut = join(repoRoot, "target", "identify-release");
const defaultArchive = join(repoRoot, "target", "rom-weaver-identify-data.tar.br");
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
  const archiveDir = dirname(archive);
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
      const inputBrotli = `${inputPack}.br`;
      const brotliFile = `${system.slug}.pack.br`;
      if (statSync(inputPack).size !== system.rawBytes || sha256File(inputPack) !== system.sha256) {
        throw new Error(`${system.file} does not match index.json`);
      }
      if (!existsSync(inputBrotli)) {
        throw new Error(
          `${inputBrotli} is missing; rebuild the identify data with Brotli sidecars`,
        );
      }
      const rawPack = readFileSync(inputPack);
      const compressedPack = readFileSync(inputBrotli);
      let decompressedPack;
      try {
        decompressedPack = brotliDecompressSync(compressedPack);
      } catch (error) {
        throw new Error(`${inputBrotli} is not valid Brotli: ${error.message}`);
      }
      if (!decompressedPack.equals(rawPack)) {
        throw new Error(`${inputBrotli} does not match ${system.file}`);
      }
      return {
        ...system,
        brotliFile: `packs/${brotliFile}`,
      };
    });
  // Cheat shards ride in the group that owns their platform's pack, so one
  // group install brings both. The release tree keeps only the Brotli copy.
  const verifyBrotliPair = (rawPath, brotliPath, label) => {
    if (!existsSync(brotliPath)) {
      throw new Error(`${brotliPath} is missing; rebuild the identify data with Brotli sidecars`);
    }
    let decompressed;
    try {
      decompressed = brotliDecompressSync(readFileSync(brotliPath));
    } catch (error) {
      throw new Error(`${brotliPath} is not valid Brotli: ${error.message}`);
    }
    if (!decompressed.equals(readFileSync(rawPath))) {
      throw new Error(`${brotliPath} does not match ${label}`);
    }
  };
  const allCheats = (Array.isArray(index.cheats) ? [...index.cheats] : [])
    .sort((left, right) => compare(left.slug, right.slug))
    .map((entry) => {
      if (basename(entry.file) !== entry.file || basename(entry.slug) !== entry.slug) {
        throw new Error(`unsafe identify cheat shard path: ${entry.file}`);
      }
      const inputShard = join(input, entry.file);
      if (statSync(inputShard).size !== entry.rawBytes || sha256File(inputShard) !== entry.sha256) {
        throw new Error(`${entry.file} does not match index.json`);
      }
      verifyBrotliPair(inputShard, `${inputShard}.br`, entry.file);
      return { ...entry, brotliFile: `cheats/${entry.slug}.json.br` };
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
  mkdirSync(archiveDir, { recursive: true });
  for (const name of readdirSync(archiveDir)) {
    if (/^rom-weaver-identify-data-.+\.tar\.br$/u.test(name)) {
      rmSync(join(archiveDir, name), { force: true });
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
        const inputBrotli = `${inputPack}.br`;
        const outputPack = join(dataDir, system.brotliFile);
        copyFileSync(inputBrotli, outputPack);
        const compressedBytes = statSync(outputPack).size;
        return {
          ...system,
          brotliBytes: compressedBytes,
          brotliSha256: sha256File(outputPack),
        };
      });
    const cheats = allCheats
      .filter((entry) => slugs.has(entry.slug))
      .map((entry) => {
        const outputShard = join(dataDir, entry.brotliFile);
        mkdirSync(dirname(outputShard), { recursive: true });
        copyFileSync(join(input, `${entry.file}.br`), outputShard);
        return {
          ...entry,
          brotliBytes: statSync(outputShard).size,
          brotliSha256: sha256File(outputShard),
        };
      });
    const archiveGroups = group.default ? groups : [group];
    // The checksum router is browser-only; a release archive never carries it.
    const { checksumRoutes: _checksumRoutes, ...indexWithoutRouter } = index;
    const groupIndex = { ...indexWithoutRouter, cheats, groups: archiveGroups, systems };
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
    brotliCompressFile({
      inputPath: temporaryTar,
      outputPath: archivePath,
      parameterProfile: "default",
      quality: 11,
    });
    rmSync(temporaryTar);
    return {
      archive: archivePath,
      cheats: cheats.length,
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
        join(archiveDir, `rom-weaver-identify-data-${group.id}.tar.br`),
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
