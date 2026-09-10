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
  "Sega - Master System - Mark III": {
    cheatSystem: "mastersystem",
    directory: "cht/Sega - Master System - Mark III",
  },
  "Sega - Game Gear": {
    cheatSystem: "gamegear",
    directory: "cht/Sega - Game Gear",
  },
  "Sega - 32X": {
    cheatSystem: "sega32x",
    directory: "cht/Sega - 32X",
  },
});

export const cheatShardFileName = (slug) => `cheats-${slug}.json`;

// Build-time prefilter: drop records the Rust classifier (crates/rom-weaver-cli/src/cheats)
// can never bake into a ROM, so shards ship only candidates. A record survives
// unless it is provably dead:
//   - no native code (missing/empty rawCode), a structured RetroArch entry
//     (the raw_fields the Rust `has_structured_runtime_semantics` list), or a
//     `?`/`XX` parameter placeholder;
//   - EVERY subcode decodes to a literal address the target system's ROM
//     range can never contain. Subcodes are split the way Rust does (`+`, `,`,
//     `;`, whitespace; the Xploder four-word grouping for gameboyadvance).
// Per system, only a form whose address is unambiguous gets checked:
//   nes            - Pro Action Replay hex (`:` stripped): addr < 0x8000 is RAM.
//                    Letters-only Game Genie codes are always kept.
//   snes           - only when the record's codeKind is pro-action-replay
//                    (Game Genie is otherwise ambiguous until decoded against
//                    the ROM): 24-bit addr in bank 7E/7F, or a system bank
//                    with low < 0x2000, is RAM.
//   genesis/sega32x- colon or 10-hex Pro Action Replay: addr >= 0xE00000 is
//                    RAM. 8-char Game Genie codes are always kept.
//   gameboy(-color)- 8-hex GameShark: addr >= 0x8000 is RAM. 6/9-digit Game
//                    Genie codes are always kept.
//   gameboyadvance - only the four-word Xploder ROM-patch form, or a decoded
//                    address in 0x08000000..0x0A000000, counts as bakeable;
//                    every other shape (runtime/conditional Xploder codes)
//                    counts as RAM.
//   mastersystem/  - `00AAAAVV` Pro Action Replay: addr >= 0xC000 is RAM.
//   gamegear/sg1000  `AAAA:VV` Fusion RAM codes are always RAM. Game Genie
//                    `DDA-AAA[-RXR]` codes are always kept.
const STRUCTURED_RUNTIME_FIELDS = new Set([
  "address",
  "value",
  "handler",
  "memory_search_size",
  "address_bit_position",
  "big_endian",
  "repeat_count",
  "repeat_add_to_address",
  "repeat_add_to_value",
  "condition",
  "condition_type",
  "condition_address",
  "condition_value",
  "activation",
]);

const hasStructuredRuntimeSemantics = (record) =>
  Object.keys(record.rawFields ?? {}).some((name) => STRUCTURED_RUNTIME_FIELDS.has(name));

const containsParameterPlaceholder = (value) =>
  value.includes("?") || value.toUpperCase().includes("XX");

const isHex = (value, length) => value.length === length && /^[0-9a-fA-F]+$/u.test(value);

// Mirrors Rust `split_codes`.
const splitCodes = (input) =>
  input
    .split(/[+,;\s]+/u)
    .map((piece) => piece.trim())
    .filter(Boolean);

const isGbaRomPatchWord = (token) => token.length === 8 && /^1[8aAcCeE]/u.test(token);

// Mirrors Rust `split_xploder_codes`: a four-word GBA ROM-patch code stays
// together as one item, a two-word raw code merges into one item.
const splitXploderCodes = (input) => {
  const tokens = input
    .split(/[+,;\s]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
  const codes = [];
  let index = 0;
  while (index < tokens.length) {
    if (
      index + 3 < tokens.length &&
      tokens[index].length === 8 &&
      tokens[index + 1].length === 8 &&
      tokens[index + 2].length === 8 &&
      tokens[index + 3].length === 8 &&
      tokens[index].toUpperCase() === "00000000" &&
      isGbaRomPatchWord(tokens[index + 1]) &&
      tokens[index + 3].toUpperCase() === "00000000"
    ) {
      codes.push(tokens[index] + tokens[index + 1] + tokens[index + 2] + tokens[index + 3]);
      index += 4;
      continue;
    }
    if (
      index + 1 < tokens.length &&
      tokens[index].length === 8 &&
      (tokens[index + 1].length === 4 || tokens[index + 1].length === 8)
    ) {
      codes.push(tokens[index] + tokens[index + 1]);
      index += 2;
      continue;
    }
    codes.push(tokens[index]);
    index += 1;
  }
  return codes;
};

const nesSubcodeIsRam = (subcode) => {
  const stripped = subcode.replace(/:/gu, "");
  if (!/^[0-9a-fA-F]+$/u.test(stripped) || (stripped.length !== 6 && stripped.length !== 8)) {
    return false;
  }
  return Number.parseInt(stripped.slice(0, 4), 16) < 0x8000;
};

const snesSubcodeIsRam = (subcode, record) => {
  if (record.codeKind !== "pro-action-replay") return false;
  const stripped = subcode.replace(/[-:]/gu, "");
  if (!isHex(stripped, 8)) return false;
  const address = Number.parseInt(stripped.slice(0, 6), 16);
  const bank = (address >> 16) & 0xff;
  const low = address & 0xffff;
  const systemBank = bank <= 0x3f || (bank >= 0x80 && bank <= 0xbf);
  return bank === 0x7e || bank === 0x7f || (systemBank && low < 0x2000);
};

const genesisSubcodeIsRam = (subcode) => {
  let address;
  if (subcode.includes(":")) {
    const [addressPart] = subcode.split(":");
    if (!isHex(addressPart, 6)) return false;
    address = Number.parseInt(addressPart, 16);
  } else {
    if (!isHex(subcode, 10)) return false;
    address = Number.parseInt(subcode.slice(0, 6), 16);
  }
  return address >= 0xe0_0000;
};

const gameboySubcodeIsRam = (subcode) => {
  const stripped = subcode.replace(/-/gu, "");
  if (!isHex(stripped, 8)) return false;
  const low = Number.parseInt(stripped.slice(4, 6), 16);
  const high = Number.parseInt(stripped.slice(6, 8), 16);
  return ((high << 8) | low) >= 0x8000;
};

const gbaSubcodeIsRam = (subcode) => {
  const code = subcode.toUpperCase();
  if (isHex(code, 32)) {
    return !(
      code.slice(0, 8) === "00000000" &&
      ["18", "1A", "1C", "1E"].includes(code.slice(8, 10)) &&
      code.slice(16, 20) === "0000" &&
      code.slice(24, 32) === "00000000"
    );
  }
  if (isHex(code, 12)) {
    const type = code[0];
    if (type !== "3" && type !== "8") return true;
    const address = Number.parseInt(code.slice(1, 8), 16);
    return !(address >= 0x0800_0000 && address < 0x0a00_0000);
  }
  return true;
};

const segaZ80SubcodeIsRam = (subcode) => {
  if (/^[0-9a-fA-F]{4}:[0-9a-fA-F]{2}$/u.test(subcode)) return true;
  const stripped = subcode.replace(/-/gu, "");
  if (isHex(stripped, 8) && stripped.slice(0, 2) === "00") {
    return Number.parseInt(stripped.slice(2, 6), 16) >= 0xc000;
  }
  return false;
};

const SUBCODE_RAM_CHECKS = Object.freeze({
  nes: nesSubcodeIsRam,
  snes: snesSubcodeIsRam,
  genesis: genesisSubcodeIsRam,
  sega32x: genesisSubcodeIsRam,
  gameboy: gameboySubcodeIsRam,
  "gameboy-color": gameboySubcodeIsRam,
  gameboyadvance: gbaSubcodeIsRam,
  mastersystem: segaZ80SubcodeIsRam,
  gamegear: segaZ80SubcodeIsRam,
  sg1000: segaZ80SubcodeIsRam,
});

// Returns false only for a record the Rust classifier can never bake: it has
// no native code, carries structured RetroArch runtime fields, needs a
// parameter value, or every one of its subcodes decodes to a literal address
// outside the system's cartridge ROM range.
export function isBakeableCandidate(cheatSystem, record) {
  const rawCode = record.rawCode;
  if (rawCode === null || rawCode === undefined || rawCode.trim() === "") return false;
  if (hasStructuredRuntimeSemantics(record)) return false;
  if (containsParameterPlaceholder(rawCode)) return false;
  const subcodes =
    cheatSystem === "gameboyadvance" ? splitXploderCodes(rawCode) : splitCodes(rawCode);
  if (subcodes.length === 0) return false;
  const subcodeIsRam = SUBCODE_RAM_CHECKS[cheatSystem];
  if (!subcodeIsRam) return true;
  return !subcodes.every((subcode) => subcodeIsRam(subcode, record));
}

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
  let droppedCount = 0;

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
      if (!isBakeableCandidate(cheatSystem, record)) {
        droppedCount += 1;
        continue;
      }
      record.id = stableCheatId(cheatSystem, gameId, record);
      if (!game.cheats.has(record.id)) game.cheats.set(record.id, record);
    }
  }

  console.error(`[cheats] ${cheatSystem}: dropped ${droppedCount} record(s) that can never bake`);

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
    .filter((game) => game.cheats.length > 0)
    .sort(
      (left, right) =>
        compare(left.normalizedTitle, right.normalizedTitle) || compare(left.id, right.id),
    );

  return { schemaVersion: CHEAT_SHARD_SCHEMA_VERSION, system: cheatSystem, games: serializedGames };
}

export const encodeCheatShard = (shard) => Buffer.from(`${JSON.stringify(shard)}\n`, "utf8");
