const PLATFORM_CORES: Readonly<Record<string, string>> = {
  "Atari 7800": "atari7800",
  "Atari Lynx": "lynx",
  "Nintendo 64": "n64",
  "Nintendo DS": "nds",
  "Nintendo Entertainment System": "nes",
  "Nintendo Famicom Disk System": "nes",
  "Nintendo Game Boy": "gb",
  "Nintendo Game Boy Advance": "gba",
  "Nintendo Super Nintendo Entertainment System": "snes",
  "Sega Master System": "segaMS",
  "Sega Mega Drive _ Genesis": "segaMD",
  "Sega Saturn": "segaSaturn",
  "Sony PlayStation": "psx",
  "Sony Playstation Portable": "psp",
};

const EXTENSION_CORES: Readonly<Record<string, string>> = {
  ".a78": "atari7800",
  ".fds": "nes",
  ".gb": "gb",
  ".gba": "gba",
  ".gbc": "gb",
  ".gen": "segaMD",
  ".gg": "segaGG",
  ".lnx": "lynx",
  ".md": "segaMD",
  ".n64": "n64",
  ".nds": "nds",
  ".nes": "nes",
  ".sfc": "snes",
  ".smd": "segaMD",
  ".smc": "snes",
  ".sms": "segaMS",
  ".z64": "n64",
};

/**
 * Size the player to the display ratio so touch controls stay near the video.
 * Ratios can differ from framebuffer dimensions; the DS stacks its two screens.
 */
const CORE_ASPECT_RATIOS: Readonly<Record<string, string>> = {
  gb: "10 / 9",
  gba: "3 / 2",
  lynx: "80 / 51",
  nds: "2 / 3",
  psp: "30 / 17",
  segaGG: "10 / 9",
};

const DEFAULT_ASPECT_RATIO = "4 / 3";

const getEmulatorJsAspectRatio = (core?: string): string =>
  (core ? CORE_ASPECT_RATIOS[core] : undefined) ?? DEFAULT_ASPECT_RATIO;

/**
 * The vendored cores that read a CHD themselves, taken from each core's
 * libretro `valid_extensions`: pcsx_rearmed, yabause, and genesis_plus_gx list
 * `chd`. Every other core needs the disc extracted first - ppsspp accepts only
 * `elf, iso, cso, prx, pbp`, and smsplus no disc image at all.
 */
const CHD_CAPABLE_CORES: ReadonlySet<string> = new Set(["psx", "segaMD", "segaSaturn"]);

const coreReadsChd = (core?: string): boolean => !!core && CHD_CAPABLE_CORES.has(core);

const getEmulatorJsCore = (platform?: string, fileName?: string): string | undefined => {
  const normalizedPlatform = platform?.trim();
  if (normalizedPlatform) return PLATFORM_CORES[normalizedPlatform];
  const match = fileName
    ?.trim()
    .toLowerCase()
    .match(/\.[^./]+$/);
  return match ? EXTENSION_CORES[match[0]] : undefined;
};

export { coreReadsChd, getEmulatorJsAspectRatio, getEmulatorJsCore };
