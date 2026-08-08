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
 * Display aspect ratio per core, as a CSS `aspect-ratio` value. The player box
 * is sized from this so the video fills it; without it the box keeps its own
 * shape and the core letterboxes into the top, leaving the touch controls
 * floating in dead space. These are display ratios, not framebuffer ratios -
 * the NES stores 256x240 but was always shown at 4:3. The DS is the odd one:
 * its two screens stack, so it is the only portrait core here.
 */
const CORE_ASPECT_RATIOS: Readonly<Record<string, string>> = {
  gb: "10 / 9",
  gba: "3 / 2",
  lynx: "80 / 51",
  nds: "2 / 3",
  segaGG: "10 / 9",
};

const DEFAULT_ASPECT_RATIO = "4 / 3";

const getEmulatorJsAspectRatio = (core?: string): string =>
  (core ? CORE_ASPECT_RATIOS[core] : undefined) ?? DEFAULT_ASPECT_RATIO;

const getEmulatorJsCore = (platform?: string, fileName?: string): string | undefined => {
  const platformCore = platform ? PLATFORM_CORES[platform.trim()] : undefined;
  if (platformCore) return platformCore;
  const match = fileName
    ?.trim()
    .toLowerCase()
    .match(/\.[^./]+$/);
  return match ? EXTENSION_CORES[match[0]] : undefined;
};

export { getEmulatorJsAspectRatio, getEmulatorJsCore };
