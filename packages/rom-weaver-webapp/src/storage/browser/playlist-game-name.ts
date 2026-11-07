// Characters and names that Windows, macOS, or Linux cannot give a file.
const RESERVED_NAME_CHARACTERS = /[<>:"/\\|?*\p{Cc}]/u;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// File systems limit a name in bytes, not in UTF-16 units. The longest name a rename makes is a
// two-digit disc's two-digit track: `<game> (Disc 99) (Track 99).bin`.
const FILE_NAME_BYTE_LIMIT = 255;
const LONGEST_RENAMED_FILE_SUFFIX = " (Disc 99) (Track 99).bin";
const textEncoder = new TextEncoder();

/** Why a game name cannot name its playlist and renamed discs, or an empty string when it can. */
const checkGameName = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (RESERVED_NAME_CHARACTERS.test(trimmed)) return 'A game name cannot contain < > : " / \\ | ? or *.';
  if (RESERVED_WINDOWS_NAMES.test(trimmed)) return `Windows reserves the name "${trimmed}".`;
  if (trimmed.endsWith(".")) return "A game name cannot end with a dot.";
  if (textEncoder.encode(`${trimmed}${LONGEST_RENAMED_FILE_SUFFIX}`).length > FILE_NAME_BYTE_LIMIT) {
    return "That game name is too long for a file name.";
  }
  return "";
};

export { checkGameName };
