// Characters and names that Windows, macOS, or Linux cannot give a file.
const RESERVED_NAME_CHARACTERS = /[<>:"/\\|?*\p{Cc}]/u;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// File systems limit a name in bytes, not in UTF-16 units. The longest name a rename makes is a
// two-digit disc's two-digit track: `<game> (Disc 99) (Track 99).bin`.
const FILE_NAME_BYTE_LIMIT = 255;
const LONGEST_RENAMED_FILE_SUFFIX = " (Disc 99) (Track 99).bin";
const textEncoder = new TextEncoder();

type GameNameProblem = "characters" | "dot" | "length" | "windows";

/** Why a game name cannot name its playlist and renamed discs; null when it can. */
const checkGameName = (name: string): GameNameProblem | null => {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (RESERVED_NAME_CHARACTERS.test(trimmed)) return "characters";
  if (RESERVED_WINDOWS_NAMES.test(trimmed)) return "windows";
  if (trimmed.endsWith(".")) return "dot";
  if (textEncoder.encode(`${trimmed}${LONGEST_RENAMED_FILE_SUFFIX}`).length > FILE_NAME_BYTE_LIMIT) return "length";
  return null;
};

export { checkGameName };
export type { GameNameProblem };
