/** Compact platform abbreviations (e.g. "Sony - PlayStation" → "PSX"), shared by
 * the ROM type tag and the identify drawer. Matching is case-insensitive and
 * ignores punctuation, because identify databases report platforms in upper
 * case and spell them two ways: the libretro form ("Nintendo - Nintendo
 * Entertainment System") and the older OpenGood form ("Nintendo Entertainment
 * System"). Both must reach the same code, or a phone-width drawer shows the
 * full name and pushes its neighbouring chip off screen. */
import { abbreviations } from "../../../../crates/rom-weaver-checksum/src/platform-names.json";

const PLATFORM_ABBREVIATIONS = abbreviations;

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
