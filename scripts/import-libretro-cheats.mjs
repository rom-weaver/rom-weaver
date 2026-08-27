#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const SCHEMA_VERSION = 1;
const SOURCE_NAME = "libretro/libretro-database";
const SOURCE_URL = "https://github.com/libretro/libretro-database";
const SOURCE_LICENSE = "CC-BY-SA-4.0";
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_FILES_PER_SYSTEM = 20_000;
const MAX_RECORDS_PER_FILE = 20_000;
const MAX_FIELDS_PER_RECORD = 256;
const MAX_FIELD_BYTES = 256 * 1024;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEBAPP_ROOT = path.join(REPOSITORY_ROOT, "packages", "rom-weaver-webapp");

export const SYSTEMS = Object.freeze({
  nes: {
    directory: "Nintendo - Nintendo Entertainment System",
    datNames: ["Nintendo - Nintendo Entertainment System.dat"],
    label: "Nintendo Entertainment System",
  },
  snes: {
    directory: "Nintendo - Super Nintendo Entertainment System",
    datNames: ["Nintendo - Super Nintendo Entertainment System.dat"],
    label: "Super Nintendo Entertainment System",
  },
  genesis: {
    directory: "Sega - Mega Drive - Genesis",
    datNames: ["Sega - Mega Drive - Genesis.dat"],
    label: "Sega Genesis / Mega Drive",
  },
  gameboy: {
    directory: "Nintendo - Game Boy",
    datNames: ["Nintendo - Game Boy.dat"],
    label: "Game Boy",
  },
  gameboyadvance: {
    directory: "Nintendo - Game Boy Advance",
    datNames: ["Nintendo - Game Boy Advance.dat"],
    label: "Game Boy Advance",
  },
  "gameboy-color": {
    directory: "Nintendo - Game Boy Color",
    datNames: ["Nintendo - Game Boy Color.dat"],
    label: "Game Boy Color",
  },
});

const DEVICE_ANNOTATIONS = new Set([
  "action replay",
  "code breaker",
  "game genie",
  "gameshark",
  "hacks",
  "pro action replay",
  "rumbles",
]);

const isSourceAnnotation = (value) =>
  DEVICE_ANNOTATIONS.has(value.trim().toLowerCase()) || /^diff\d*$/iu.test(value.trim());

const REGION_WORDS = new Set([
  "asia",
  "australia",
  "brazil",
  "canada",
  "china",
  "europe",
  "finland",
  "france",
  "germany",
  "hong kong",
  "italy",
  "japan",
  "korea",
  "netherlands",
  "norway",
  "russia",
  "spain",
  "sweden",
  "taiwan",
  "uk",
  "usa",
  "world",
]);

const REVISION_PATTERN = /^(?:rev(?:ision)?\b|version\b|v\d|beta\b|proto\b|sample\b|demo\b)/i;

const fail = (message) => {
  throw new Error(message);
};

const byteLength = (value) => Buffer.byteLength(value, "utf8");

const checkBound = (value, maximum, label) => {
  const size = byteLength(value);
  if (size > maximum) fail(`${label} is ${size} bytes. The limit is ${maximum} bytes.`);
};

const decodeQuotedValue = (input, label) => {
  let result = "";
  let closed = false;
  let warning = null;
  for (let index = 1; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      closed = true;
      break;
    }
    if (character !== "\\") {
      result += character;
      continue;
    }
    index += 1;
    if (index >= input.length) {
      result += "\\";
      warning = `${label} ends with an incomplete escape.`;
      break;
    }
    const escaped = input[index];
    if (escaped === "n") result += "\n";
    else if (escaped === "r") result += "\r";
    else if (escaped === "t") result += "\t";
    else if (escaped === '"' || escaped === "\\") result += escaped;
    else result += `\\${escaped}`;
  }
  if (!closed) warning ??= `${label} has an unterminated quoted value.`;
  return { value: result, warning };
};

const parseValue = (input, label) => {
  const value = input.trim();
  if (!value.startsWith('"')) return { value, warning: null };
  return decodeQuotedValue(value, label);
};

export function parseCht(source, options = {}) {
  const sourceFile = options.sourceFile ?? "fixture.cht";
  const sourceRevision = options.sourceRevision ?? "fixture";
  checkBound(source, options.maxFileBytes ?? MAX_FILE_BYTES, sourceFile);
  const records = new Map();
  const warnings = new Map();
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/u);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    checkBound(line, MAX_LINE_BYTES, `${sourceFile}:${lineIndex + 1}`);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    const match = /^cheat(\d+)_(.+)$/u.exec(key);
    if (!match) continue;
    const sourceIndex = Number(match[1]);
    if (!Number.isSafeInteger(sourceIndex))
      fail(`${sourceFile}:${lineIndex + 1} has an invalid cheat index.`);
    if (!records.has(sourceIndex)) {
      if (records.size >= (options.maxRecords ?? MAX_RECORDS_PER_FILE)) {
        fail(
          `${sourceFile} has more than ${options.maxRecords ?? MAX_RECORDS_PER_FILE} cheat records.`,
        );
      }
      records.set(sourceIndex, new Map());
    }
    const fieldName = match[2];
    const fields = records.get(sourceIndex);
    if (!fields.has(fieldName) && fields.size >= MAX_FIELDS_PER_RECORD) {
      fail(`${sourceFile}:cheat${sourceIndex} has more than ${MAX_FIELDS_PER_RECORD} fields.`);
    }
    const parsedValue = parseValue(line.slice(equals + 1), `${sourceFile}:${lineIndex + 1}`);
    const fieldValue = parsedValue.value;
    if (parsedValue.warning) {
      if (!warnings.has(sourceIndex)) warnings.set(sourceIndex, []);
      warnings.get(sourceIndex).push(parsedValue.warning);
    }
    checkBound(fieldValue, MAX_FIELD_BYTES, `${sourceFile}:cheat${sourceIndex}_${fieldName}`);
    fields.set(fieldName, fieldValue);
  }

  return [...records.entries()]
    .sort(([left], [right]) => left - right)
    .map(([sourceIndex, fields]) => ({
      description: fields.get("desc") ?? `Cheat ${sourceIndex + 1}`,
      rawCode: fields.has("code") ? fields.get("code") : null,
      rawFields: Object.fromEntries(fields),
      sourceFile,
      sourceIndex,
      sourceRevision,
      ...(warnings.has(sourceIndex) ? { importWarnings: warnings.get(sourceIndex) } : {}),
    }));
}

const unescapeDatString = (value) => value.replace(/\\([\\"])/gu, "$1");

const extractDatBlocks = (source, blockName) => {
  const blocks = [];
  const pattern = new RegExp(`\\b${blockName}\\s*\\(`, "giu");
  while (pattern.exec(source) !== null) {
    const start = pattern.lastIndex;
    let depth = 1;
    let quoted = false;
    let escaped = false;
    let index = start;
    for (; index < source.length && depth > 0; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quoted && character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    if (depth !== 0) fail(`The DAT contains an unterminated ${blockName} block.`);
    blocks.push(source.slice(start, index - 1));
    pattern.lastIndex = index;
  }
  return blocks;
};

const datAttribute = (block, name) => {
  const match = new RegExp(`(?:^|\\n)\\s*${name}\\s+"((?:\\\\.|[^"])*)"`, "iu").exec(block);
  return match ? unescapeDatString(match[1]) : null;
};

const datRomAttribute = (block, name) => {
  const match = new RegExp(`(?:^|\\s)${name}\\s+(?:"((?:\\\\.|[^"])*)"|([^\\s]+))`, "iu").exec(
    block,
  );
  return match ? unescapeDatString(match[1] ?? match[2]) : null;
};

export function parseDat(source, sourceFile = "fixture.dat") {
  checkBound(source, 64 * 1024 * 1024, sourceFile);
  const releases = [];
  for (const gameBlock of extractDatBlocks(source, "game")) {
    const name = datAttribute(gameBlock, "name") ?? datAttribute(gameBlock, "description");
    if (!name) continue;
    const region = datAttribute(gameBlock, "region");
    const roms = extractDatBlocks(gameBlock, "rom");
    for (const romBlock of roms) {
      const romName = datRomAttribute(romBlock, "name");
      const sizeText = datRomAttribute(romBlock, "size");
      const checksum = {
        crc32: datRomAttribute(romBlock, "crc")?.toLowerCase() ?? null,
        md5: datRomAttribute(romBlock, "md5")?.toLowerCase() ?? null,
        name: romName,
        sha1: datRomAttribute(romBlock, "sha1")?.toLowerCase() ?? null,
        size: sizeText && /^\d+$/u.test(sizeText) ? Number(sizeText) : null,
      };
      if (!checksum.crc32 && !checksum.md5 && !checksum.sha1) continue;
      releases.push({ name, region, checksum, sourceFile });
    }
  }
  return releases;
}

const stripExtension = (name) => name.replace(/\.(?:bin|cht|gb|gbc|gen|md|nes|sfc|smc)$/iu, "");

const stripDeviceAnnotation = (name) => {
  let result = name.trim();
  while (true) {
    const match = /\s+\(([^()]*)\)\s*$/u.exec(result);
    if (!match || !isSourceAnnotation(match[1])) return result;
    result = result.slice(0, match.index).trim();
  }
};

const codeKindForTitle = (title, system) => {
  const annotations = [...title.matchAll(/\(([^()]*)\)/gu)].map((match) =>
    match[1].trim().toLowerCase(),
  );
  if (annotations.includes("game genie")) return "game-genie";
  if (
    system === "gameboyadvance" &&
    annotations.some((annotation) =>
      ["action replay", "code breaker", "gameshark", "pro action replay", "xploder", "xplorer"].includes(
        annotation,
      ),
    )
  ) {
    return "xploder";
  }
  if (
    annotations.some((annotation) =>
      ["action replay", "gameshark", "pro action replay"].includes(annotation),
    )
  ) {
    return "pro-action-replay";
  }
  return null;
};

export const normalizeReleaseName = (name) =>
  stripDeviceAnnotation(stripExtension(name))
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[’‘]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();

const titleMetadata = (title, datRegion) => {
  const annotations = [...title.matchAll(/\(([^()]*)\)/gu)].map((match) => match[1].trim());
  const regions = new Set();
  if (datRegion) regions.add(datRegion);
  for (const annotation of annotations) {
    const parts = annotation.split(",").map((part) => part.trim());
    if (parts.length > 0 && parts.every((part) => REGION_WORDS.has(part.toLowerCase()))) {
      for (const part of parts) regions.add(part);
    }
  }
  const revisions = annotations.filter((annotation) => REVISION_PATTERN.test(annotation));
  const displayTitle = title.replace(
    /\s+\([^()]*(?:game genie|gameshark|action replay|code breaker|rumbles|hacks)[^()]*\)\s*$/iu,
    "",
  );
  return {
    regions: [...regions].sort(),
    revisions: [...new Set(revisions)].sort(),
    title: displayTitle,
  };
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const stableId = (prefix, value) =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

export const stableGameId = (system, normalizedTitle) =>
  stableId("game", `${system}\0${normalizedTitle}`);

export const stableCheatId = (system, gameId, record) => {
  const identityFields = Object.fromEntries(
    Object.entries(record.rawFields).filter(([key]) => key !== "enable"),
  );
  return stableId(
    "cheat",
    `${system}\0${gameId}\0${record.codeKind ?? ""}\0${canonicalJson(identityFields)}`,
  );
};

const listChtFiles = (directory) => {
  const files = [];
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    );
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink())
        fail(`Symbolic links are not allowed in the cheat source: ${entryPath}`);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cht")) files.push(entryPath);
      if (files.length > MAX_FILES_PER_SYSTEM) {
        fail(`${directory} has more than ${MAX_FILES_PER_SYSTEM} .cht files.`);
      }
    }
  };
  visit(directory);
  return files;
};

const readBoundedFile = (file, maximum = MAX_FILE_BYTES) => {
  const stats = statSync(file);
  if (stats.size > maximum) fail(`${file} is ${stats.size} bytes. The limit is ${maximum} bytes.`);
  return readFileSync(file, "utf8");
};

const relativeSourcePath = (sourceDir, file) => {
  const relative = path.relative(sourceDir, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`The source file is outside the source directory: ${file}`);
  }
  return relative.split(path.sep).join("/");
};

const findDatFiles = (sourceDir, names) => {
  const roots = [path.join(sourceDir, "metadat", "no-intro"), path.join(sourceDir, "dat")];
  const files = [];
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      try {
        if (lstatSync(candidate).isFile()) files.push(candidate);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return files;
};

const releaseIndexForSystem = (sourceDir, spec) => {
  const releases = new Map();
  for (const file of findDatFiles(sourceDir, spec.datNames)) {
    const sourceFile = relativeSourcePath(sourceDir, file);
    for (const release of parseDat(readBoundedFile(file, 64 * 1024 * 1024), sourceFile)) {
      const key = normalizeReleaseName(release.name);
      if (!releases.has(key)) releases.set(key, []);
      releases.get(key).push(release);
    }
  }
  return releases;
};

const checksumKey = (checksum) => canonicalJson(checksum);

export function buildSystemShard({ sourceDir, sourceRevision, system }) {
  const spec = SYSTEMS[system];
  if (!spec) fail(`Unsupported system '${system}'.`);
  const systemDirectory = path.join(sourceDir, "cht", spec.directory);
  const releaseIndex = releaseIndexForSystem(sourceDir, spec);
  const games = new Map();

  for (const file of listChtFiles(systemDirectory)) {
    const sourceFile = relativeSourcePath(sourceDir, file);
    const sourceTitle = stripExtension(path.basename(file));
    const codeKind = codeKindForTitle(sourceTitle, system);
    const normalizedTitle = normalizeReleaseName(sourceTitle);
    const releases = releaseIndex.get(normalizedTitle) ?? [];
    const canonicalTitle = releases[0]?.name ?? stripDeviceAnnotation(sourceTitle);
    const gameId = stableGameId(system, normalizedTitle);
    if (!games.has(gameId)) {
      const metadata = titleMetadata(canonicalTitle, releases[0]?.region);
      games.set(gameId, {
        cheats: new Map(),
        checksums: new Map(),
        id: gameId,
        normalizedTitle,
        regions: new Set(metadata.regions),
        revisions: new Set(metadata.revisions),
        sourceFiles: new Set(),
        title: metadata.title,
      });
    }
    const game = games.get(gameId);
    game.sourceFiles.add(sourceFile);
    for (const release of releases) {
      if (release.region) game.regions.add(release.region);
      const metadata = titleMetadata(release.name, release.region);
      for (const region of metadata.regions) game.regions.add(region);
      for (const revision of metadata.revisions) game.revisions.add(revision);
      game.checksums.set(checksumKey(release.checksum), release.checksum);
    }

    for (const parsed of parseCht(readBoundedFile(file), { sourceFile, sourceRevision })) {
      const record = { ...parsed, gameId, system, ...(codeKind ? { codeKind } : {}) };
      record.id = stableCheatId(system, gameId, record);
      if (!game.cheats.has(record.id)) game.cheats.set(record.id, record);
    }
  }

  const serializedGames = [...games.values()]
    .map((game) => ({
      checksums: [...game.checksums.values()].sort((left, right) =>
        checksumKey(left).localeCompare(checksumKey(right)),
      ),
      cheats: [...game.cheats.values()].sort(
        (left, right) =>
          left.sourceFile.localeCompare(right.sourceFile, "en") ||
          left.sourceIndex - right.sourceIndex,
      ),
      id: game.id,
      normalizedTitle: game.normalizedTitle,
      regions: [...game.regions].sort(),
      revisions: [...game.revisions].sort(),
      sourceFiles: [...game.sourceFiles].sort(),
      title: game.title,
    }))
    .sort(
      (left, right) =>
        left.normalizedTitle.localeCompare(right.normalizedTitle, "en") ||
        left.id.localeCompare(right.id),
    );

  return { schemaVersion: SCHEMA_VERSION, system, games: serializedGames };
}

const encodeJson = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

const formatJsonFiles = (files) => {
  const formatter = [
    path.join(REPOSITORY_ROOT, "node_modules", "oxfmt", "bin", "oxfmt"),
    path.join(WEBAPP_ROOT, "node_modules", "oxfmt", "bin", "oxfmt"),
  ].find((candidate) => existsSync(candidate));
  if (!formatter) fail("oxfmt is not installed. Run npm ci before importing cheat data.");
  execFileSync(process.execPath, [formatter, ...files, "--write"], {
    cwd: WEBAPP_ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
};

const compressShard = (source) =>
  brotliCompressSync(source, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.length,
    },
  });

const attributionSource = (sourceRevision) => `# Libretro Database cheat data

ROMWeaver includes normalized cheat data from the Libretro Database.

- Source: ${SOURCE_NAME}
- Source repository: [libretro/libretro-database](${SOURCE_URL})
- Source revision: ${sourceRevision}
- Data license: Creative Commons Attribution-ShareAlike 4.0 International
- License identifier: ${SOURCE_LICENSE}

The JSON shards and their Brotli copies are adaptations of the upstream data. ROMWeaver distributes these data files under CC-BY-SA-4.0. ROMWeaver's software license does not replace or override the data license.

If you share an adapted database, ShareAlike requires the same or a compatible license. Keep the attribution, the source revision, and a notice that you changed the data. See the included \`LICENSE\` file for the complete terms.

ROMWeaver code reads these files, but the code remains separate from this third-party data component.
`;

const validateRevision = (revision) => {
  if (!/^[0-9a-f]{7,64}$/iu.test(revision)) {
    fail("--source-revision must be a 7 to 64 character hexadecimal revision.");
  }
  return revision.toLowerCase();
};

export function importLibretroCheats({
  sourceDir,
  sourceRevision,
  outputDir,
  systems = Object.keys(SYSTEMS),
}) {
  if (!sourceDir) fail("--source-dir is required.");
  if (!sourceRevision) fail("--source-revision is required.");
  const resolvedSourceDir = path.resolve(sourceDir);
  const resolvedOutputDir = path.resolve(outputDir);
  if (!statSync(resolvedSourceDir).isDirectory())
    fail(`The source directory does not exist: ${resolvedSourceDir}`);
  if (resolvedOutputDir === resolvedSourceDir)
    fail("The output directory must differ from the source directory.");
  const revision = validateRevision(sourceRevision);
  const uniqueSystems = [...new Set(systems)];
  for (const system of uniqueSystems) if (!SYSTEMS[system]) fail(`Unsupported system '${system}'.`);

  mkdirSync(resolvedOutputDir, { recursive: true });
  for (const filename of [
    "ATTRIBUTION.md",
    "LICENSE",
    "manifest.json",
    ...Object.keys(SYSTEMS).flatMap((system) => [`${system}.json`, `${system}.json.br`]),
  ]) {
    rmSync(path.join(resolvedOutputDir, filename), { force: true });
  }
  const upstreamLicense = readBoundedFile(path.join(resolvedSourceDir, "LICENSE"), 1024 * 1024);
  writeFileSync(path.join(resolvedOutputDir, "LICENSE"), upstreamLicense);
  writeFileSync(path.join(resolvedOutputDir, "ATTRIBUTION.md"), attributionSource(revision));
  const manifestSystems = {};
  const pendingShards = [];
  for (const system of uniqueSystems.sort()) {
    const shard = buildSystemShard({
      sourceDir: resolvedSourceDir,
      sourceRevision: revision,
      system,
    });
    const filename = `${system}.json`;
    const outputPath = path.join(resolvedOutputDir, filename);
    writeFileSync(outputPath, encodeJson(shard));
    pendingShards.push({ filename, outputPath, shard, system });
  }
  formatJsonFiles(pendingShards.map(({ outputPath }) => outputPath));
  for (const { filename, outputPath, shard, system } of pendingShards) {
    const raw = readFileSync(outputPath);
    const compressed = compressShard(raw);
    writeFileSync(`${outputPath}.br`, compressed);
    manifestSystems[system] = {
      cheats: shard.games.reduce((total, game) => total + game.cheats.length, 0),
      compressedBytes: compressed.length,
      compressedPath: `/cheats/${filename}.br?revision=${revision}`,
      games: shard.games.length,
      label: SYSTEMS[system].label,
      path: `/cheats/${filename}?revision=${revision}`,
      rawBytes: raw.length,
    };
  }

  const manifest = {
    attributionPath: "/cheats/ATTRIBUTION.md",
    license: SOURCE_LICENSE,
    licensePath: "/cheats/LICENSE",
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE_NAME,
    sourceRevision: revision,
    sourceUrl: SOURCE_URL,
    systems: manifestSystems,
  };
  const manifestPath = path.join(resolvedOutputDir, "manifest.json");
  writeFileSync(manifestPath, encodeJson(manifest));
  formatJsonFiles([manifestPath]);
  return manifest;
}

const parseArguments = (argv) => {
  const options = { systems: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--source-dir") options.sourceDir = argv[++index];
    else if (argument === "--source-revision") options.sourceRevision = argv[++index];
    else if (argument === "--output-dir") options.outputDir = argv[++index];
    else if (argument === "--system") options.systems.push(argv[++index]);
    else fail(`Unknown argument '${argument}'.`);
  }
  if (!options.sourceDir) fail("--source-dir is required.");
  if (!options.sourceRevision) fail("--source-revision is required.");
  options.outputDir ??= path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../packages/rom-weaver-webapp/public/cheats",
  );
  if (options.systems.length === 0) delete options.systems;
  return options;
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const manifest = importLibretroCheats(parseArguments(process.argv.slice(2)));
    for (const [system, metadata] of Object.entries(manifest.systems)) {
      process.stdout.write(
        `${system}: ${metadata.games} games, ${metadata.cheats} cheats, ${metadata.rawBytes} raw bytes, ${metadata.compressedBytes} Brotli bytes\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
