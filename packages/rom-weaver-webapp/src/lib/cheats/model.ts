const CHEAT_DATABASE_SYSTEMS = ["nes", "snes", "genesis", "gameboy", "gameboy-color", "gameboyadvance"] as const;

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

type CheatDatabaseManifestSystem = {
  path: string;
  compressedPath: string;
  label: string;
  games: number;
  cheats: number;
  rawBytes: number;
  compressedBytes: number;
};

export type CheatDatabaseManifest = {
  attributionPath: string;
  licensePath: string;
  schemaVersion: 1;
  source: string;
  sourceRevision: string;
  sourceUrl: string;
  license: "CC-BY-SA-4.0";
  systems: Partial<Record<CheatDatabaseSystem, CheatDatabaseManifestSystem>>;
};

export type CheatRomIdentity = {
  /** Changes whenever the original ROM changes, even when its title stays the same. */
  key: string;
  system?: string;
  title?: string;
  fileName?: string;
  checksums?: Record<string, string | string[]>;
};

export type CheatGameMatch =
  | { kind: "no-rom" }
  | { kind: "unsupported-system"; system?: string }
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
