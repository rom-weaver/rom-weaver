#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), "rom-weaver-identify-dats");
const DEFAULT_OUT = path.join(ROOT_DIR, "target/identify");

const PACK_MAGIC = Buffer.from("RWFP4\0\0\0", "binary");
const GAME_CACHE_FORMAT = "rom-weaver-identify-games-v1";
export const PACK_FORMAT = "rom-weaver-identify-system-pack-v4";
export const INDEX_FORMAT = "rom-weaver-identify-system-pack-v1";
export const CATALOG_FORMAT = "rom-weaver-identify-catalog-v1";

// OpenGood publishes GoodTools cartridge sets as CC0 Logiqx XML DATs. It adds
// historical dump variants to matching Libretro packs and owns its standalone packs.
export const OPENGOOD_REPOSITORY = "https://github.com/SnowflakePowered/opengood";
export const OPENGOOD_REVISION = "5cbd95ef3f5904b9e067042ae8dd08a35c39c89a";
export const OPENGOOD_LICENSE = "CC0-1.0";
export const LIBRETRO_REPOSITORY = "https://github.com/libretro/libretro-database";
export const LIBRETRO_REVISION = "69ea62a2823823820d4f121c2b53bf20fd088ab4";
export const LIBRETRO_LICENSE = "CC-BY-SA-4.0";
export const IDENTIFY_GENERATION_DATE = "2026-08-27";
// This is the complete pinned source manifest: the 52 root DATs, 92 No-Intro
// DATs, and 22 Redump DATs. Do not replace it with a live directory listing.
export const LIBRETRO_DAT_PATHS = Object.freeze([
  "dat/Amstrad - CPC.dat",
  "dat/Arduboy Inc - Arduboy.dat",
  "dat/Atomiswave.dat",
  "dat/CHIP-8.dat",
  "dat/Cannonball.dat",
  "dat/Cave Story.dat",
  "dat/ChaiLove.dat",
  "dat/Commodore - Amiga.dat",
  "dat/Commodore - CD32.dat",
  "dat/DICE.dat",
  "dat/DOOM.dat",
  "dat/DOS.dat",
  "dat/Dinothawr.dat",
  "dat/Enterprise - 128.dat",
  "dat/Flashback.dat",
  "dat/HBMAME.dat",
  "dat/Handheld Electronic Game.dat",
  "dat/Infocom - Z-Machine.dat",
  "dat/Jump 'n Bump.dat",
  "dat/LowRes NX.dat",
  "dat/Lutro.dat",
  "dat/MicroW8.dat",
  "dat/Mobile - J2ME.dat",
  "dat/MrBoom.dat",
  "dat/NEC - PC-98.dat",
  "dat/Nintendo - GameCube.dat",
  "dat/Nintendo - Nintendo Entertainment System.dat",
  "dat/Nintendo - Super Nintendo Entertainment System.dat",
  "dat/Nintendo - Wii U.dat",
  "dat/Nintendo - Wii.dat",
  "dat/PICO-8.dat",
  "dat/PuzzleScript.dat",
  "dat/Quake II.dat",
  "dat/Quake III.dat",
  "dat/Quake.dat",
  "dat/RPG Maker.dat",
  "dat/Rick Dangerous.dat",
  "dat/SNK - Neo Geo.dat",
  "dat/ScummVM.dat",
  "dat/Sega - Saturn.dat",
  "dat/Sinclair - ZX 81.dat",
  "dat/Sinclair - ZX Spectrum.dat",
  "dat/Sony - PlayStation 3.dat",
  "dat/Sony - PlayStation Minis.dat",
  "dat/System.dat",
  "dat/TIC-80.dat",
  "dat/Tomb Raider.dat",
  "dat/Uzebox.dat",
  "dat/Videoton - TV-Computer.dat",
  "dat/Vircon32.dat",
  "dat/WASM-4.dat",
  "dat/Wolfenstein 3D.dat",
  "metadat/no-intro/Arduboy Inc - Arduboy.dat",
  "metadat/no-intro/Atari - 2600.dat",
  "metadat/no-intro/Atari - 5200.dat",
  "metadat/no-intro/Atari - 7800.dat",
  "metadat/no-intro/Atari - 8-bit Family.dat",
  "metadat/no-intro/Atari - Jaguar.dat",
  "metadat/no-intro/Atari - Lynx.dat",
  "metadat/no-intro/Atari - ST.dat",
  "metadat/no-intro/Bandai - WonderSwan Color.dat",
  "metadat/no-intro/Bandai - WonderSwan.dat",
  "metadat/no-intro/Benesse - Pocket Challenge V2.dat",
  "metadat/no-intro/Casio - Loopy.dat",
  "metadat/no-intro/Casio - PV-1000.dat",
  "metadat/no-intro/Coleco - ColecoVision.dat",
  "metadat/no-intro/Commodore - 64.dat",
  "metadat/no-intro/Commodore - Amiga.dat",
  "metadat/no-intro/Commodore - Plus-4.dat",
  "metadat/no-intro/Commodore - VIC-20.dat",
  "metadat/no-intro/Emerson - Arcadia 2001.dat",
  "metadat/no-intro/Entex - Adventure Vision.dat",
  "metadat/no-intro/Epoch - Super Cassette Vision.dat",
  "metadat/no-intro/Fairchild - Channel F.dat",
  "metadat/no-intro/Funtech - Super Acan.dat",
  "metadat/no-intro/GCE - Vectrex.dat",
  "metadat/no-intro/GamePark - GP32.dat",
  "metadat/no-intro/Hartung - Game Master.dat",
  "metadat/no-intro/Interton - VC 4000.dat",
  "metadat/no-intro/Konami - Picno.dat",
  "metadat/no-intro/LeapFrog - LeapPad.dat",
  "metadat/no-intro/LeapFrog - Leapster Learning Game System.dat",
  "metadat/no-intro/Magnavox - Odyssey2.dat",
  "metadat/no-intro/Mattel - Intellivision.dat",
  "metadat/no-intro/Microsoft - MSX.dat",
  "metadat/no-intro/Microsoft - MSX2.dat",
  "metadat/no-intro/Microsoft - XBOX 360 (Games on Demand).dat",
  "metadat/no-intro/Microsoft - XBOX 360 (Title Updates).dat",
  "metadat/no-intro/Microsoft - Xbox 360 (Digital).dat",
  "metadat/no-intro/Microsoft - Xbox 360.dat",
  "metadat/no-intro/Mobile - J2ME.dat",
  "metadat/no-intro/Mobile - Palm OS.dat",
  "metadat/no-intro/Mobile - Symbian.dat",
  "metadat/no-intro/Mobile - Zeebo.dat",
  "metadat/no-intro/NEC - PC Engine - TurboGrafx 16.dat",
  "metadat/no-intro/NEC - PC Engine SuperGrafx.dat",
  "metadat/no-intro/Nintendo - Family Computer Disk System.dat",
  "metadat/no-intro/Nintendo - Game Boy Advance.dat",
  "metadat/no-intro/Nintendo - Game Boy Color.dat",
  "metadat/no-intro/Nintendo - Game Boy.dat",
  "metadat/no-intro/Nintendo - New Nintendo 3DS (Digital).dat",
  "metadat/no-intro/Nintendo - New Nintendo 3DS.dat",
  "metadat/no-intro/Nintendo - Nintendo 3DS (Digital).dat",
  "metadat/no-intro/Nintendo - Nintendo 3DS.dat",
  "metadat/no-intro/Nintendo - Nintendo 64.dat",
  "metadat/no-intro/Nintendo - Nintendo 64DD.dat",
  "metadat/no-intro/Nintendo - Nintendo DS (Download Play).dat",
  "metadat/no-intro/Nintendo - Nintendo DS.dat",
  "metadat/no-intro/Nintendo - Nintendo DSi.dat",
  "metadat/no-intro/Nintendo - Nintendo Entertainment System.dat",
  "metadat/no-intro/Nintendo - Pokemon Mini.dat",
  "metadat/no-intro/Nintendo - Satellaview.dat",
  "metadat/no-intro/Nintendo - Sufami Turbo.dat",
  "metadat/no-intro/Nintendo - Super Nintendo Entertainment System.dat",
  "metadat/no-intro/Nintendo - Virtual Boy.dat",
  "metadat/no-intro/Nintendo - Wii (Digital).dat",
  "metadat/no-intro/Nintendo - Wii U (Digital).dat",
  "metadat/no-intro/Nintendo - e-Reader.dat",
  "metadat/no-intro/Philips - Videopac+.dat",
  "metadat/no-intro/RCA - Studio II.dat",
  "metadat/no-intro/SNK - Neo Geo Pocket Color.dat",
  "metadat/no-intro/SNK - Neo Geo Pocket.dat",
  "metadat/no-intro/Sega - 32X.dat",
  "metadat/no-intro/Sega - Beena.dat",
  "metadat/no-intro/Sega - Game Gear.dat",
  "metadat/no-intro/Sega - Master System - Mark III.dat",
  "metadat/no-intro/Sega - Mega Drive - Genesis.dat",
  "metadat/no-intro/Sega - PICO.dat",
  "metadat/no-intro/Sega - SG-1000.dat",
  "metadat/no-intro/Sharp - X1.dat",
  "metadat/no-intro/Sharp - X68000.dat",
  "metadat/no-intro/Sinclair - ZX Spectrum +3.dat",
  "metadat/no-intro/Sony - PlayStation 3 (PSN).dat",
  "metadat/no-intro/Sony - PlayStation Portable (PSN).dat",
  "metadat/no-intro/Sony - PlayStation Portable (PSX2PSP).dat",
  "metadat/no-intro/Sony - PlayStation Portable (UMD Music).dat",
  "metadat/no-intro/Sony - PlayStation Portable.dat",
  "metadat/no-intro/Sony - PlayStation Vita (PSN).dat",
  "metadat/no-intro/Sony - PlayStation Vita.dat",
  "metadat/no-intro/Tiger - Game.com.dat",
  "metadat/no-intro/VTech - CreatiVision.dat",
  "metadat/no-intro/VTech - V.Smile.dat",
  "metadat/no-intro/Watara - Supervision.dat",
  "metadat/no-intro/Sony - PlayStation Portable (UMD Video).dat",
  "metadat/redump/Atari - Jaguar CD.dat",
  "metadat/redump/Commodore - CD32.dat",
  "metadat/redump/Commodore - CDTV.dat",
  "metadat/redump/Microsoft - Xbox 360.dat",
  "metadat/redump/Microsoft - Xbox.dat",
  "metadat/redump/NEC - PC Engine CD - TurboGrafx-CD.dat",
  "metadat/redump/NEC - PC-98.dat",
  "metadat/redump/NEC - PC-FX.dat",
  "metadat/redump/Nintendo - GameCube.dat",
  "metadat/redump/Nintendo - Wii.dat",
  "metadat/redump/Philips - CD-i.dat",
  "metadat/redump/SNK - Neo Geo CD.dat",
  "metadat/redump/Sega - Dreamcast.dat",
  "metadat/redump/Sega - Mega-CD - Sega CD.dat",
  "metadat/redump/Sega - Naomi 2.dat",
  "metadat/redump/Sega - Naomi.dat",
  "metadat/redump/Sega - Saturn.dat",
  "metadat/redump/Sony - PlayStation 2.dat",
  "metadat/redump/Sony - PlayStation 3.dat",
  "metadat/redump/Sony - PlayStation Portable.dat",
  "metadat/redump/Sony - PlayStation.dat",
  "metadat/redump/The 3DO Company - 3DO.dat",
]);

const SOURCE_PLATFORM_PATHS = Object.freeze(
  Object.fromEntries(
    [...new Set(LIBRETRO_DAT_PATHS.map((sourcePath) => path.basename(sourcePath, ".dat")))]
      .sort()
      .map((platform) => [
        platform,
        LIBRETRO_DAT_PATHS.filter(
          (sourcePath) => path.basename(sourcePath, ".dat") === platform,
        ).sort(
          (left, right) =>
            Number(left.startsWith("dat/")) - Number(right.startsWith("dat/")) ||
            (left < right ? -1 : left > right ? 1 : 0),
        ),
      ]),
  ),
);

export const PACK_FAMILY_TARGETS = Object.freeze({
  "NEC - PC Engine SuperGrafx": "NEC - PC Engine - TurboGrafx 16",
  "Nintendo - New Nintendo 3DS": "Nintendo - Nintendo 3DS",
  "Nintendo - New Nintendo 3DS (Digital)": "Nintendo - Nintendo 3DS",
  "Nintendo - Nintendo 3DS (Digital)": "Nintendo - Nintendo 3DS",
  "Nintendo - Nintendo 64DD": "Nintendo - Nintendo 64",
  "Nintendo - Nintendo DS (Download Play)": "Nintendo - Nintendo DS",
  "Nintendo - Nintendo DSi": "Nintendo - Nintendo DS",
  "Nintendo - Satellaview": "Nintendo - Super Nintendo Entertainment System",
  "Nintendo - Sufami Turbo": "Nintendo - Super Nintendo Entertainment System",
  "Nintendo - Wii (Digital)": "Nintendo - Wii",
  "Nintendo - e-Reader": "Nintendo - Game Boy Advance",
  "Sony - PlayStation Minis": "Sony - PlayStation Portable",
  "Sony - PlayStation Portable (PSN)": "Sony - PlayStation Portable",
  "Sony - PlayStation Portable (PSX2PSP)": "Sony - PlayStation Portable",
  "Sony - PlayStation Portable (UMD Music)": "Sony - PlayStation Portable",
  "Sony - PlayStation Portable (UMD Video)": "Sony - PlayStation Portable",
});

export const LIBRETRO_PLATFORM_PATHS = Object.freeze(
  Object.fromEntries(
    Object.entries(SOURCE_PLATFORM_PATHS).reduce((entries, [platform, sourcePaths]) => {
      const target = PACK_FAMILY_TARGETS[platform] ?? platform;
      const existing = entries.get(target) ?? [];
      existing.push(...sourcePaths);
      entries.set(target, existing);
      return entries;
    }, new Map()),
  ),
);

// OpenGood names its historical sets differently. A fallback is only merged
// into its listed Libretro platform; no OpenGood DAT builds a duplicate pack.
export const OPENGOOD_FALLBACKS = Object.freeze({
  "Amstrad - CPC": ["OpenCPC.dat"],
  "Nintendo - Nintendo Entertainment System": ["OpenNES.dat"],
  "Nintendo - Super Nintendo Entertainment System": ["OpenSNES.SNES.dat"],
});

// Original OpenGood aggregate DATs. Keep these separate from their split DATs
// so a complete fallback never duplicates one component in two platform packs.
export const OPENGOOD_ONLY_PLATFORMS = Object.freeze({
  "Atari - 2600": ["Open2600.dat"],
  "Atari - 5200": ["Open5200.dat"],
  "Atari - 7800": ["Open7800.dat"],
  "Fairchild - Channel F": ["OpenChaF.dat"],
  "Tandy - Color Computer": ["OpenCoCo.dat"],
  "Coleco - ColecoVision": ["OpenCol.dat"],
  "Commodore - 64": ["OpenGB64.dat"],
  "Nintendo - Game Boy Advance": ["OpenGBA.GBA.dat"],
  "Nintendo - Game Boy Advance Multiboot": ["OpenGBA.MB.dat"],
  "Nintendo - e-Reader": ["OpenGBA.E+.dat"],
  "Nintendo - Game Boy": ["OpenGBx.GB.dat"],
  "Nintendo - Game Boy Color": ["OpenGBx.GBC.dat"],
  "Tiger - Game.com": ["OpenGCOM.dat"],
  "Sega - Game Gear": ["OpenGG.dat"],
  "Sega - Mega Drive and Genesis": ["OpenGen.Gen.dat"],
  "Sega - 32X": ["OpenGen.32X.dat"],
  "Mattel - Intellivision": ["OpenINTV.dat"],
  "Atari - Jaguar": ["OpenJag.dat"],
  "Atari - Lynx": ["OpenLynx.dat"],
  "Thomson - MO5": ["OpenMO5.dat"],
  "Microsoft - MSX": ["OpenMSX1.dat"],
  "Microsoft - MSX2": ["OpenMSX2.dat"],
  "Memotech - MTX": ["OpenMTX.dat"],
  "Nintendo - Nintendo 64": ["OpenN64.N64.dat"],
  "Nintendo - Nintendo 64DD": ["OpenN64.64DD.dat"],
  "SNK - Neo Geo Pocket": ["OpenNGPx.NGP.dat"],
  "SNK - Neo Geo Pocket Color": ["OpenNGPx.NGC.dat"],
  "Tangerine - Oric": ["OpenOric.dat"],
  "NEC - PC Engine and TurboGrafx-16": ["OpenPCE.dat"],
  "Commodore - PSID": ["OpenPSID.dat"],
  "Sega - Pico": ["OpenPico.dat"],
  "SAM Coupé": ["OpenSAMC.dat"],
  "Sega - Master System": ["OpenSMS.dat"],
  "Super Nintendo Entertainment System - SPC Music": ["OpenSPC.dat"],
  "Watara - Supervision": ["OpenSV.dat"],
  "Nintendo - Virtual Boy": ["OpenVBoy.dat"],
  "GCE - Vectrex": ["OpenVECT.dat"],
  "Nintendo - Satellaview": ["OpenSNES.BS.dat"],
  "Nintendo - Sufami Turbo": ["OpenSNES.ST.dat"],
  "Bandai - WonderSwan": ["OpenWSx.WS.dat"],
  "Bandai - WonderSwan Color": ["OpenWSx.WSC.dat"],
});

const OPENGOOD_LIBRETRO_TARGETS = Object.freeze({
  "NEC - PC Engine and TurboGrafx-16": "NEC - PC Engine - TurboGrafx 16",
  "Sega - Master System": "Sega - Master System - Mark III",
  "Sega - Mega Drive and Genesis": "Sega - Mega Drive - Genesis",
  "Sega - Pico": "Sega - PICO",
  "Nintendo - Game Boy Advance Multiboot": "Nintendo - Game Boy Advance",
  "Nintendo - Nintendo 64DD": "Nintendo - Nintendo 64DD",
});

function openGoodTarget(platform) {
  const target = PACK_FAMILY_TARGETS[platform] ?? OPENGOOD_LIBRETRO_TARGETS[platform] ?? platform;
  return LIBRETRO_PLATFORM_PATHS[target] ? target : undefined;
}

const GENERATED_OPENGOOD_FALLBACKS = Object.entries(OPENGOOD_ONLY_PLATFORMS).reduce(
  (fallbacks, [platform, files]) => {
    const target = openGoodTarget(platform);
    if (target) fallbacks[target] = [...(fallbacks[target] ?? []), ...files];
    return fallbacks;
  },
  { ...OPENGOOD_FALLBACKS },
);

export const COMPLETE_OPENGOOD_FALLBACKS = Object.freeze(
  Object.fromEntries(
    Object.entries(GENERATED_OPENGOOD_FALLBACKS).map(([platform, files]) => [
      platform,
      [...files].sort(),
    ]),
  ),
);

export const OPENGOOD_STANDALONE_PLATFORMS = Object.freeze(
  Object.fromEntries(
    Object.entries(OPENGOOD_ONLY_PLATFORMS).filter(([platform]) => !openGoodTarget(platform)),
  ),
);

export function slugifyPlatform(platform) {
  return platform
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

// Curated media-profile hints for known platform names. This map MUST NOT gate
// which platforms build. Unknown platforms get the default profile below.
export const DEFAULT_MEDIA_PROFILE = "libretro-clrmamepro-v1";
export const KNOWN_PLATFORM_PROFILES = Object.freeze({
  "Nintendo - GameCube": "gamecube-decoded-iso-v1",
  "Nintendo - Wii": "wii-decoded-iso-v1",
});

// Curated alias table, keyed by canonical platform name. Alias matching is
// case-insensitive after normalizing: lowercase, collapse [^a-z0-9]+ to one
// space, trim. A platform's own normalized name always wins over another
// platform's curated alias (e.g. a discovered "GBA" dump directory claims
// "gba"); a collision between two platforms' own names is a build error.
export const CURATED_ALIASES = Object.freeze({
  "Nintendo - Family Computer Disk System": ["fds", "famicom disk system", "nintendo fds"],
  "SNK - Neo Geo Pocket": ["neo geo pocket", "ngp"],
  "SNK - Neo Geo Pocket Color": ["neo geo pocket color", "ngpc"],
  "Nintendo - Nintendo 3DS": ["nintendo 3ds", "3ds"],
  "Nintendo - Nintendo DS": ["nintendo ds", "nds", "ds"],
  "Nintendo - Nintendo Entertainment System": [
    "nintendo entertainment system",
    "nes",
    "famicom",
    "family computer",
  ],
  "Nintendo - Game Boy": ["nintendo game boy", "game boy", "gb"],
  "Nintendo - Game Boy Advance": ["nintendo game boy advance", "game boy advance", "gba"],
  "Nintendo - Game Boy Color": ["nintendo game boy color", "game boy color", "gbc"],
  "Nintendo - GameCube": ["nintendo gamecube", "gamecube", "gc", "ngc"],
  "Nintendo - Super Nintendo Entertainment System": [
    "nintendo super nintendo entertainment system",
    "snes",
    "super famicom",
    "super nintendo",
  ],
  "Nintendo - Wii": ["nintendo wii", "wii"],
  "Sega - Game Gear": ["sega game gear", "game gear", "gg"],
  "Sega - Master System - Mark III": ["sega master system", "master system", "sms"],
  "Sega - Mega Drive - Genesis": [
    "genesis",
    "mega drive",
    "megadrive",
    "sega genesis",
    "sega mega drive",
  ],
  "Sony - PlayStation": ["sony playstation", "playstation", "psx", "ps1"],
  "Sony - PlayStation 2": ["sony playstation 2", "ps2", "playstation 2"],
  "Sony - PlayStation Portable": ["sony playstation portable", "psp", "playstation portable"],
  "NEC - PC Engine - TurboGrafx 16": [
    "turbografx-16 pc engine",
    "turbografx",
    "turbografx 16",
    "pc engine",
  ],
});

export const DEFAULT_PACK_PLATFORMS = Object.freeze([
  "Atari - 2600",
  "Atari - 5200",
  "Atari - 7800",
  "Atari - Lynx",
  "LowRes NX",
  "NEC - PC Engine - TurboGrafx 16",
  "NEC - PC Engine CD - TurboGrafx-CD",
  "Nintendo - Family Computer Disk System",
  "Nintendo - Game Boy",
  "Nintendo - Game Boy Advance",
  "Nintendo - Game Boy Color",
  "Nintendo - GameCube",
  "Nintendo - Nintendo 3DS",
  "Nintendo - Nintendo 64",
  "Nintendo - Nintendo DS",
  "Nintendo - Nintendo Entertainment System",
  "Nintendo - Super Nintendo Entertainment System",
  "Nintendo - Wii",
  "SNK - Neo Geo Pocket",
  "SNK - Neo Geo Pocket Color",
  "Sega - 32X",
  "Sega - Dreamcast",
  "Sega - Game Gear",
  "Sega - Master System - Mark III",
  "Sega - Mega Drive - Genesis",
  "Sega - Mega-CD - Sega CD",
  "Sega - Saturn",
  "Sony - PlayStation",
  "Sony - PlayStation 2",
  "Sony - PlayStation Portable",
]);

const DEFAULT_PACK_SET = new Set(DEFAULT_PACK_PLATFORMS);
const COMPUTER_PACK_PATTERN =
  /^(?:Amstrad|Commodore|DOS$|Enterprise|Memotech|Microsoft - MSX|SAM Coupé|Sharp|Sinclair|Tandy|Tangerine|Thomson|Videoton)|^Atari - (?:8-bit Family|ST$)/u;
export const packGroupFor = (platform) => {
  if (DEFAULT_PACK_SET.has(platform)) return "default";
  if (COMPUTER_PACK_PATTERN.test(platform)) return "optional-computers";
  if (/^(?:MicroW8|PICO-8|TIC-80|WASM-4)$/u.test(platform)) return "optional-fantasy";
  if (/Mobile|Palm OS|J2ME|Symbian|Zeebo/u.test(platform)) return "optional-mobile";
  if (/HBMAME|Atomiswave|Naomi|Arcade|Neo Geo$/u.test(platform)) return "optional-arcade";
  if (
    /DOOM|Quake|ScummVM|Cave Story|Cannonball|Dinothawr|Flashback|Lutro|MrBoom|PuzzleScript|RPG Maker|Rick Dangerous|Tomb Raider|Wolfenstein/u.test(
      platform,
    )
  )
    return "optional-engines";
  return "optional-extended";
};

export function normalizeAlias(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

const usage = () => `Build per-system RWFP4 ROM-identify packs from pinned Libretro DATs.
Mapped OpenGood records add legacy variants. index.json and catalog.json are
written next to the packs.

Usage:
  node scripts/build-identify-index.mjs
  node scripts/build-identify-index.mjs --only "Nintendo - Nintendo Entertainment System"

Options:
  --out <dir>              Output directory for per-system packs. Defaults to ${DEFAULT_OUT}
  --only <platforms>       Comma-separated platform name(s) to build (repeatable).
  --cache-dir <path>       Download and game-cache directory. Defaults to ${DEFAULT_CACHE_DIR}
  --force-row-cache        Rebuild the per-system game cache even if it matches.
  --download-only          Download/resolve sources, then stop.
  --no-brotli              Do not emit <pack>.br files.
  --brotli-quality <n>     Brotli quality 0-11. Defaults to 11.
  --max-objects <n>        Parse only the first n games per system (smoke tests).
  --allow-missing-platforms
                          Skip unknown requested platforms.
  --print-platforms        Print supported platforms with their source.
  --help                   Show this help.
`;

function parseArgs(argv) {
  const options = {
    allowMissingPlatforms: false,
    brotli: true,
    brotliQuality: 11,
    cacheDir: process.env.ROM_WEAVER_IDENTIFY_CACHE_DIR || DEFAULT_CACHE_DIR,
    downloadOnly: false,
    forceRowCache: false,
    maxObjects: undefined,
    only: [],
    outPath: DEFAULT_OUT,
    printPlatforms: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };

    if (arg === "--cache-dir") options.cacheDir = readValue();
    else if (arg === "--out") options.outPath = readValue();
    else if (arg === "--only") {
      for (const name of readValue().split(",")) {
        const trimmed = name.trim();
        if (trimmed) options.only.push(trimmed);
      }
    } else if (arg === "--force-row-cache") options.forceRowCache = true;
    else if (arg === "--download-only") options.downloadOnly = true;
    else if (arg === "--no-brotli") options.brotli = false;
    else if (arg === "--allow-missing-platforms") options.allowMissingPlatforms = true;
    else if (arg === "--print-platforms") options.printPlatforms = true;
    else if (arg === "--brotli-quality") options.brotliQuality = Number.parseInt(readValue(), 10);
    else if (arg === "--max-objects") options.maxObjects = Number.parseInt(readValue(), 10);
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (
    !Number.isInteger(options.brotliQuality) ||
    options.brotliQuality < 0 ||
    options.brotliQuality > 11
  ) {
    throw new Error("--brotli-quality must be an integer from 0 through 11");
  }
  if (
    options.maxObjects !== undefined &&
    (!Number.isInteger(options.maxObjects) || options.maxObjects < 1)
  ) {
    throw new Error("--max-objects must be a positive integer");
  }
  return options;
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString("en-US")} bytes (${(bytes / (1024 * 1024)).toFixed(2)} MiB)`;
}

function requireExecutable(name) {
  const check = spawnSync("sh", ["-lc", `command -v ${name}`], { stdio: "ignore" });
  if (check.status !== 0) throw new Error(`Required executable not found on PATH: ${name}`);
}

async function fileStat(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

async function runCurl(url, outputPath, expectedBytes) {
  const maxTimeSeconds = Math.max(900, Math.ceil(Number(expectedBytes || 0) / (384 * 1024)));
  const curl = spawn("curl", [
    "--fail",
    "--http1.1",
    "--location",
    "--show-error",
    "--silent",
    "--retry",
    "5",
    "--retry-all-errors",
    "--connect-timeout",
    "20",
    "--continue-at",
    "-",
    "--max-time",
    String(maxTimeSeconds),
    "--speed-limit",
    "32768",
    "--speed-time",
    "60",
    "--output",
    outputPath,
    url,
  ]);

  let stderr = "";
  curl.stderr.setEncoding("utf8");
  curl.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise((resolve, reject) => {
    curl.on("error", reject);
    curl.on("close", resolve);
  });
  if (exitCode !== 0) throw new Error(`curl failed with exit code ${exitCode}: ${stderr.trim()}`);
}

async function runCommandText(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0)
    throw new Error(`${command} failed with exit code ${exitCode}: ${stderr.trim()}`);
  return stdout;
}

async function ensureArchiveFiles({
  archiveUrl,
  cacheDir,
  label,
  prefix,
  requestedPaths,
  revision,
}) {
  const sourceRoot = path.join(cacheDir, label, revision);
  const expected = requestedPaths.map((sourcePath) => ({
    sourcePath,
    target: path.join(sourceRoot, sourcePath),
  }));
  const missing = [];
  for (const entry of expected) {
    const info = await fileStat(entry.target);
    if (!info?.isFile() || info.size === 0) missing.push(entry);
  }
  if (missing.length) {
    const archiveDir = path.join(cacheDir, label);
    const archive = path.join(archiveDir, `${revision}.tar.gz`);
    await mkdir(archiveDir, { recursive: true });
    const archiveInfo = await fileStat(archive);
    if (!archiveInfo?.isFile() || archiveInfo.size === 0) {
      await runCurl(archiveUrl, `${archive}.part`, undefined);
      await rename(`${archive}.part`, archive);
    }
    await mkdir(sourceRoot, { recursive: true });
    await runCommandText("tar", [
      "-xzf",
      archive,
      "-C",
      sourceRoot,
      "--strip-components=1",
      ...missing.map((entry) => `${prefix}/${entry.sourcePath}`),
    ]);
  }
  const result = new Map();
  for (const entry of expected) {
    const info = await fileStat(entry.target);
    if (!info?.isFile() || info.size === 0) {
      throw new Error(`${label} archive is missing expected DAT: ${entry.sourcePath}`);
    }
    result.set(entry.sourcePath, entry.target);
  }
  return result;
}

async function ensureLibretroDats(sourcePaths, cacheDir) {
  return ensureArchiveFiles({
    archiveUrl: `${LIBRETRO_REPOSITORY}/archive/${LIBRETRO_REVISION}.tar.gz`,
    cacheDir,
    label: "libretro",
    prefix: `libretro-database-${LIBRETRO_REVISION}`,
    requestedPaths: sourcePaths,
    revision: LIBRETRO_REVISION,
  });
}

async function ensureOpenGoodDats(datFiles, cacheDir) {
  const sourcePaths = datFiles.map((datFile) => `dats/${datFile}`);
  const paths = await ensureArchiveFiles({
    archiveUrl: `${OPENGOOD_REPOSITORY}/archive/${OPENGOOD_REVISION}.tar.gz`,
    cacheDir,
    label: "opengood",
    prefix: `opengood-${OPENGOOD_REVISION}`,
    requestedPaths: sourcePaths,
    revision: OPENGOOD_REVISION,
  });
  return new Map(datFiles.map((datFile) => [datFile, paths.get(`dats/${datFile}`)]));
}

export async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function normalizeHex(value, expectedLength) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized.length !== expectedLength) return "";
  return /^[0-9a-f]+$/u.test(normalized) ? normalized : "";
}

const XML_ENTITIES = Object.freeze({ amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' });

function xmlUnescape(value) {
  return value.replace(/&(amp|apos|gt|lt|quot|#x?[0-9a-fA-F]+);/gu, (match, entity) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

function parseAttributes(tag) {
  const attributes = {};
  const matcher = /([\w-]+)\s*=\s*"([^"]*)"/gu;
  let match = matcher.exec(tag);
  while (match) {
    attributes[match[1]] = xmlUnescape(match[2]);
    match = matcher.exec(tag);
  }
  return attributes;
}

function unescapeClrMamePro(value) {
  return value.replace(/\\(.)/gu, "$1");
}

// ClrMamePro DATs are a small parenthesized language. Tokenizing instead of
// splitting on `game (` preserves quoted parentheses and nested `rom` blocks.
export function parseClrMameProDat(text) {
  const tokens = [];
  const token = /\s+|;[^\r\n]*|\(|\)|"(?:\\.|[^"\\])*"|[^\s()]+/gu;
  let match = token.exec(text);
  while (match) {
    const value = match[0];
    if (!/^\s+$/u.test(value) && !value.startsWith(";")) tokens.push(value);
    match = token.exec(text);
  }

  let index = 0;
  const scalar = (value) =>
    value?.startsWith('"') ? unescapeClrMamePro(value.slice(1, -1)) : value;
  const parseBlock = (kind) => {
    const fields = {};
    const children = [];
    while (index < tokens.length && tokens[index] !== ")") {
      const key = tokens[index++];
      if (tokens[index] === "(") {
        index += 1;
        children.push({ kind: key, ...parseBlock(key) });
        continue;
      }
      const value = scalar(tokens[index++]);
      if (value !== undefined) fields[key] = value;
    }
    if (tokens[index] === ")") index += 1;
    return { children, fields, kind };
  };

  const blocks = [];
  while (index < tokens.length) {
    const kind = tokens[index++];
    if (tokens[index] !== "(") continue;
    index += 1;
    blocks.push(parseBlock(kind));
  }
  const header = blocks.find((block) => block.kind === "clrmamepro")?.fields ?? {};
  const games = blocks
    .filter((block) => block.kind === "game" || block.kind === "machine")
    .map((block) => ({
      metadata: block.fields,
      name: String(block.fields.name ?? "").trim(),
      roms: block.children.filter((child) => child.kind === "rom").map((child) => child.fields),
    }))
    .filter((game) => game.name && game.roms.length > 0);
  return { games, header };
}

export function extractGoodToolsDumpTags(name) {
  return [...String(name).matchAll(/\[([^\]]+)\]/gu)].map((match) => match[1]);
}

function componentFromRom(rom, ordinal, source = "libretro") {
  // Redump lists CD/GD-ROM games as per-track files (.bin/.raw) but DVD-era
  // games (GameCube, Wii, PS2, Xbox, PSP) as one whole .iso. The runtime hashes
  // a track file with track_file scope and a lone .iso as one full_file
  // payload, and the matcher rejects on scope, so the pack MUST mirror that
  // split per rom - a platform-wide scope breaks one medium or the other.
  const romName = String(rom.name ?? "").trim();
  const isTrackFile = source === "redump" && !/\.iso$/iu.test(romName);
  const component = {
    hashScope: isTrackFile ? "track_file" : "full_file",
    ordinal,
    size: /^\d+$/u.test(String(rom.size ?? "")) ? Number.parseInt(rom.size, 10) : 0,
  };
  if (isTrackFile) {
    component.role = "data_track";
    component.track = ordinal + 1;
  }
  const filename = romName;
  if (filename) component.filename = filename;
  for (const [field, length] of Object.entries({ crc32: 8, md5: 32, sha1: 40 })) {
    const hash = normalizeHex(rom[field === "crc32" ? "crc" : field], length);
    if (hash) component[field] = hash;
  }
  return component;
}

function sourceProvenance(name, url, commit, license, generationDate) {
  const provenance = {
    license,
    source: name,
    sourceCommit: commit,
    sourceName: name,
    sourceUrl: url,
  };
  if (generationDate) provenance.generationDate = generationDate;
  return provenance;
}

function innerLibretroSource(sourcePath) {
  if (sourcePath.startsWith("metadat/no-intro/")) return "no-intro";
  if (sourcePath.startsWith("metadat/redump/")) return "redump";
  return "libretro";
}

export function parseLibretroGames(text, platform, sourcePath) {
  const parsed = parseClrMameProDat(text);
  const innerSource = innerLibretroSource(sourcePath);
  const componentSource = innerSource;
  const provenance = sourceProvenance(
    innerSource,
    `${LIBRETRO_REPOSITORY}/blob/${LIBRETRO_REVISION}/${sourcePath.split("/").map(encodeURIComponent).join("/")}`,
    LIBRETRO_REVISION,
    LIBRETRO_LICENSE,
    parsed.header.date,
  );
  return {
    header: parsed.header,
    games: parsed.games
      .map((game) => ({
        components: game.roms
          .map((rom, ordinal) => componentFromRom(rom, ordinal, componentSource))
          .filter((component) => component.crc32 || component.md5 || component.sha1),
        description: game.metadata.description,
        dumpTags: [],
        legacyVariant: false,
        language: game.metadata.language,
        metadata: game.metadata,
        name: game.name,
        parent: game.metadata.cloneof ?? game.metadata.romof,
        platform,
        provenance: [provenance],
        region: game.metadata.region,
        revision: game.metadata.version ?? game.metadata.release,
        source: "libretro",
        upstreamSource: innerSource,
      }))
      .filter((game) => game.components.length > 0),
  };
}

export function parseOpenGoodGames(text, platform, datFile) {
  const headerMatch = text.match(/<header>([\s\S]*?)<\/header>/u);
  const header = {};
  if (headerMatch) {
    for (const match of headerMatch[1].matchAll(/<([\w-]+)>([^<]*)<\/\1>/gu)) {
      header[match[1]] = xmlUnescape(match[2]).trim();
    }
  }
  const provenance = sourceProvenance(
    "SnowflakePowered/opengood",
    `${OPENGOOD_REPOSITORY}/blob/${OPENGOOD_REVISION}/dats/${encodeURIComponent(datFile)}`,
    OPENGOOD_REVISION,
    OPENGOOD_LICENSE,
    header.date,
  );
  const games = [];
  for (const chunk of text.split(/<game\b/gu).slice(1)) {
    const end = chunk.indexOf(">");
    if (end < 0) continue;
    const game = parseAttributes(chunk.slice(0, end));
    const name = String(game.name ?? "").trim();
    if (!name) continue;
    const components = [];
    for (const match of chunk.matchAll(/<rom\b([^>]*?)\/?>/gu)) {
      const component = componentFromRom(parseAttributes(match[1]), components.length);
      if (component.crc32 || component.md5 || component.sha1) components.push(component);
    }
    if (components.length) {
      games.push({
        components,
        dumpTags: extractGoodToolsDumpTags(name),
        legacyVariant: true,
        name,
        platform,
        provenance: [provenance],
        source: "opengood",
        upstreamSource: "open-good",
      });
    }
  }
  return { games, header };
}

function componentKeys(component) {
  const scope = component.hashScope ?? "full_file";
  return ["crc32", "md5", "sha1"]
    .filter((algorithm) => component[algorithm])
    .map((algorithm) => `${algorithm}\0${component[algorithm]}\0${component.size}\0${scope}`);
}

function mergeProvenance(left, right) {
  const values = [...left, ...right];
  const seen = new Set();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A matching hash under the same algorithm, byte size, and hash scope proves
// that an OpenGood component is already represented by the Libretro record.
export function mergeLegacyFallbackGames(libretroGames, openGoodGames) {
  const merged = libretroGames.map((game) => ({ ...game, components: [...game.components] }));
  const owners = new Map();
  const addOwner = (game, component) => {
    for (const key of componentKeys(component)) owners.set(key, game);
  };
  for (const game of merged) for (const component of game.components) addOwner(game, component);

  for (const fallback of openGoodGames) {
    const owner = fallback.components
      .flatMap(componentKeys)
      .map((key) => owners.get(key))
      .find(Boolean);
    if (!owner) {
      const copy = { ...fallback, components: [...fallback.components] };
      merged.push(copy);
      for (const component of copy.components) addOwner(copy, component);
      continue;
    }
    owner.provenance = mergeProvenance(owner.provenance, fallback.provenance);
    owner.dumpTags = [...new Set([...owner.dumpTags, ...fallback.dumpTags])].sort();
    for (const component of fallback.components) {
      if (componentKeys(component).some((key) => owners.has(key))) continue;
      owner.components.push({ ...component, ordinal: owner.components.length });
      addOwner(owner, owner.components.at(-1));
    }
  }
  return merged;
}

// Libretro's root `dat/` files have precedence over metadata DATs. A root
// component that matches by the same scoped hash replaces the lower-priority
// record's descriptive fields while retaining any non-overlapping components.
export function mergeLibretroGames(lowerPriorityGames, higherPriorityGames) {
  const merged = lowerPriorityGames.map((game) => ({ ...game, components: [...game.components] }));
  const owners = new Map();
  for (const game of merged) {
    for (const component of game.components)
      for (const key of componentKeys(component)) owners.set(key, game);
  }
  for (const game of higherPriorityGames) {
    const owner = game.components
      .flatMap(componentKeys)
      .map((key) => owners.get(key))
      .find(Boolean);
    if (!owner) {
      const copy = { ...game, components: [...game.components] };
      merged.push(copy);
      for (const component of copy.components)
        for (const key of componentKeys(component)) owners.set(key, copy);
      continue;
    }
    const retained = owner.components.filter(
      (component) =>
        !componentKeys(component).some((key) =>
          game.components.flatMap(componentKeys).includes(key),
        ),
    );
    Object.assign(owner, game, {
      components: [
        ...game.components.map((component, ordinal) => ({ ...component, ordinal })),
        ...retained.map((component, ordinal) => ({
          ...component,
          ordinal: game.components.length + ordinal,
        })),
      ],
      provenance: mergeProvenance(game.provenance, owner.provenance),
    });
    for (const component of owner.components)
      for (const key of componentKeys(component)) owners.set(key, owner);
  }
  return merged;
}

function redumpGameRecord(chunk, platform) {
  const headerEnd = chunk.indexOf(">");
  if (headerEnd < 0) return undefined;
  const game = parseAttributes(chunk.slice(0, headerEnd));
  const gameName = String(game.name || "").trim();
  if (!gameName) return undefined;

  const components = [];
  const romMatcher = /<rom\b([^>]*?)\/?>/gu;
  let romMatch = romMatcher.exec(chunk);
  while (romMatch) {
    const rom = parseAttributes(romMatch[1]);
    const component = {
      ordinal: components.length,
      size: /^\d+$/u.test(rom.size || "") ? Number.parseInt(rom.size, 10) : 0,
    };
    const filename = String(rom.name || "").trim();
    if (filename) component.filename = filename;
    const crc32 = normalizeHex(rom.crc, 8);
    const md5 = normalizeHex(rom.md5, 32);
    const sha1 = normalizeHex(rom.sha1, 40);
    if (crc32) component.crc32 = crc32;
    if (md5) component.md5 = md5;
    if (sha1) component.sha1 = sha1;
    if (crc32 || md5 || sha1) components.push(component);
    romMatch = romMatcher.exec(chunk);
  }
  if (components.length === 0) return undefined;

  return {
    name: gameName,
    platform,
    upstreamSource: "redump",
    components,
  };
}

async function datFingerprint(datPath) {
  const info = await stat(datPath);
  return {
    fileName: path.basename(datPath),
    mtimeMs: Math.trunc(info.mtimeMs),
    sizeBytes: info.size,
  };
}

function platformGamePaths(cacheDir, slug) {
  const dir = path.join(cacheDir, "identify-games");
  return {
    dir,
    gamesPath: path.join(dir, `${slug}.jsonl`),
    manifestPath: path.join(dir, `${slug}.manifest.json`),
  };
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

async function produceRedumpGames(platform, state, ctx) {
  const text = await runCommandText("unzip", ["-p", ctx.redumpPaths.get(platform)]);
  const gameChunks = text.split(/<game\b/u);
  for (let index = 1; index < gameChunks.length; index += 1) {
    state.jsonObjects += 1;
    if (state.maxObjects && state.jsonObjects > state.maxObjects) break;
    const record = redumpGameRecord(gameChunks[index], platform);
    if (!record) continue;
    state.games += 1;
    state.components += record.components.length;
    if (!state.stream.write(`${JSON.stringify(record)}\n`)) {
      await once(state.stream, "drain");
    }
  }
}

// Build (or reuse a cached) grouped games.jsonl for a single Redump platform:
// one JSON game record per line, components preserved with their dump order.
export async function buildPlatformGames(platform, ctx) {
  const slug = slugifyPlatform(platform);
  const paths = platformGamePaths(ctx.cacheDir, slug);
  const fingerprint = await datFingerprint(ctx.redumpPaths.get(platform));

  const gamesStat = await fileStat(paths.gamesPath);
  const manifest = await readJsonFile(paths.manifestPath);
  if (
    gamesStat?.isFile() &&
    !ctx.forceRowCache &&
    manifest?.format === GAME_CACHE_FORMAT &&
    manifest.source === "redump" &&
    manifest.maxObjects === (ctx.maxObjects ?? null) &&
    JSON.stringify(manifest.fingerprint) === JSON.stringify(fingerprint)
  ) {
    console.error(`[identify] ${platform}: using cached games (${formatBytes(gamesStat.size)})`);
    return { ...paths, manifest, slug, source: "redump" };
  }

  await mkdir(paths.dir, { recursive: true });
  const tempGamesPath = `${paths.gamesPath}.part`;
  const stream = createWriteStream(tempGamesPath);
  const state = {
    components: 0,
    games: 0,
    jsonObjects: 0,
    maxObjects: ctx.maxObjects,
    stopParsing: false,
    stream,
  };

  console.error(`[identify] ${platform}: extracting grouped games from redump`);
  await produceRedumpGames(platform, state, ctx);

  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(resolve);
  });
  await rename(tempGamesPath, paths.gamesPath);

  const nextManifest = {
    format: GAME_CACHE_FORMAT,
    generatedAt: ctx.generatedAt,
    platform,
    source: "redump",
    fingerprint,
    maxObjects: ctx.maxObjects ?? null,
    stats: {
      components: state.components,
      gameObjects: state.jsonObjects,
      games: state.games,
    },
  };
  await writeFile(paths.manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  const written = await stat(paths.gamesPath);
  console.error(
    `[identify] ${platform}: wrote games (${formatBytes(written.size)}, ` +
      `${state.games.toLocaleString("en-US")} game(s))`,
  );
  return { ...paths, manifest: nextManifest, slug, source: "redump" };
}

function writePack(entries) {
  const directoryBytes = entries.reduce(
    (sum, entry) => sum + 2 + 8 + Buffer.byteLength(entry.name, "utf8"),
    0,
  );
  const payloadBytes = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const buffer = Buffer.allocUnsafe(8 + 4 + directoryBytes + payloadBytes);
  PACK_MAGIC.copy(buffer, 0);
  let cursor = 8;
  buffer.writeUInt32LE(entries.length, cursor);
  cursor += 4;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    buffer.writeUInt16LE(name.length, cursor);
    cursor += 2;
    buffer.writeBigUInt64LE(BigInt(entry.bytes.length), cursor);
    cursor += 8;
    name.copy(buffer, cursor);
    cursor += name.length;
  }
  for (const entry of entries) {
    entry.bytes.copy(buffer, cursor);
    cursor += entry.bytes.length;
  }
  return buffer;
}

async function brotliCompress(buffer, quality) {
  return new Promise((resolve, reject) => {
    zlib.brotliCompress(
      buffer,
      { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality } },
      (error, compressed) => {
        if (error) reject(error);
        else resolve(compressed);
      },
    );
  });
}

function resolveSelection(options) {
  const configured = new Set([
    ...Object.keys(LIBRETRO_PLATFORM_PATHS),
    ...Object.keys(OPENGOOD_STANDALONE_PLATFORMS),
  ]);
  const selected = options.only.length ? options.only : [...configured];
  const missing = selected.filter((platform) => !configured.has(platform));
  if (missing.length && !options.allowMissingPlatforms) {
    throw new Error(
      `Platform(s) are not configured: ${missing.join(", ")}. Use --print-platforms.`,
    );
  }
  if (missing.length) console.error(`[identify] skipping ${missing.length} unknown platform(s)`);
  return selected.filter((platform) => configured.has(platform)).sort();
}

async function* readGames(gamesPath) {
  const lines = readline.createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: createReadStream(gamesPath),
  });
  for await (const line of lines) {
    if (line) yield JSON.parse(line);
  }
}

// Load every game for one platform and sort deterministically. The spec orders
// games.json by (platform, name); gameId and input order break ties so a dump
// with duplicate names still rebuilds byte-identically.
// The Rust reader rejects a whole pack when any record exceeds its caps
// (4096-byte strings, 10,000 components per game, 4,000,000 games), so the
// writer MUST drop an oversized record instead of emitting an unreadable pack.
const READER_MAX_STRING_BYTES = 4096;
const READER_MAX_COMPONENTS_PER_GAME = 10000;
const READER_MAX_GAMES = 4000000;

function gameWithinPackCaps(game) {
  const stringOk = (value) =>
    value === undefined || Buffer.byteLength(String(value), "utf8") <= READER_MAX_STRING_BYTES;
  return (
    stringOk(game.name) &&
    stringOk(game.platform) &&
    stringOk(game.gameId) &&
    stringOk(game.region) &&
    stringOk(game.language) &&
    game.components.length <= READER_MAX_COMPONENTS_PER_GAME &&
    game.components.every((component) => stringOk(component.filename))
  );
}

export async function loadSortedGames(gamesPath) {
  const games = [];
  let skippedOverCaps = 0;
  for await (const game of readGames(gamesPath)) {
    if (!gameWithinPackCaps(game) || games.length >= READER_MAX_GAMES) {
      skippedOverCaps += 1;
      continue;
    }
    game.inputIndex = games.length;
    games.push(game);
  }
  if (skippedOverCaps > 0) {
    console.error(
      `[identify] skipped ${skippedOverCaps} game record(s) that exceed the RWFP4 reader caps`,
    );
  }
  // Codepoint comparison, never localeCompare: ICU collation varies by
  // machine and would break the byte-identical rebuild promise.
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  games.sort(
    (a, b) =>
      compare(a.platform, b.platform) ||
      compare(a.name, b.name) ||
      compare(String(a.gameId ?? ""), String(b.gameId ?? "")) ||
      a.inputIndex - b.inputIndex,
  );
  return games;
}

export function mediaProfileFor(platform, source) {
  if (source === "libretro" && KNOWN_PLATFORM_PROFILES[platform]) {
    return KNOWN_PLATFORM_PROFILES[platform];
  }
  if (
    source === "libretro" &&
    LIBRETRO_PLATFORM_PATHS[platform]?.some((sourcePath) =>
      sourcePath.startsWith("metadat/redump/"),
    )
  ) {
    return platform === "Sega - Dreamcast" ? "redump-gdrom-track-v1" : "redump-cd-track-v1";
  }
  if (source === "libretro") return DEFAULT_MEDIA_PROFILE;
  if (source === "opengood") return "opengood-cartridge-v1";
  return KNOWN_PLATFORM_PROFILES[platform] ?? DEFAULT_MEDIA_PROFILE;
}

// Shared components cannot identify one game, but the pack keeps them as
// metadata for the selected title.
function markSharedComponents(games) {
  const owners = new Map();
  const keysOf = (component) => {
    const keys = [];
    if (component.md5) keys.push(`${component.size}|m|${component.md5}`);
    if (component.sha1) keys.push(`${component.size}|s|${component.sha1}`);
    return keys;
  };
  games.forEach((game, gameIndex) => {
    for (const component of game.components) {
      for (const key of keysOf(component)) {
        const owner = owners.get(key);
        if (owner === undefined) owners.set(key, gameIndex);
        else if (owner !== gameIndex) owners.set(key, -1);
      }
    }
  });
  let sharedComponents = 0;
  for (const game of games) {
    for (const component of game.components) {
      component.discriminating = !keysOf(component).some((key) => owners.get(key) === -1);
      if (!component.discriminating) sharedComponents += 1;
    }
  }
  return sharedComponents;
}

const ABSENT_U32 = 0xffffffff;
const ROLE_CODES = Object.freeze({
  primary_payload: 0,
  data_track: 1,
  audio_track: 2,
  arcade_rom: 3,
  partition: 4,
  content_file: 5,
  disk_side: 6,
  child_disc: 7,
});
const SOURCE_CODES = Object.freeze({ libretro: 0, opengood: 1, redump: 2 });
const UPSTREAM_CODES = Object.freeze({
  libretro: 0,
  redump: 1,
  "no-intro": 2,
  tosec: 3,
  mame: 4,
  fbneo: 5,
  "open-good": 6,
  unknown: 7,
});

const tableHeader = (magic, width, count, extraBytes = 0) => {
  const buffer = Buffer.alloc(12 + extraBytes);
  buffer.write(magic, 0, 4, "ascii");
  buffer.writeUInt16LE(1, 4);
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt32LE(count, 8);
  return buffer;
};

function buildStringTable(values) {
  const strings = [...new Set(values.filter((value) => value !== undefined).map(String))].sort(
    (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  const ids = new Map(strings.map((value, index) => [value, index]));
  const encoded = strings.map((value) => Buffer.from(value, "utf8"));
  const byteCount = encoded.reduce((sum, value) => sum + value.length, 0);
  const header = tableHeader("RWS3", 0, strings.length, 4);
  header.writeUInt32LE(byteCount, 12);
  const offsets = Buffer.alloc((strings.length + 1) * 4);
  let cursor = 0;
  encoded.forEach((value, index) => {
    offsets.writeUInt32LE(cursor, index * 4);
    cursor += value.length;
  });
  offsets.writeUInt32LE(cursor, strings.length * 4);
  return { bytes: Buffer.concat([header, offsets, ...encoded]), ids };
}

function internOrderedSets(sets) {
  const unique = [[]];
  const ids = new Map([["[]", 0]]);
  const mapped = sets.map((values) => {
    const key = JSON.stringify(values);
    let id = ids.get(key);
    if (id === undefined) {
      id = unique.length;
      ids.set(key, id);
      unique.push(values);
    }
    return id;
  });
  const offsets = [0];
  const flattened = [];
  for (const values of unique) {
    flattened.push(...values);
    offsets.push(flattened.length);
  }
  return { flattened, mapped, offsets, sets: unique };
}

function buildPackTables(games) {
  const provenance = [];
  const provenanceIds = new Map();
  const provenanceSets = games.map((game) =>
    (game.provenance ?? []).map((value) => {
      const key = JSON.stringify(value);
      let id = provenanceIds.get(key);
      if (id === undefined) {
        id = provenance.length;
        provenanceIds.set(key, id);
        provenance.push(value);
      }
      return id;
    }),
  );

  const stringValues = [];
  for (const game of games) {
    stringValues.push(
      game.name,
      game.platform,
      game.gameId,
      game.region,
      game.language,
      game.revision,
      game.parent,
      ...(game.dumpTags ?? []),
    );
    for (const component of game.components) {
      stringValues.push(component.filename, component.hashScope ?? "full_file");
    }
  }
  const strings = buildStringTable(stringValues);
  const stringId = (value) => {
    if (value === undefined) return ABSENT_U32;
    const id = strings.ids.get(String(value));
    if (id === undefined) throw new Error(`RWFP4 string was not interned: ${String(value)}`);
    return id;
  };

  const hashByKey = new Map();
  const hashes = [];
  const componentHashKeys = [];
  for (const game of games) {
    for (const component of game.components) {
      const scope = component.hashScope ?? "full_file";
      const key = JSON.stringify([
        component.size,
        scope,
        component.crc32 ?? "",
        component.md5 ?? "",
        component.sha1 ?? "",
        component.sha256 ?? "",
      ]);
      if (!hashByKey.has(key)) {
        hashByKey.set(key, hashes.length);
        hashes.push({ ...component, scope, key });
      }
      componentHashKeys.push(key);
    }
  }
  const compareBuffers = (left, right) => Buffer.compare(left, right);
  hashes.sort((left, right) => {
    const size = BigInt(left.size) - BigInt(right.size);
    if (size !== 0n) return size < 0n ? -1 : 1;
    const scope = compareBuffers(Buffer.from(left.scope), Buffer.from(right.scope));
    if (scope) return scope;
    return compareBuffers(Buffer.from(left.key), Buffer.from(right.key));
  });
  hashByKey.clear();
  hashes.forEach((hash, index) => hashByKey.set(hash.key, index));

  const hashesHeader = tableHeader("RWH3", 92, hashes.length);
  const hashesRecords = Buffer.alloc(hashes.length * 92);
  hashes.forEach((hash, index) => {
    let cursor = index * 92;
    hashesRecords.writeBigUInt64LE(BigInt(hash.size), cursor);
    cursor += 8;
    hashesRecords.writeUInt32LE(stringId(hash.scope), cursor);
    cursor += 4;
    let mask = 0;
    if (hash.crc32) mask |= 1;
    if (hash.md5) mask |= 2;
    if (hash.sha1) mask |= 4;
    if (hash.sha256) mask |= 8;
    hashesRecords.writeUInt8(mask, cursor);
    cursor += 4;
    for (const [field, width] of [
      ["crc32", 4],
      ["md5", 16],
      ["sha1", 20],
      ["sha256", 32],
    ]) {
      if (hash[field]) Buffer.from(hash[field], "hex").copy(hashesRecords, cursor);
      cursor += width;
    }
  });

  const provenanceSetTable = internOrderedSets(provenanceSets);
  const tagValueSets = games.map((game) => (game.dumpTags ?? []).map(stringId));
  const tagSetTable = internOrderedSets(tagValueSets);
  const setsHeader = tableHeader("RWSX", 0, provenanceSetTable.sets.length, 12);
  setsHeader.writeUInt32LE(provenanceSetTable.flattened.length, 12);
  setsHeader.writeUInt32LE(tagSetTable.sets.length, 16);
  setsHeader.writeUInt32LE(tagSetTable.flattened.length, 20);
  const u32s = (values) => {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeUInt32LE(value, index * 4));
    return buffer;
  };
  const setsBytes = Buffer.concat([
    setsHeader,
    u32s(provenanceSetTable.offsets),
    u32s(provenanceSetTable.flattened),
    u32s(tagSetTable.offsets),
    u32s(tagSetTable.flattened),
  ]);

  const components = [];
  const gameRanges = [];
  let flatIndex = 0;
  games.forEach((game) => {
    const first = components.length;
    game.components.forEach((component) => {
      components.push({ component, hashId: hashByKey.get(componentHashKeys[flatIndex]) });
      flatIndex += 1;
    });
    gameRanges.push({ count: components.length - first, first });
  });
  const componentsHeader = tableHeader("RWC3", 28, components.length);
  const componentRecords = Buffer.alloc(components.length * 28);
  components.forEach(({ component, hashId }, index) => {
    const cursor = index * 28;
    componentRecords.writeUInt32LE(hashId, cursor);
    componentRecords.writeUInt32LE(stringId(component.filename), cursor + 4);
    componentRecords.writeUInt32LE(component.ordinal, cursor + 8);
    componentRecords.writeUInt32LE(component.track ?? ABSENT_U32, cursor + 12);
    componentRecords.writeUInt32LE(component.session ?? ABSENT_U32, cursor + 16);
    componentRecords.writeUInt8(ROLE_CODES[component.role ?? "primary_payload"], cursor + 20);
    componentRecords.writeUInt8(
      (component.required === false ? 0 : 1) | (component.discriminating ? 2 : 0),
      cursor + 21,
    );
  });

  const gamesHeader = tableHeader("RWG3", 52, games.length);
  const gameRecords = Buffer.alloc(games.length * 52);
  games.forEach((game, index) => {
    const cursor = index * 52;
    [
      game.name,
      game.platform,
      game.gameId,
      game.region,
      game.language,
      game.revision,
      game.parent,
    ].forEach((value, field) => gameRecords.writeUInt32LE(stringId(value), cursor + field * 4));
    gameRecords.writeUInt32LE(gameRanges[index].first, cursor + 28);
    gameRecords.writeUInt32LE(gameRanges[index].count, cursor + 32);
    gameRecords.writeUInt32LE(provenanceSetTable.mapped[index], cursor + 36);
    gameRecords.writeUInt32LE(tagSetTable.mapped[index], cursor + 40);
    gameRecords.writeUInt32LE(game.discNumber ?? ABSENT_U32, cursor + 44);
    gameRecords.writeUInt8(SOURCE_CODES[game.source], cursor + 48);
    gameRecords.writeUInt8(UPSTREAM_CODES[game.upstreamSource ?? "unknown"], cursor + 49);
    gameRecords.writeUInt8(game.legacyVariant ? 1 : 0, cursor + 50);
  });

  const owners = Array.from({ length: hashes.length }, () => []);
  components.forEach(({ hashId }, componentId) => owners[hashId].push(componentId));
  const ownerOffsets = [0];
  const ownerValues = [];
  for (const values of owners) {
    ownerValues.push(...values);
    ownerOffsets.push(ownerValues.length);
  }
  const ownersHeader = tableHeader("RWO3", 0, hashes.length, 4);
  ownersHeader.writeUInt32LE(ownerValues.length, 12);
  const ownersBytes = Buffer.concat([ownersHeader, u32s(ownerOffsets), u32s(ownerValues)]);

  const routeIds = hashes
    .map((hash, id) => ({ hash, id }))
    .filter(
      ({ hash, id }) =>
        hash.crc32 &&
        hash.size > 0 &&
        owners[id].some((componentId) => components[componentId].component.discriminating),
    )
    .sort((left, right) => {
      const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
      return (
        compare(left.hash.crc32, right.hash.crc32) ||
        Number(left.hash.size) - Number(right.hash.size) ||
        compare(left.hash.scope, right.hash.scope) ||
        left.id - right.id
      );
    })
    .map(({ id }) => id);
  const routesBytes = Buffer.concat([tableHeader("RWR3", 4, routeIds.length), u32s(routeIds)]);

  return {
    componentCount: components.length,
    members: [
      { name: "strings.bin", bytes: strings.bytes },
      { name: "hashes.bin", bytes: Buffer.concat([hashesHeader, hashesRecords]) },
      { name: "components.bin", bytes: Buffer.concat([componentsHeader, componentRecords]) },
      { name: "games.bin", bytes: Buffer.concat([gamesHeader, gameRecords]) },
      { name: "owners.bin", bytes: ownersBytes },
      { name: "routes.bin", bytes: routesBytes },
      { name: "sets.bin", bytes: setsBytes },
    ],
    provenance,
    routedKeys: routeIds.length,
  };
}

function encodeUvarint(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new Error("RWFP4 variable integer cannot be negative");
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

const encodeOptionalId = (value) => encodeUvarint(value === ABSENT_U32 ? 0 : value + 1);

function readPackStrings(bytes) {
  const count = bytes.readUInt32LE(8);
  const dataStart = 16 + (count + 1) * 4;
  return Array.from({ length: count }, (_, index) => {
    const start = bytes.readUInt32LE(16 + index * 4);
    const end = bytes.readUInt32LE(20 + index * 4);
    return bytes.subarray(dataStart + start, dataStart + end);
  });
}

function variableTable(magic, count, records) {
  return Buffer.concat([Buffer.from(magic, "ascii"), Buffer.from([1]), encodeUvarint(count), ...records]);
}

function buildRwfp4Tables(games) {
  const fixedTables = buildPackTables(games);
  const members = new Map(fixedTables.members.map((member) => [member.name, member.bytes]));
  const strings = readPackStrings(members.get("strings.bin"));
  const stringRecords = strings.flatMap((value) => [encodeUvarint(value.length), value]);
  const stringsBytes = variableTable("RWS4", strings.length, stringRecords);

  const fixedHashes = members.get("hashes.bin");
  const hashCount = fixedHashes.readUInt32LE(8);
  const hashRows = [];
  const hashOffsets = Buffer.alloc((hashCount + 1) * 4);
  let hashCursor = 0;
  for (let index = 0; index < hashCount; index += 1) {
    const row = fixedHashes.subarray(12 + index * 92, 12 + (index + 1) * 92);
    const scopeId = row.readUInt32LE(8);
    const scope = strings[scopeId]?.toString("utf8");
    const scopeBytes =
      scope === "full_file"
        ? Buffer.from([0])
        : scope === "track_file"
          ? Buffer.from([1])
          : Buffer.concat([Buffer.from([255]), encodeUvarint(scopeId)]);
    const mask = row.readUInt8(12);
    const values = [];
    for (const [bit, start, width] of [
      [1, 16, 4],
      [2, 20, 16],
      [4, 36, 20],
      [8, 56, 32],
    ]) {
      if (mask & bit) values.push(row.subarray(start, start + width));
    }
    const compact = Buffer.concat([
      encodeUvarint(row.readBigUInt64LE(0)),
      scopeBytes,
      Buffer.from([mask]),
      ...values,
    ]);
    hashOffsets.writeUInt32LE(hashCursor, index * 4);
    hashRows.push(compact);
    hashCursor += compact.length;
  }
  hashOffsets.writeUInt32LE(hashCursor, hashCount * 4);
  const hashesBytes = variableTable("RWH4", hashCount, [hashOffsets, ...hashRows]);

  const fixedComponents = members.get("components.bin");
  const componentCount = fixedComponents.readUInt32LE(8);
  const componentRows = [];
  for (let index = 0; index < componentCount; index += 1) {
    const row = fixedComponents.subarray(12 + index * 28, 12 + (index + 1) * 28);
    componentRows.push(
      Buffer.concat([
        encodeUvarint(row.readUInt32LE(0)),
        encodeOptionalId(row.readUInt32LE(4)),
        encodeUvarint(row.readUInt32LE(8)),
        encodeOptionalId(row.readUInt32LE(12)),
        encodeOptionalId(row.readUInt32LE(16)),
        row.subarray(20, 22),
      ]),
    );
  }
  const componentsBytes = variableTable("RWC4", componentCount, componentRows);

  const fixedGames = members.get("games.bin");
  const gameCount = fixedGames.readUInt32LE(8);
  const gameRows = [];
  for (let index = 0; index < gameCount; index += 1) {
    const row = fixedGames.subarray(12 + index * 52, 12 + (index + 1) * 52);
    gameRows.push(
      Buffer.concat([
        encodeUvarint(row.readUInt32LE(0)),
        encodeUvarint(row.readUInt32LE(4)),
        ...[8, 12, 16, 20, 24].map((offset) => encodeOptionalId(row.readUInt32LE(offset))),
        encodeUvarint(row.readUInt32LE(32)),
        encodeUvarint(row.readUInt32LE(36)),
        encodeUvarint(row.readUInt32LE(40)),
        encodeOptionalId(row.readUInt32LE(44)),
        row.subarray(48, 51),
      ]),
    );
  }
  const gamesBytes = variableTable("RWG4", gameCount, gameRows);

  const convertU32Tail = (name, magic, start = 8) => {
    const source = members.get(name);
    const records = [];
    for (let offset = start; offset < source.length; offset += 4) {
      records.push(encodeUvarint(source.readUInt32LE(offset)));
    }
    return Buffer.concat([Buffer.from(magic, "ascii"), Buffer.from([1]), ...records]);
  };
  return {
    ...fixedTables,
    hashCount,
    members: [
      { name: "strings.bin", bytes: stringsBytes },
      { name: "hashes.bin", bytes: hashesBytes },
      { name: "components.bin", bytes: componentsBytes },
      { name: "games.bin", bytes: gamesBytes },
      { name: "owners.bin", bytes: convertU32Tail("owners.bin", "RWO4") },
      { name: "routes.bin", bytes: convertU32Tail("routes.bin", "RWR4") },
      { name: "sets.bin", bytes: convertU32Tail("sets.bin", "RWX4") },
    ],
  };
}

export function buildSystemPackV4(platform, games, source = "libretro") {
  const sharedComponents = markSharedComponents(games);
  const tables = buildRwfp4Tables(games);
  const manifest = {
    format: PACK_FORMAT,
    platform,
    source,
    generationDate: IDENTIFY_GENERATION_DATE,
    canonicalizationProfile: mediaProfileFor(platform, source),
    canonicalizationVersion: 1,
    provenance: tables.provenance,
    counts: {
      games: games.length,
      components: tables.componentCount,
      hashes: tables.hashCount,
      routedKeys: tables.routedKeys,
      sharedComponents,
    },
  };
  const pack = writePack([
    ...tables.members,
    { name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest), "utf8") },
  ]);
  return {
    componentCount: tables.componentCount,
    pack,
    routedKeys: tables.routedKeys,
    sharedComponents,
  };
}

function sortGames(games) {
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  return games
    .map((game, inputIndex) => ({ ...game, inputIndex }))
    .sort(
      (left, right) =>
        compare(left.platform, right.platform) ||
        compare(left.name, right.name) ||
        compare(String(left.gameId ?? ""), String(right.gameId ?? "")) ||
        left.inputIndex - right.inputIndex,
    )
    .map(({ inputIndex: _inputIndex, ...game }) => game);
}

async function readPlatformGames(platform, options, paths) {
  const sourcePaths = LIBRETRO_PLATFORM_PATHS[platform] ?? [];
  const fallbackFiles =
    COMPLETE_OPENGOOD_FALLBACKS[platform] ?? OPENGOOD_STANDALONE_PLATFORMS[platform] ?? [];
  let libretro = [];
  const libretroHeaders = [];
  for (const sourcePath of sourcePaths) {
    const parsed = parseLibretroGames(
      await readFile(paths.libretro.get(sourcePath), "utf8"),
      platform,
      sourcePath,
    );
    libretro = mergeLibretroGames(libretro, parsed.games);
    libretroHeaders.push({ sourcePath, ...parsed.header });
  }
  const fallback = [];
  const openGoodHeaders = [];
  for (const fallbackFile of fallbackFiles) {
    const parsed = parseOpenGoodGames(
      await readFile(paths.opengood.get(fallbackFile), "utf8"),
      platform,
      fallbackFile,
    );
    fallback.push(...parsed.games);
    openGoodHeaders.push({ datFile: fallbackFile, ...parsed.header });
  }
  const games = sortGames(mergeLegacyFallbackGames(libretro, fallback));
  return {
    slug: slugifyPlatform(platform),
    games: options.maxObjects === undefined ? games : games.slice(0, options.maxObjects),
    provenance: {
      libretro: libretroHeaders.length
        ? libretroHeaders.map((header) => ({
            commit: LIBRETRO_REVISION,
            generationDate: header.date ?? null,
            license: LIBRETRO_LICENSE,
            name: innerLibretroSource(header.sourcePath),
            path: header.sourcePath,
            url: `${LIBRETRO_REPOSITORY}/blob/${LIBRETRO_REVISION}/${header.sourcePath.split("/").map(encodeURIComponent).join("/")}`,
          }))
        : null,
      opengood: openGoodHeaders.map((header) => ({
        commit: OPENGOOD_REVISION,
        generationDate: header.date ?? null,
        license: OPENGOOD_LICENSE,
        name: "SnowflakePowered/opengood",
        path: `dats/${header.datFile}`,
        url: `${OPENGOOD_REPOSITORY}/blob/${OPENGOOD_REVISION}/dats/${encodeURIComponent(header.datFile)}`,
      })),
    },
    source: sourcePaths.length ? "libretro" : "opengood",
  };
}

async function writeSystemPackV4(platform, gamesInfo, options) {
  console.error(`[identify] ${platform}: building RWFP4 pack`);
  const games = gamesInfo.games;
  const { componentCount, pack, routedKeys, sharedComponents } = buildSystemPackV4(
    platform,
    games,
    gamesInfo.source,
  );
  const fileName = `${gamesInfo.slug}.pack`;
  const outPath = path.join(options.outPath, fileName);
  await writeFile(outPath, pack);

  const system = {
    platform,
    slug: gamesInfo.slug,
    source: gamesInfo.source,
    packFormat: "RWFP4",
    file: fileName,
    rawBytes: pack.length,
    sha256: crypto.createHash("sha256").update(pack).digest("hex"),
    entries: {
      games: games.length,
      components: componentCount,
      routedKeys,
      sharedComponents,
    },
  };
  if (options.brotli) {
    const compressed = await brotliCompress(pack, options.brotliQuality);
    await writeFile(`${outPath}.br`, compressed);
    system.brotliFile = `${fileName}.br`;
    system.brotliBytes = compressed.length;
  }
  console.error(
    `[identify] ${platform}: wrote ${fileName} (${formatBytes(pack.length)}` +
      `${system.brotliBytes ? `, br ${formatBytes(system.brotliBytes)}` : ""}` +
      `, ${games.length.toLocaleString("en-US")} game(s), ${routedKeys.toLocaleString("en-US")} routed key(s))`,
  );
  return system;
}

// Build the catalog.json platform entries and enforce the alias rules: a
// platform's own normalized name always claims its alias (a curated alias that
// collides with another platform's own name is dropped); any remaining
// duplicate alias, and any duplicate packSlug, is a build error.
export function buildCatalogPlatforms(systems) {
  const ownNames = new Map();
  const slugOwners = new Map();
  for (const system of systems) {
    const slugOwner = slugOwners.get(system.slug);
    if (slugOwner !== undefined && slugOwner !== system.platform) {
      throw new Error(
        `Duplicate packSlug "${system.slug}" between "${slugOwner}" and "${system.platform}"`,
      );
    }
    slugOwners.set(system.slug, system.platform);
    const own = normalizeAlias(system.platform);
    const existingOwn = ownNames.get(own);
    if (existingOwn !== undefined && existingOwn !== system.platform) {
      throw new Error(
        `Duplicate platform alias "${own}" between "${existingOwn}" and "${system.platform}"`,
      );
    }
    ownNames.set(own, system.platform);
  }

  const aliasOwners = new Map(ownNames);
  const platforms = systems.map((system) => {
    const aliases = new Set([normalizeAlias(system.platform)]);
    const familyAliases = Object.entries(PACK_FAMILY_TARGETS)
      .filter(([, target]) => target === system.platform)
      .map(([source]) => source);
    for (const alias of [...(CURATED_ALIASES[system.platform] ?? []), ...familyAliases]) {
      const normalized = normalizeAlias(alias);
      const ownOwner = ownNames.get(normalized);
      // Another platform's own name wins over this curated alias.
      if (ownOwner !== undefined && ownOwner !== system.platform) continue;
      const owner = aliasOwners.get(normalized);
      if (owner !== undefined && owner !== system.platform) {
        throw new Error(
          `Duplicate platform alias "${normalized}" between "${owner}" and "${system.platform}"`,
        );
      }
      aliasOwners.set(normalized, system.platform);
      aliases.add(normalized);
    }
    const entry = {
      canonicalPlatform: system.platform,
      aliases: [...aliases].sort(),
      source: system.source,
      mediaProfiles: [mediaProfileFor(system.platform, system.source)],
      packSlug: system.slug,
      packFormat: "RWFP4",
      canonicalizationVersion: 1,
    };
    if (system.sha256) entry.packSha256 = system.sha256;
    return entry;
  });
  return platforms;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.printPlatforms) {
    for (const [platform, sourcePaths] of Object.entries(LIBRETRO_PLATFORM_PATHS).sort()) {
      console.log(`libretro\t${platform}\t${sourcePaths.join(",")}`);
    }
    for (const platform of Object.keys(OPENGOOD_STANDALONE_PLATFORMS).sort()) {
      console.log(`opengood-fallback\t${platform}`);
    }
    return;
  }

  requireExecutable("curl");
  requireExecutable("tar");
  const selected = resolveSelection(options);
  if (!selected.length) {
    throw new Error("No platforms selected to build");
  }

  const neededLibretro = new Set();
  const neededOpenGood = new Set();
  for (const platform of selected) {
    for (const sourcePath of LIBRETRO_PLATFORM_PATHS[platform] ?? [])
      neededLibretro.add(sourcePath);
    for (const datFile of COMPLETE_OPENGOOD_FALLBACKS[platform] ??
      OPENGOOD_STANDALONE_PLATFORMS[platform] ??
      []) {
      neededOpenGood.add(datFile);
    }
  }
  const paths = {
    libretro: await ensureLibretroDats([...neededLibretro].sort(), options.cacheDir),
    opengood: await ensureOpenGoodDats([...neededOpenGood].sort(), options.cacheDir),
  };
  if (options.downloadOnly) {
    console.log(
      JSON.stringify(
        { libretro: [...neededLibretro].sort(), opengood: [...neededOpenGood].sort() },
        null,
        2,
      ),
    );
    return;
  }

  await mkdir(options.outPath, { recursive: true });
  const systems = [];
  for (const platform of selected) {
    const games = await readPlatformGames(platform, options, paths);
    systems.push(await writeSystemPackV4(platform, games, options));
  }

  // The catalog always lists every configured platform. The pack itself may be
  // absent when this invocation built a subset, so clients can still resolve a
  // useful alias before they fetch the matching pack.
  const builtBySlug = new Map(systems.map((system) => [system.slug, system]));
  const catalogSystems = [];
  for (const platform of [
    ...Object.keys(LIBRETRO_PLATFORM_PATHS),
    ...Object.keys(OPENGOOD_STANDALONE_PLATFORMS),
  ].sort()) {
    const slug = slugifyPlatform(platform);
    const built = builtBySlug.get(slug);
    catalogSystems.push(
      built ?? {
        platform,
        slug,
        source: LIBRETRO_PLATFORM_PATHS[platform] ? "libretro" : "opengood",
        packFormat: "RWFP4",
      },
    );
  }
  const catalog = {
    format: CATALOG_FORMAT,
    generated: {
      opengoodRevision: OPENGOOD_REVISION,
      libretroRevision: LIBRETRO_REVISION,
    },
    platforms: buildCatalogPlatforms(catalogSystems),
  };
  await writeFile(
    path.join(options.outPath, "catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );

  const index = {
    format: INDEX_FORMAT,
    hashStrategy: "crc-primary-md5-sha1-fallback-per-system",
    catalog: "catalog.json",
    sources: {
      opengood: {
        url: OPENGOOD_REPOSITORY,
        license: OPENGOOD_LICENSE,
        revision: OPENGOOD_REVISION,
      },
      libretro: {
        url: LIBRETRO_REPOSITORY,
        license: LIBRETRO_LICENSE,
        revision: LIBRETRO_REVISION,
      },
    },
    groups: [
      { id: "default", label: "Default", default: true },
      { id: "optional-arcade", label: "Arcade", default: false },
      { id: "optional-computers", label: "Computers", default: false },
      { id: "optional-engines", label: "Game engines", default: false },
      { id: "optional-fantasy", label: "Fantasy consoles", default: false },
      { id: "optional-mobile", label: "Mobile", default: false },
      { id: "optional-extended", label: "Extended systems", default: false },
    ].map((group) => ({
      ...group,
      systems: systems
        .filter((system) => packGroupFor(system.platform) === group.id)
        .map((system) => system.slug),
    })),
    systems: systems.map((system) => ({
      ...system,
      group: packGroupFor(system.platform),
      defaultPack: DEFAULT_PACK_SET.has(system.platform),
    })),
  };
  await writeFile(path.join(options.outPath, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

  const totals = systems.reduce(
    (acc, system) => {
      acc.raw += system.rawBytes;
      acc.brotli += system.brotliBytes || 0;
      acc.crcKeys += system.entries.crcKeys ?? system.entries.routedKeys ?? 0;
      return acc;
    },
    { brotli: 0, crcKeys: 0, raw: 0 },
  );
  console.log(
    JSON.stringify(
      {
        outDir: options.outPath,
        systemCount: systems.length,
        totalCrcKeys: totals.crcKeys,
        totalRawBytes: totals.raw,
        totalRawHuman: formatBytes(totals.raw),
        totalBrotliBytes: totals.brotli,
        totalBrotliHuman: formatBytes(totals.brotli),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`error: ${error.stack || error.message || error}`);
    process.exit(1);
  });
}
