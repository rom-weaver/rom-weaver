/** Compact platform abbreviations (e.g. "Sony - PlayStation" → "PSX"), shared by
 * the ROM type tag and the identify drawer. Matching is case-insensitive and
 * ignores punctuation, because identify databases report platforms in upper
 * case and spell them two ways: the libretro form ("Nintendo - Nintendo
 * Entertainment System") and the older OpenGood form ("Nintendo Entertainment
 * System"). Both must reach the same code, or a phone-width drawer shows the
 * full name and pushes its neighbouring chip off screen. */
const PLATFORM_ABBREVIATIONS: Record<string, string> = {
  "Atari 2600": "A2600",
  "Atari 5200": "A5200",
  "Atari 7800": "A7800",
  "Atari Lynx": "LYNX",
  "Microsoft Xbox": "XBOX",
  "NEC PC-Engine CD & TurboGrafx-16 CD": "PCE-CD",
  "Neo Geo Pocket": "NGP",
  "Neo Geo Pocket Color": "NGPC",
  "Nintendo 3DS": "3DS",
  "Nintendo 64": "N64",
  "Nintendo DS": "NDS",
  "Nintendo Entertainment System": "NES",
  "Nintendo Famicom Disk System": "FDS",
  "Nintendo Family Computer Disk System": "FDS",
  "Nintendo Game Boy": "GB",
  "Nintendo Game Boy Advance": "GBA",
  "Nintendo Game Boy Color": "GBC",
  "Nintendo GameCube": "GC",
  "Nintendo Super Nintendo Entertainment System": "SNES",
  "Nintendo Wii": "WII",
  "Nintendo Wii U": "WIIU",
  "PC Engine - TurboGrafx 16": "PCE",
  "PC Engine CD - TurboGrafx-CD": "PCE-CD",
  "Sega 32X": "32X",
  "Sega Dreamcast": "DC",
  "Sega Game Gear": "GG",
  "Sega Master System": "SMS",
  "Sega Mega CD _ Sega CD": "SCD",
  "Sega Mega Drive _ Genesis": "GEN",
  "Sega Mega-CD - Sega CD": "SCD",
  "Sega Saturn": "SAT",
  "Sony PlayStation": "PSX",
  "Sony PlayStation 2": "PS2",
  "Sony PlayStation 3": "PS3",
  "Sony PlayStation Vita": "VITA",
  "Sony Playstation Portable": "PSP",
  "Super Nintendo Entertainment System": "SNES",
  "TurboGrafx-16_PC Engine": "PCE",
  // Libretro keeps its own qualifier on these two, so the vendor-stripped
  // lookup below arrives with the qualifier still attached.
  "Master System - Mark III": "SMS",
  "Mega Drive - Genesis": "GEN",
};

/** Lowercase, punctuation collapsed to single spaces: "Sega - Mega Drive -
 * Genesis" and "Sega Mega Drive _ Genesis" both become one key. */
const normalizePlatformName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const NORMALIZED_ABBREVIATIONS = new Map(
  Object.entries(PLATFORM_ABBREVIATIONS).map(([name, code]) => [normalizePlatformName(name), code]),
);

/** The platform's abbreviation, or the name unchanged when none is known. */
const abbreviatePlatform = (name: string): string => {
  const direct = NORMALIZED_ABBREVIATIONS.get(normalizePlatformName(name));
  if (direct) return direct;
  // Libretro writes "<vendor> - <system>", and the vendor repeats the system
  // name often enough ("Nintendo - Nintendo 64") that the whole string never
  // matches a table key. Retry on the part after the first separator.
  const separator = name.indexOf(" - ");
  if (separator < 0) return name;
  return NORMALIZED_ABBREVIATIONS.get(normalizePlatformName(name.slice(separator + 3))) ?? name;
};

export { abbreviatePlatform };
