/**
 * Cheat shard file format, shared by the data builder
 * (`scripts/import-libretro-cheats.mjs`) and the browser parse worker
 * (`cheat-database.worker.ts`). It MUST stay free of Node and DOM APIs.
 *
 * The file stores each record once, without the values a reader can derive:
 *
 *   {
 *     schemaVersion: 1,
 *     system, sourceRevision,
 *     games: [{
 *       id, title, normalizedTitle, regions, revisions, sourceFiles, checksums,
 *       cheats: [{
 *         description?,   // present iff the source record has a `desc` field
 *         rawCode,
 *         codeKind?, importWarnings?,
 *         rawFields?,     // source fields other than desc/code, and enable when it is not "false"
 *         sourceFile,     // index into the game's sourceFiles
 *         sourceIndex,
 *       }],
 *     }],
 *   }
 *
 * {@link expandCheatShard} restores the full in-memory record: `system`,
 * `gameId`, and `sourceRevision` from the parents, `rawFields.desc`,
 * `rawFields.code`, and `rawFields.enable` from the record itself, and the
 * record `id` by hashing the restored fields. The native CLI performs the same
 * expansion in `crates/rom-weaver-cli/src/cheat_database.rs`; the two MUST
 * produce identical IDs, because bundles store them.
 */

export const CHEAT_SHARD_SCHEMA_VERSION = 1;

const CODE_KINDS = new Set(["game-genie", "pro-action-replay", "xploder"]);

/**
 * @typedef {Record<string, string>} RawFields
 * @typedef {{
 *   description?: string;
 *   rawCode: string | null;
 *   codeKind?: string;
 *   importWarnings?: string[];
 *   rawFields?: RawFields;
 *   sourceFile: number;
 *   sourceIndex: number;
 * }} StoredCheat
 * @typedef {{
 *   id: string;
 *   title: string;
 *   normalizedTitle: string;
 *   regions: string[];
 *   revisions: string[];
 *   sourceFiles: string[];
 *   checksums: Array<Record<string, unknown>>;
 *   cheats: StoredCheat[];
 * }} StoredGame
 * @typedef {{ schemaVersion: 1; system: string; sourceRevision: string; games: StoredGame[] }} StoredShard
 * @typedef {{
 *   id: string;
 *   system: string;
 *   gameId: string;
 *   description: string;
 *   rawCode: string | null;
 *   codeKind?: string;
 *   importWarnings?: string[];
 *   rawFields: RawFields;
 *   sourceFile: string;
 *   sourceIndex: number;
 *   sourceRevision: string;
 * }} ExpandedCheat
 * @typedef {Omit<StoredGame, "cheats"> & { cheats: ExpandedCheat[] }} ExpandedGame
 * @typedef {{ schemaVersion: 1; system: string; games: ExpandedGame[] }} ExpandedShard
 */

/**
 * JSON with object keys sorted by UTF-16 code unit, the order `Array.sort`
 * gives strings. The Rust port sorts the same way.
 * @param {unknown} value
 * @returns {string}
 */
export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * The text whose SHA-256 names a cheat record. `enable` is excluded so a
 * record's ID does not change when a source file toggles it.
 * @param {string} system
 * @param {string} gameId
 * @param {string | undefined} codeKind
 * @param {RawFields} rawFields
 * @returns {string}
 */
export const cheatIdSource = (system, gameId, codeKind, rawFields) => {
  const identityFields = Object.fromEntries(Object.entries(rawFields).filter(([key]) => key !== "enable"));
  return `${system}\0${gameId}\0${codeKind ?? ""}\0${canonicalJson(identityFields)}`;
};

/** @param {string} hex */
export const cheatIdFromHex = (hex) => `cheat_${hex.slice(0, 24)}`;

/** @param {unknown} value */
const isIndex = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** @param {unknown} value @returns {value is string[]} */
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {StoredCheat}
 */
const validateStoredCheat = (value, where) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} is not an object.`);
  const cheat = /** @type {Record<string, unknown>} */ (value);
  if (cheat.description !== undefined && typeof cheat.description !== "string") {
    throw new Error(`${where} has a non-string description.`);
  }
  if (cheat.rawCode !== null && typeof cheat.rawCode !== "string") throw new Error(`${where} has an invalid rawCode.`);
  if (cheat.codeKind !== undefined && !CODE_KINDS.has(/** @type {string} */ (cheat.codeKind))) {
    throw new Error(`${where} has an unknown codeKind.`);
  }
  if (cheat.importWarnings !== undefined && !isStringArray(cheat.importWarnings)) {
    throw new Error(`${where} has invalid importWarnings.`);
  }
  if (cheat.rawFields !== undefined) {
    const fields = cheat.rawFields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields))
      throw new Error(`${where} has invalid rawFields.`);
    for (const [key, field] of Object.entries(fields)) {
      if (typeof field !== "string") throw new Error(`${where} raw field ${key} is not a string.`);
    }
  }
  if (!(isIndex(cheat.sourceFile) && isIndex(cheat.sourceIndex))) throw new Error(`${where} has an invalid index.`);
  return /** @type {StoredCheat} */ (cheat);
};

/**
 * Check that parsed JSON has the stored shape, so both readers hash the same
 * fields: a value the Rust loader would reject or coerce (a null description,
 * an unknown code kind, a non-string raw field) MUST NOT produce an ID here.
 * The caller checks the header (`schemaVersion`, `system`) and size bounds.
 * @param {unknown} value
 * @returns {StoredShard}
 */
export const validateStoredShard = (value) => {
  if (!value || typeof value !== "object") throw new Error("The cheat database shard is not an object.");
  const shard = /** @type {Record<string, unknown>} */ (value);
  if (
    shard.schemaVersion !== CHEAT_SHARD_SCHEMA_VERSION ||
    typeof shard.system !== "string" ||
    typeof shard.sourceRevision !== "string" ||
    !Array.isArray(shard.games)
  ) {
    throw new Error("The cheat database shard has an invalid schema.");
  }
  shard.games.forEach((game, gameIndex) => {
    const where = `Game ${gameIndex}`;
    if (!game || typeof game !== "object" || Array.isArray(game)) throw new Error(`${where} is not an object.`);
    const record = /** @type {Record<string, unknown>} */ (game);
    if (typeof record.id !== "string" || typeof record.title !== "string") {
      throw new Error(`${where} has no id or title.`);
    }
    if (!isStringArray(record.sourceFiles)) throw new Error(`${where} has invalid sourceFiles.`);
    if (!Array.isArray(record.cheats)) throw new Error(`${where} has no cheats array.`);
    for (const [position, cheat] of record.cheats.entries()) validateStoredCheat(cheat, `${where} cheat ${position}`);
  });
  return /** @type {StoredShard} */ (shard);
};

/**
 * The description a record without a `desc` field carries.
 * @param {number} sourceIndex
 */
const defaultDescription = (sourceIndex) => `Cheat ${sourceIndex + 1}`;

/**
 * Restore the raw source fields the file left out. The result lists `desc`,
 * `code`, and `enable` first, in source order, then every other field.
 * @param {StoredCheat} cheat
 * @returns {RawFields}
 */
const expandRawFields = (cheat) => {
  /** @type {RawFields} */
  const fields = {};
  if (cheat.description !== undefined) fields.desc = cheat.description;
  if (cheat.rawCode !== null && cheat.rawCode !== undefined) fields.code = cheat.rawCode;
  fields.enable = cheat.rawFields?.enable ?? "false";
  for (const [key, value] of Object.entries(cheat.rawFields ?? {})) {
    if (key !== "enable") fields[key] = value;
  }
  return fields;
};

/**
 * Expand one stored shard into full records. `sha256Hex` hashes UTF-8 bytes
 * to lowercase hex; it is asynchronous so the browser can use WebCrypto.
 * The caller validates the shape and bounds first.
 * @param {StoredShard} shard
 * @param {(bytes: Uint8Array<ArrayBuffer>) => Promise<string>} sha256Hex
 * @returns {Promise<ExpandedShard>}
 */
export const expandCheatShard = async (shard, sha256Hex) => {
  const encoder = new TextEncoder();
  const games = [];
  for (const game of shard.games) {
    const { cheats: stored, ...rest } = game;
    const cheats = await Promise.all(
      stored.map(async (cheat, position) => {
        const sourceFile = game.sourceFiles[cheat.sourceFile];
        if (sourceFile === undefined) {
          throw new Error(`Cheat ${position} of game ${game.id} names a source file the game does not list.`);
        }
        const rawFields = expandRawFields(cheat);
        const hex = await sha256Hex(encoder.encode(cheatIdSource(shard.system, game.id, cheat.codeKind, rawFields)));
        /** @type {ExpandedCheat} */
        const record = {
          id: cheatIdFromHex(hex),
          system: shard.system,
          gameId: game.id,
          description: cheat.description ?? defaultDescription(cheat.sourceIndex),
          rawCode: cheat.rawCode ?? null,
          ...(cheat.codeKind === undefined ? {} : { codeKind: cheat.codeKind }),
          ...(cheat.importWarnings === undefined ? {} : { importWarnings: cheat.importWarnings }),
          rawFields,
          sourceFile,
          sourceIndex: cheat.sourceIndex,
          sourceRevision: shard.sourceRevision,
        };
        return record;
      }),
    );
    games.push({ ...rest, cheats });
  }
  return { schemaVersion: CHEAT_SHARD_SCHEMA_VERSION, system: shard.system, games };
};

/**
 * Reduce a full record to what the file stores. Inverse of the expansion in
 * {@link expandCheatShard}; the builder calls it once per record.
 * @param {ExpandedCheat} record
 * @param {string[]} sourceFiles
 * @returns {StoredCheat}
 */
export const storeCheat = (record, sourceFiles) => {
  const sourceFile = sourceFiles.indexOf(record.sourceFile);
  if (sourceFile < 0) throw new Error(`${record.sourceFile} is not one of the game's source files.`);
  // The reader rebuilds desc and code from description and rawCode, so a record
  // where they differ would come back changed.
  const hasDesc = Object.hasOwn(record.rawFields, "desc");
  if (hasDesc && record.rawFields.desc !== record.description) {
    throw new Error(`${record.sourceFile} cheat ${record.sourceIndex}: description differs from its desc field.`);
  }
  if ((record.rawFields.code ?? null) !== record.rawCode) {
    throw new Error(`${record.sourceFile} cheat ${record.sourceIndex}: rawCode differs from its code field.`);
  }
  /** @type {RawFields} */
  const rawFields = {};
  for (const [key, value] of Object.entries(record.rawFields)) {
    if (key === "desc" || key === "code") continue;
    if (key === "enable" && value === "false") continue;
    rawFields[key] = value;
  }
  return {
    ...(hasDesc ? { description: record.description } : {}),
    rawCode: record.rawCode,
    ...(record.codeKind === undefined ? {} : { codeKind: record.codeKind }),
    ...(record.importWarnings === undefined ? {} : { importWarnings: record.importWarnings }),
    ...(Object.keys(rawFields).length === 0 ? {} : { rawFields }),
    sourceFile,
    sourceIndex: record.sourceIndex,
  };
};
