const CHEAT_DATABASE_SYSTEMS = ["nes", "snes", "genesis", "gameboy", "gameboy-color", "gameboyadvance"] as const;

/** The Rust `CheatSystem` identifier a shard's records carry. */
export type CheatDatabaseSystem = (typeof CHEAT_DATABASE_SYSTEMS)[number];

type CheatCodeKind = "game-genie" | "pro-action-replay" | "xploder";
type RustCheatSystem = CheatDatabaseSystem;

export type RuntimeCheatRecord = {
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

type CheatWrite = { offset: number; value: number; width: number };
type RuntimeCheatPayload = { record: RuntimeCheatRecord };

type CheatResolution =
  | { type: "romBakeable"; writes: CheatWrite[] }
  | { type: "runtime"; payload: RuntimeCheatPayload }
  | { type: "mixed"; writes: CheatWrite[]; payload: RuntimeCheatPayload }
  | { type: "requiresParameter"; payload: RuntimeCheatPayload }
  | { type: "unsupported"; reason: string };

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
  record: RuntimeCheatRecord;
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

export type CheatFilter = "all" | "rom" | "runtime" | "requires-parameter";

export type ManualCheatKindOverride = "auto" | CheatCodeKind;

type ManualCheatRequest = {
  code: string;
  description: string;
  system: CheatDatabaseSystem;
  kind: ManualCheatKindOverride;
};

export type ManualCheatResult = {
  record: ClassifiedCheatRecord;
  detectedSystem: CheatDatabaseSystem;
  detectedType: string;
};

export type ManualCheatClassifier = (request: ManualCheatRequest) => Promise<ManualCheatResult>;

export type DatabaseCheatClassifier = (
  records: CheatDatabaseRecord[],
  system: CheatDatabaseSystem,
) => Promise<ClassifiedCheatRecord[]>;

export type LocalCheatFileImporter = (request: {
  content: string;
  fileName: string;
  system: CheatDatabaseSystem;
}) => Promise<ClassifiedCheatRecord[]>;

export type LocalCheatFileImport = Parameters<LocalCheatFileImporter>[0];

export const isCheatDatabaseSystem = (value: string | undefined): value is CheatDatabaseSystem =>
  CHEAT_DATABASE_SYSTEMS.some((system) => system === value);

export const isSelectableCheat = (record: ClassifiedCheatRecord): boolean =>
  record.resolution.type !== "requiresParameter" && record.resolution.type !== "unsupported";

export const cheatDelivery = (
  record: ClassifiedCheatRecord,
): "rom" | "runtime" | "requires-parameter" | "unsupported" => {
  if (record.resolution.type === "romBakeable") return "rom";
  if (record.resolution.type === "runtime" || record.resolution.type === "mixed") return "runtime";
  if (record.resolution.type === "requiresParameter") return "requires-parameter";
  return "unsupported";
};
