const PLATFORM_CORES: Readonly<Record<string, string>> = {
  "game-boy": "gb",
  "game-boy-color": "gb",
  gba: "gba",
  nds: "nds",
  snes: "snes",
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
 * libretro `valid_extensions` and reader code: pcsx_rearmed and
 * genesis_plus_gx read `chd`. yabause advertises `chd` but its `ISOCDInit` has
 * no CHD reader and rejects the file as a raw ISO, so a Saturn CHD is
 * extracted first. Every other core needs the disc extracted too - ppsspp
 * accepts only `elf, iso, cso, prx, pbp`, and smsplus no disc image at all.
 */
const CHD_CAPABLE_CORES: ReadonlySet<string> = new Set(["psx", "segaMD"]);

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

/** Save extensions only one system writes; `.sav` and `.srm` are shared by many, so they name no core. */
const SAVE_EXTENSION_CORES: Readonly<Record<string, string>> = {
  ".eep": "n64",
  ".fla": "n64",
  ".mcd": "psx",
  ".mcr": "psx",
  ".mpk": "n64",
  ".sra": "n64",
};

const getSaveFileCore = (fileName: string): string | undefined => {
  const match = fileName
    .trim()
    .toLowerCase()
    .match(/\.[^./]+$/);
  return match ? SAVE_EXTENSION_CORES[match[0]] : undefined;
};

/**
 * Famicom Disk System images run on the nes core (fceumm), which needs the
 * FDS BIOS (`disksys.rom`) the site does not supply. Without it the core
 * crashes the browser tab, so the player must not start; user-provided BIOS
 * files are tracked in rom-weaver/rom-weaver#1223.
 */
const FDS_PLATFORM = "Nintendo Famicom Disk System";
const FDS_BIOS_ISSUE_URL = "https://github.com/rom-weaver/rom-weaver/issues/1223";

const requiresUnsuppliedBios = (game: { fileName?: string; platform?: string }): boolean => {
  if (game.platform?.trim() === FDS_PLATFORM) return true;
  return !!game.fileName && /\.fds$/i.test(game.fileName.trim());
};

const FDS_DISK_SIGNATURE = Array.from("*NINTENDO-HVC*", (char) => char.charCodeAt(0));
const FDS_HEADER_BYTES = 16;

/**
 * Headerless FDS images carry no platform and may have any file name, but every
 * disk side starts with a block-1 marker byte then `*NINTENDO-HVC*`. An optional
 * 16-byte `FDS\x1A` header precedes it.
 */
const hasFdsDiskSignature = async (blob: Blob): Promise<boolean> => {
  const bytes = new Uint8Array(
    await new Response(blob.slice(0, FDS_HEADER_BYTES + 1 + FDS_DISK_SIGNATURE.length)).arrayBuffer(),
  );
  const matchesAt = (offset: number) =>
    bytes[offset] === 1 && FDS_DISK_SIGNATURE.every((byte, index) => bytes[offset + 1 + index] === byte);
  return matchesAt(0) || matchesAt(FDS_HEADER_BYTES);
};

export {
  FDS_BIOS_ISSUE_URL,
  coreReadsChd,
  getEmulatorJsAspectRatio,
  getEmulatorJsCore,
  getSaveFileCore,
  hasFdsDiskSignature,
  requiresUnsuppliedBios,
};
