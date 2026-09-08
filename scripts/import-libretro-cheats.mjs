// Normalizes Libretro `.cht` files into one JSON cheat shard per identify
// platform. Only the identify build (build-identify-index.mjs) writes shards:
// it supplies the extracted source files, the platform's parsed release list,
// and the pinned revision, so cheat data can never drift from the identify data
// it ships next to.

import { createHash } from "node:crypto";

export const CHEAT_SHARD_FORMAT = "rom-weaver-cheat-shard-v1";
export const CHEAT_SHARD_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_FILES_PER_SYSTEM = 20_000;
const MAX_RECORDS_PER_FILE = 20_000;
const MAX_FIELDS_PER_RECORD = 256;
const MAX_FIELD_BYTES = 256 * 1024;

// Identify platforms that ship a cheat shard, keyed by canonical platform name.
// `cheatSystem` is the Rust `CheatSystem` identifier the classifier consumes;
// `directory` is the archive directory that holds the platform's `.cht` files.
export const CHEAT_PLATFORMS = Object.freeze({
  "Nintendo - Game Boy": {
    cheatSystem: "gameboy",
    directory: "cht/Nintendo - Game Boy",
  },
  "Nintendo - Game Boy Advance": {
    cheatSystem: "gameboyadvance",
    directory: "cht/Nintendo - Game Boy Advance",
  },
  "Nintendo - Game Boy Color": {
    cheatSystem: "gameboy-color",
    directory: "cht/Nintendo - Game Boy Color",
  },
  "Nintendo - Nintendo Entertainment System": {
    cheatSystem: "nes",
    directory: "cht/Nintendo - Nintendo Entertainment System",
  },
  "Nintendo - Super Nintendo Entertainment System": {
    cheatSystem: "snes",
    directory: "cht/Nintendo - Super Nintendo Entertainment System",
  },
  "Sega - Mega Drive - Genesis": {
    cheatSystem: "genesis",
    directory: "cht/Sega - Mega Drive - Genesis",
  },
});

export const cheatShardFileName = (slug) => `cheats-${slug}.json`;

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
  const lines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u);

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

const stripExtension = (name) => name.replace(/\.(?:bin|cht|gb|gbc|gen|md|nes|sfc|smc)$/iu, "");

const stripDeviceAnnotation = (name) => {
  let result = name.trim();
  while (true) {
    const match = /\s+\(([^()]*)\)\s*$/u.exec(result);
    if (!match || !isSourceAnnotation(match[1])) return result;
    result = result.slice(0, match.index).trim();
  }
};

const codeKindForTitle = (title, cheatSystem) => {
  const annotations = [...title.matchAll(/\(([^()]*)\)/gu)].map((match) =>
    match[1].trim().toLowerCase(),
  );
  if (annotations.includes("game genie")) return "game-genie";
  if (
    cheatSystem === "gameboyadvance" &&
    annotations.some((annotation) =>
      [
        "action replay",
        "code breaker",
        "gameshark",
        "pro action replay",
        "xploder",
        "xplorer",
      ].includes(annotation),
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

export const stableGameId = (cheatSystem, normalizedTitle) =>
  stableId("game", `${cheatSystem}\0${normalizedTitle}`);

export const stableCheatId = (cheatSystem, gameId, record) => {
  const identityFields = Object.fromEntries(
    Object.entries(record.rawFields).filter(([key]) => key !== "enable"),
  );
  return stableId(
    "cheat",
    `${cheatSystem}\0${gameId}\0${record.codeKind ?? ""}\0${canonicalJson(identityFields)}`,
  );
};

// Codepoint comparison, never localeCompare: ICU collation varies by machine
// and would break the byte-identical rebuild promise the identify data makes.
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const checksumKey = (checksum) => canonicalJson(checksum);

// One release row per name and hashed component of an identify game record.
// The identify merge MAY replace `name` with the OpenGood filename-style name
// and keep the No-Intro name in `alternateNames`; `.cht` files are named after
// the No-Intro form, so every name MUST index the same dump. GoodTools legacy
// variants carry names no `.cht` file uses, so they add nothing.
export function releasesFromIdentifyGames(games) {
  const releases = [];
  for (const game of games) {
    if (game.legacyVariant) continue;
    const names = [...new Set([game.name, ...(game.alternateNames ?? [])].filter(Boolean))];
    for (const component of game.components ?? []) {
      if (!(component.crc32 || component.md5 || component.sha1)) continue;
      const checksum = {
        crc32: component.crc32 ?? null,
        md5: component.md5 ?? null,
        name: component.filename ?? null,
        sha1: component.sha1 ?? null,
        size: Number.isSafeInteger(component.size) && component.size > 0 ? component.size : null,
      };
      for (const name of names) releases.push({ name, region: game.region ?? null, checksum });
    }
  }
  return releases;
}

const releaseIndex = (releases) => {
  const byTitle = new Map();
  for (const release of releases) {
    const key = normalizeReleaseName(release.name);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(release);
  }
  return byTitle;
};

/**
 * Build one platform's shard. `files` are `{ sourcePath, text }` pairs whose
 * paths are archive-relative (`cht/<platform>/<title>.cht`); `releases` come
 * from {@link releasesFromIdentifyGames}.
 */
export function buildCheatShard({ cheatSystem, files, releases, sourceRevision }) {
  if (!cheatSystem) fail("buildCheatShard needs a cheatSystem.");
  if (!sourceRevision) fail("buildCheatShard needs a sourceRevision.");
  if (files.length > MAX_FILES_PER_SYSTEM) {
    fail(`${cheatSystem} has more than ${MAX_FILES_PER_SYSTEM} .cht files.`);
  }
  const byTitle = releaseIndex(releases);
  const games = new Map();

  for (const file of [...files].sort((left, right) => compare(left.sourcePath, right.sourcePath))) {
    const sourceFile = file.sourcePath;
    const baseName = sourceFile.slice(sourceFile.lastIndexOf("/") + 1);
    const sourceTitle = stripExtension(baseName);
    const codeKind = codeKindForTitle(sourceTitle, cheatSystem);
    const normalizedTitle = normalizeReleaseName(sourceTitle);
    const matched = byTitle.get(normalizedTitle) ?? [];
    const canonicalTitle = matched[0]?.name ?? stripDeviceAnnotation(sourceTitle);
    const gameId = stableGameId(cheatSystem, normalizedTitle);
    if (!games.has(gameId)) {
      const metadata = titleMetadata(canonicalTitle, matched[0]?.region);
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
    for (const release of matched) {
      if (release.region) game.regions.add(release.region);
      const metadata = titleMetadata(release.name, release.region);
      for (const region of metadata.regions) game.regions.add(region);
      for (const revision of metadata.revisions) game.revisions.add(revision);
      game.checksums.set(checksumKey(release.checksum), release.checksum);
    }

    for (const parsed of parseCht(file.text, { sourceFile, sourceRevision })) {
      const record = { ...parsed, gameId, system: cheatSystem, ...(codeKind ? { codeKind } : {}) };
      record.id = stableCheatId(cheatSystem, gameId, record);
      if (!game.cheats.has(record.id)) game.cheats.set(record.id, record);
    }
  }

  const serializedGames = [...games.values()]
    .map((game) => ({
      checksums: [...game.checksums.values()].sort((left, right) =>
        compare(checksumKey(left), checksumKey(right)),
      ),
      cheats: [...game.cheats.values()].sort(
        (left, right) =>
          compare(left.sourceFile, right.sourceFile) || left.sourceIndex - right.sourceIndex,
      ),
      id: game.id,
      normalizedTitle: game.normalizedTitle,
      regions: [...game.regions].sort(compare),
      revisions: [...game.revisions].sort(compare),
      sourceFiles: [...game.sourceFiles].sort(compare),
      title: game.title,
    }))
    .sort(
      (left, right) =>
        compare(left.normalizedTitle, right.normalizedTitle) || compare(left.id, right.id),
    );

  return { schemaVersion: CHEAT_SHARD_SCHEMA_VERSION, system: cheatSystem, games: serializedGames };
}

export const encodeCheatShard = (shard) => Buffer.from(`${JSON.stringify(shard)}\n`, "utf8");
