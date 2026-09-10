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
  /** @type {RawFields} */
  const rawFields = {};
  for (const [key, value] of Object.entries(record.rawFields)) {
    if (key === "desc" || key === "code") continue;
    if (key === "enable" && value === "false") continue;
    rawFields[key] = value;
  }
  const hasDesc = Object.hasOwn(record.rawFields, "desc");
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
