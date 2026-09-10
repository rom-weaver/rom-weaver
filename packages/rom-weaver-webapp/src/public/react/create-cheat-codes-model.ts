import type { CheatManualSystem, ClassifiedCheatRecord } from "../../lib/cheats/index.ts";
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

const KIND_LABELS: Record<string, string> = {
  "game-genie": "Game Genie",
  "pro-action-replay": "Action Replay",
  xploder: "Xploder",
};

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

/** Mirrors Rust `is_gba_rom_patch_word`: the second word of a GBA ROM patch. */
const isGbaRomPatchWord = (token: string): boolean => token.length === 8 && /^1[8ace]/iu.test(token);

/**
 * Mirrors Rust `split_xploder_codes`: an Xploder code spans several
 * whitespace-separated words, so splitting on whitespace alone would tear one
 * code apart. A four-word GBA ROM patch stays whole, and an 8+4 or 8+8 pair is
 * one code.
 */
const splitXploderCodes = (tokens: readonly string[]): string[] => {
  const codes: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const [first, second, third, fourth] = [
      tokens[index] as string,
      tokens[index + 1],
      tokens[index + 2],
      tokens[index + 3],
    ];
    if (
      second !== undefined &&
      third !== undefined &&
      fourth !== undefined &&
      first.length === 8 &&
      second.length === 8 &&
      third.length === 8 &&
      fourth.length === 8 &&
      first.toUpperCase() === "00000000" &&
      isGbaRomPatchWord(second) &&
      fourth.toUpperCase() === "00000000"
    ) {
      codes.push(`${first}${second}${third}${fourth}`);
      index += 4;
      continue;
    }
    if (second !== undefined && first.length === 8 && (second.length === 4 || second.length === 8)) {
      codes.push(`${first}${second}`);
      index += 2;
      continue;
    }
    codes.push(first);
    index += 1;
  }
  return codes;
};

/**
 * Mirrors Rust `codes_for_kind`: Xploder codes are word-pairs, so the plain
 * whitespace split would cut them in half. The kind override decides, and
 * `auto` follows the system the way the engine does.
 */
const usesXploderSplit = (system?: string, kind?: string): boolean => {
  const normalizedKind = String(kind || "auto").toLowerCase();
  if (normalizedKind === "xploder") return true;
  return normalizedKind === "auto" && (system === "gameboyadvance" || system === "playstation");
};

/**
 * Split a raw block of codes the way the Rust engine does: cheat lists arrive
 * joined with `+`, newlines, commas, semicolons or spaces, and each piece is one
 * code - except for Xploder codes, whose words are re-joined by
 * `splitXploderCodes`. Intra-code separators (`-`, `:`) are left alone.
 */
const splitCheatCodes = (text: string, system?: string, kind?: string): string[] => {
  const tokens = String(text || "")
    .split(CODE_SEPARATOR_REGEX)
    .map((code) => code.trim())
    .filter((code) => !!code);
  return usesXploderSplit(system, kind) ? splitXploderCodes(tokens) : tokens;
};

const toHex = (value: number, digits: number) =>
  `$${Math.max(0, Math.trunc(value)).toString(16).toUpperCase().padStart(digits, "0")}`;

/** One write as `$OFFSET ← $VALUE`, the value sized by the write's own width. */
const formatCheatWrite = (write: CheatCodeWrite): string =>
  `${toHex(write.offset, 6)} ← ${toHex(write.value, Math.max(2, (write.width || 1) * 2))}`;

/** The compare badge, present only when the classifier matched a compare byte. */
const getCheatCompareLabel = (write: CheatCodeWrite): string =>
  typeof write.compare === "number" ? `compare ${toHex(write.compare, 2)} found` : "";

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
const describeCheatCodes = (entries: readonly CreateCheatCodeEntry[]): string => {
  const classified = entries.filter((entry) => !!entry.record);
  if (!classified.length) return "";
  const systems = [...new Set(classified.map((entry) => entry.record?.record.system).filter((value) => !!value))];
  const kinds = [...new Set(classified.map((entry) => entry.record?.detectedKind).filter((value) => !!value))];
  const writeCount = classified.reduce((total, entry) => total + getCheatCodeWrites(entry.record).length, 0);
  const parts: string[] = [];
  if (systems.length === 1) parts.push(SYSTEM_LABELS[systems[0] as CheatManualSystem] || String(systems[0]));
  else if (systems.length > 1) parts.push("Mixed systems");
  if (kinds.length === 1) parts.push(KIND_LABELS[String(kinds[0])] || String(kinds[0]));
  else if (kinds.length > 1) parts.push("Mixed code types");
  parts.push(`${writeCount} ${writeCount === 1 ? "write" : "writes"}`);
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
const getCheatCodesValidationMessage = (entries: readonly CreateCheatCodeEntry[], classifying: boolean): string => {
  if (!entries.length) return "Add at least one cheat code to create a patch.";
  if (classifying) return "Checking the cheat codes…";
  const unresolved = entries.filter((entry) => !isBakeableCheatCode(entry));
  if (!unresolved.length) return "";
  const first = unresolved[0] as CreateCheatCodeEntry;
  if (first.error) return `${first.code}: ${first.error}`;
  if (first.record?.resolution.type === "unsupported") return `${first.code}: ${first.record.resolution.reason}`;
  return `${first.code} has not been checked yet.`;
};

export {
  describeCheatCodes,
  formatCheatWrite,
  getCheatCodeWrites,
  getCheatCodesPatchName,
  getCheatCodesValidationMessage,
  getCheatCompareLabel,
  splitCheatCodes,
  type CreateCheatCodeEntry,
};
