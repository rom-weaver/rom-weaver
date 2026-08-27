/** Compact platform abbreviations (e.g. "Sony PlayStation" → "PSX"), shared by
 * the ROM type tag and the identify drawer. Keys are matched case-insensitively
 * because identify databases report platforms in upper case. */
const PLATFORM_ABBREVIATIONS: Record<string, string> = {
  "Atari 7800": "A7800",
  "Atari Lynx": "LYNX",
  "NEC PC-Engine CD & TurboGrafx-16 CD": "PCE-CD",
  "Neo Geo Pocket": "NGP",
  "Nintendo 3DS": "3DS",
  "Nintendo 64": "N64",
  "Nintendo DS": "NDS",
  "Nintendo Entertainment System": "NES",
  "Nintendo Famicom Disk System": "FDS",
  "Nintendo Game Boy": "GB",
  "Nintendo Game Boy Advance": "GBA",
  "Nintendo GameCube": "GC",
  "Nintendo Super Nintendo Entertainment System": "SNES",
  "Nintendo Wii": "WII",
  "Sega Dreamcast": "DC",
  "Sega Master System": "SMS",
  "Sega Mega CD _ Sega CD": "SCD",
  "Sega Mega Drive _ Genesis": "GEN",
  "Sega Saturn": "SAT",
  "Sony PlayStation": "PSX",
  "Sony PlayStation 2": "PS2",
  "Sony Playstation Portable": "PSP",
  "TurboGrafx-16_PC Engine": "PCE",
};

const LOWER_CASE_ABBREVIATIONS = new Map(
  Object.entries(PLATFORM_ABBREVIATIONS).map(([name, code]) => [name.toLowerCase(), code]),
);

/** The platform's abbreviation, or the name unchanged when none is known. */
const abbreviatePlatform = (name: string): string => LOWER_CASE_ABBREVIATIONS.get(name.trim().toLowerCase()) ?? name;

export { abbreviatePlatform };
