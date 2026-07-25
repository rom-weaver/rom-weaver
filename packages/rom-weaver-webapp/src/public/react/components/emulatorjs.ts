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

const getEmulatorJsCore = (platform?: string, fileName?: string): string | undefined => {
  const platformCore = platform ? PLATFORM_CORES[platform.trim()] : undefined;
  if (platformCore) return platformCore;
  const match = fileName
    ?.trim()
    .toLowerCase()
    .match(/\.[^./]+$/);
  return match ? EXTENSION_CORES[match[0]] : undefined;
};

export { getEmulatorJsCore };
