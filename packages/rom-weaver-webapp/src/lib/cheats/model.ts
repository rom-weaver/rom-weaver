const CHEAT_DATABASE_SYSTEMS = [
  "nes",
  "snes",
  "genesis",
  "gameboy",
  "gameboy-color",
  "gameboyadvance",
  "mastersystem",
  "gamegear",
  "sega32x",
] as const;

/** The Rust `CheatSystem` identifier a shard's records carry. */
export type CheatDatabaseSystem = (typeof CHEAT_DATABASE_SYSTEMS)[number];

/**
 * Systems the code decoder handles but no cheat shard covers. The wire value is
 * the Rust `CheatSystem` variant name, not its CLI alias.
 */
const CHEAT_MANUAL_ONLY_SYSTEMS = ["playstation"] as const;

/** Every system a hand-entered code can be classified against. */
export type CheatManualSystem = CheatDatabaseSystem | (typeof CHEAT_MANUAL_ONLY_SYSTEMS)[number];

/** A system that reaches the step through manual entry alone. */
export type CheatManualOnlySystem = (typeof CHEAT_MANUAL_ONLY_SYSTEMS)[number];

type CheatCodeKind = "game-genie" | "pro-action-replay" | "xploder";
type RustCheatSystem = CheatManualSystem;

export type CheatRecord = {
  id: string;
  system: RustCheatSystem;
  gameId: string;
  description: string;
  rawCode: string | null;
  codeKind?: CheatCodeKind;
  rawFields: Record<string, string>;
  sourceFile: string;
  sourceIndex: number;
  sourceRevision: string;
};

/**
 * Mirrors the Rust `CheatWrite`: `compare` is present only when the code
 * carried a compare byte the resolver matched against this offset.
 */
type CheatWrite = { offset: number; value: number; width: number; compare?: number | null };

type CheatResolution = { type: "romBakeable"; writes: CheatWrite[] } | { type: "unsupported"; reason: string };

export type CheatDatabaseRecord = {
  id: string;
  system: CheatDatabaseSystem;
  gameId: string;
  description: string;
  rawCode?: string | null;
  codeKind?: CheatCodeKind;
  rawFields: Record<string, string> | Array<{ name: string; value: string }>;
  sourceFile: string;
  sourceIndex: number;
  sourceRevision: string;
  importWarnings?: string[];
};

export type ClassifiedCheatRecord = {
  record: CheatRecord;
  resolution: CheatResolution;
  detectedKind: CheatCodeKind | null;
};

export type CheatGameRecord = {
  id: string;
  title: string;
  normalizedTitle: string;
  regions: string[];
  revisions: string[];
  sourceFiles: string[];
  checksums: Array<{
    crc32?: string | null;
    md5?: string | null;
    sha1?: string | null;
    size?: number | null;
    name?: string | null;
  }>;
  cheats: CheatDatabaseRecord[];
};

export type CheatSystemShard = {
  schemaVersion: 1;
  system: CheatDatabaseSystem;
  games: CheatGameRecord[];
};

/**
 * One `cheats[]` row of the identify index: the shard for one identify
 * platform. `file` is the data-dir file name the build staged under
 * `assets/identify-`, and `sha256` is what the worker verifies before parsing.
 */
export type CheatDatabaseEntry = {
  platform: string;
  slug: string;
  cheatSystem: CheatDatabaseSystem;
  file: string;
  rawBytes: number;
  sha256: string;
  games: number;
  cheats: number;
};

export type CheatDatabaseIndex = {
  sourceRevision: string;
  sourceUrl: string;
  license: string;
  entries: CheatDatabaseEntry[];
};

export type CheatRomIdentity = {
  /** Changes whenever the original ROM changes, even when its title stays the same. */
  key: string;
  /** The platform tag ingest reported for the ROM, resolved through the identify catalog. */
  platform?: string;
  title?: string;
  fileName?: string;
  checksums?: Record<string, string | string[]>;
};

export type CheatGameMatch =
  | { kind: "no-rom" }
  | { kind: "unsupported-system"; platform?: string }
  | { kind: "exact"; game: CheatGameRecord }
  | { kind: "title"; game: CheatGameRecord }
  | { kind: "manual"; game: CheatGameRecord }
  | { kind: "none" };

export type ManualCheatKindOverride = "auto" | CheatCodeKind;

type ManualCheatRequest = {
  code: string;
  description: string;
  system: CheatManualSystem;
  kind: ManualCheatKindOverride;
};

export type ManualCheatResult = {
  record: ClassifiedCheatRecord;
  detectedSystem: CheatManualSystem;
  detectedType: string;
};

export type ManualCheatClassifier = (request: ManualCheatRequest) => Promise<ManualCheatResult>;

export type DatabaseCheatClassifier = (
  records: CheatDatabaseRecord[],
  system: CheatDatabaseSystem,
) => Promise<ClassifiedCheatRecord[]>;

export const isCheatDatabaseSystem = (value: string | undefined): value is CheatDatabaseSystem =>
  CHEAT_DATABASE_SYSTEMS.some((system) => system === value);

export const isCheatManualSystem = (value: string | undefined): value is CheatManualSystem =>
  isCheatDatabaseSystem(value) || CHEAT_MANUAL_ONLY_SYSTEMS.some((system) => system === value);

export const isSelectableCheat = (record: ClassifiedCheatRecord): boolean => record.resolution.type === "romBakeable";

export const cheatDelivery = (record: ClassifiedCheatRecord): "rom" | "unsupported" =>
  record.resolution.type === "romBakeable" ? "rom" : "unsupported";
