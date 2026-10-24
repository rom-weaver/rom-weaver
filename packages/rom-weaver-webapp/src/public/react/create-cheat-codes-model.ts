import type { CheatCodeKind, CheatManualSystem, ClassifiedCheatRecord } from "../../lib/cheats/index.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
import { getFileNameWithoutExtension } from "../../lib/input/path-utils.ts";
import { sanitizeCheatPatchNamePart, toCheatPatchNameSuffix } from "./cheat-patch-name.ts";

/**
 * Pure projections for the create workflow's cheat-codes mode: splitting the
 * typed codes, reading the classifier's answer back out, naming the patch, and
 * deciding whether the run may start. Everything here renders only what the
 * Rust classifier returned - no address or compare byte is ever inferred here.
 */

/** One code the user typed or picked, with whatever the classifier said about it. */
type CreateCheatCodeEntry = {
  /** Stable per-entry key: the code plus its position in the list. */
  id: string;
  code: string;
  description: string;
  record?: ClassifiedCheatRecord;
  error?: string;
};

type CheatCodeWrite = { offset: number; value: number; width: number; compare?: number | null };

const CHEAT_KIND_OPTIONS: Array<{ value: CheatCodeKind; label: string }> = [
  { value: "game-genie", label: "Game Genie" },
  { value: "pro-action-replay", label: "Action Replay / GameShark" },
  { value: "pro-action-rocky", label: "Pro Action Rocky" },
  { value: "gold-finger", label: "Gold Finger" },
  { value: "game-shark-v1", label: "GBA GameShark / AR v1/v2" },
  { value: "game-shark-v1-raw", label: "GBA GameShark / AR v1/v2 (raw)" },
  { value: "action-replay-v3", label: "GBA Action Replay v3" },
  { value: "action-replay-v3-raw", label: "GBA Action Replay v3 (raw)" },
  { value: "xploder", label: "Xploder" },
];

const KIND_LABELS = Object.fromEntries(CHEAT_KIND_OPTIONS.map(({ value, label }) => [value, label]));

const SYSTEM_LABELS: Record<CheatManualSystem, string> = {
  nes: "NES",
  snes: "SNES",
  genesis: "Genesis",
  gameboy: "Game Boy",
  "gameboy-color": "Game Boy Color",
  gameboyadvance: "Game Boy Advance",
  mastersystem: "Master System",
  gamegear: "Game Gear",
  sega32x: "Sega 32X",
  playstation: "PlayStation",
};

const CODE_SEPARATOR_REGEX = /[+,;\s]+/u;

/**
 * The plain separator split, used only where the Rust engine cannot answer yet:
 * before a ROM has picked the cheat system (WASM needs the ROM to run), and for
 * a classified record that arrived without the engine's `codes`. Whenever a ROM
 * is loaded the engine's `codes` win - it alone knows the Xploder and GBA
 * word-pairing rules (`cheats::split_for_kind` in the Rust crate).
 */
const splitPlainCheatCodes = (text: string): string[] =>
  String(text || "")
    .split(CODE_SEPARATOR_REGEX)
    .map((code) => code.trim())
    .filter((code) => !!code);

/** The codes a classified record holds, as the Rust engine split them. */
const getClassifiedCheatCodes = (record: ClassifiedCheatRecord): string[] =>
  record.codes ?? splitPlainCheatCodes(record.record.rawCode || "");

const toHex = (value: number, digits: number) =>
  `$${Math.max(0, Math.trunc(value)).toString(16).toUpperCase().padStart(digits, "0")}`;

/** One write as `$OFFSET ← $VALUE`, the value sized by the write's own width. */
const formatCheatWrite = (write: CheatCodeWrite): string =>
  `${toHex(write.offset, 6)} ← ${toHex(write.value, Math.max(2, (write.width || 1) * 2))}`;

/** The compare badge, present only when the classifier matched a compare byte. */
const getCheatCompareLabel = (write: CheatCodeWrite, localizer: Localizer): string =>
  typeof write.compare === "number"
    ? localizer.message("ui.cheats.compareFound", { value: toHex(write.compare, 2) })
    : "";

/** Every ROM write a classified record resolved to, in the order Rust returned. */
const getCheatCodeWrites = (record: ClassifiedCheatRecord | undefined): CheatCodeWrite[] => {
  if (!record) return [];
  const { resolution } = record;
  return resolution.type === "romBakeable" ? resolution.writes : [];
};

/** True once the classifier resolved the code into something a patch can carry. */
const isBakeableCheatCode = (entry: CreateCheatCodeEntry): boolean => entry.record?.resolution.type === "romBakeable";

/**
 * The detected line above the code rows: the system, the code type, and the
 * total number of ROM writes - "NES · Game Genie · 2 writes". Blank until at
 * least one code has been classified.
 */
const describeCheatCodes = (entries: readonly CreateCheatCodeEntry[], localizer: Localizer): string => {
  const classified = entries.filter((entry) => !!entry.record);
  if (!classified.length) return "";
  const systems = [...new Set(classified.map((entry) => entry.record?.record.system).filter((value) => !!value))];
  const kinds = [...new Set(classified.map((entry) => entry.record?.detectedKind).filter((value) => !!value))];
  const writeCount = classified.reduce((total, entry) => total + getCheatCodeWrites(entry.record).length, 0);
  const parts: string[] = [];
  if (systems.length === 1) parts.push(SYSTEM_LABELS[systems[0] as CheatManualSystem] || String(systems[0]));
  else if (systems.length > 1) parts.push(localizer.message("ui.cheats.mixedSystems"));
  if (kinds.length === 1) parts.push(KIND_LABELS[String(kinds[0])] || String(kinds[0]));
  else if (kinds.length > 1) parts.push(localizer.message("ui.cheats.mixedKinds"));
  parts.push(localizer.messageCount("ui.cheats.writeCount", writeCount));
  return parts.join(" · ");
};

/**
 * The default patch name: the original ROM's name, the first cheat's
 * description, and the format extension - "Zelda - Infinite health.ips". A
 * code with no description of its own falls back to "- cheats".
 */
const getCheatCodesPatchName = (
  originalFileName: string,
  entries: readonly CreateCheatCodeEntry[],
  format: string,
): string => {
  const stem =
    sanitizeCheatPatchNamePart(getFileNameWithoutExtension(String(originalFileName || "").trim())) || "patch";
  const description = entries.map((entry) => entry.description.trim()).find((value) => !!value) || "";
  const extension = String(format || "bps")
    .trim()
    .toLowerCase();
  return `${stem} - ${toCheatPatchNameSuffix(description) || "cheats"}.${extension}`;
};

/**
 * Why the run cannot start, or "" when it can. Every code MUST resolve to ROM
 * writes: a patch carries nothing else.
 */
const getCheatCodesValidationMessage = (
  entries: readonly CreateCheatCodeEntry[],
  classifying: boolean,
  localizer: Localizer,
): string => {
  if (!entries.length) return localizer.message("ui.cheats.validation.empty");
  if (classifying) return localizer.message("ui.cheats.validation.checking");
  const unresolved = entries.filter((entry) => !isBakeableCheatCode(entry));
  if (!unresolved.length) return "";
  const first = unresolved[0] as CreateCheatCodeEntry;
  if (first.error) return `${first.code}: ${first.error}`;
  if (first.record?.resolution.type === "unsupported") return `${first.code}: ${first.record.resolution.reason}`;
  return localizer.message("ui.cheats.validation.unchecked", { code: first.code });
};

export {
  CHEAT_KIND_OPTIONS,
  describeCheatCodes,
  formatCheatWrite,
  getCheatCodeWrites,
  getCheatCodesPatchName,
  getCheatCodesValidationMessage,
  getCheatCompareLabel,
  getClassifiedCheatCodes,
  splitPlainCheatCodes,
  type CreateCheatCodeEntry,
};
