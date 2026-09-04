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

import { brotliCompressBuffer } from "./wasm/brotli-compress.mjs";
import {
  buildPackFilter,
  CHECKSUM_ROUTER_FORMAT,
  encodeChecksumRouter,
  parseChecksumRouter,
  routeChecksums,
} from "../packages/rom-weaver-webapp/src/lib/identify/checksum-router.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), "rom-weaver-identify-dats");
const DEFAULT_OUT = path.join(ROOT_DIR, "target/identify");

const PACK_MAGIC_V1 = Buffer.from("RWFP1\0\0\0", "binary");
const ROW_CACHE_FORMAT = "rom-weaver-identify-rows-v2";
const GAME_CACHE_FORMAT = "rom-weaver-identify-games-v1";
export const INDEX_FORMAT = "rom-weaver-identify-system-pack-v1";
export const CATALOG_FORMAT = "rom-weaver-identify-catalog-v1";

// OpenGood publishes GoodTools cartridge sets as CC0 Logiqx XML DATs. It adds
// historical dump variants to matching Libretro packs and owns its standalone packs.
export const OPENGOOD_REPOSITORY = "https://github.com/SnowflakePowered/opengood";
export const OPENGOOD_REVISION = "5cbd95ef3f5904b9e067042ae8dd08a35c39c89a";
// OpenGood moved NES records to headerless payloads in 2021-12-28, but kept
// normalized iNES records in this separate DAT. Keep both revisions so a
// pasted checksum can match either representation.
export const OPENGOOD_HEADERED_REVISION = "269d8c32b46a20049f187e2ee02a666cc47c27e1";
export const OPENGOOD_LICENSE = "CC0-1.0";
// Eggmansworld publishes a completed GoodSNES dir2dat export. Unlike the
// normalized GoodTools database, this DAT contains hashes for the files as
// stored, including recorded 512-byte copier headers.
export const GOODTOOLS_REPOSITORY = "https://github.com/Eggmansworld/Datfiles";
export const GOODTOOLS_RELEASE = "goodtools";
export const GOODTOOLS_ARCHIVE = "GoodTools.Collection.2025-04-10_RomVault.zip";
export const GOODTOOLS_ARCHIVE_SHA256 =
  "44ff34d326bb9c3036dde746d7787dddeaa864373309983355a63c6929c1eeae";
export const GOODTOOLS_DAT_PATH = "GoodSNES v3.27/GoodSNES v3.27.dat";
export const GOODTOOLS_LICENSE = "MIT";
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

export const OPENGOOD_HEADERED_FALLBACKS = Object.freeze({
  "Nintendo - Nintendo Entertainment System": ["OpenNES.Headered.dat"],
});

export const GOODTOOLS_HEADERED_FALLBACKS = Object.freeze({
  "Nintendo - Super Nintendo Entertainment System": GOODTOOLS_DAT_PATH,
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
// Every alias the Rust built-in fallback catalog promises
// (crates/rom-weaver-checksum/src/identify_catalog.rs) MUST appear here too:
// a build that ships data resolves names through this catalog instead, so an
// alias missing here stops resolving the moment the packaged data is present.
export const CURATED_ALIASES = Object.freeze({
  "Atari - 2600": ["atari 2600", "2600", "atari vcs", "vcs"],
  "Atari - 5200": ["atari 5200", "5200"],
  "Atari - 7800": ["atari 7800", "7800"],
  "Atari - Lynx": ["atari lynx", "lynx"],
  "Nintendo - Nintendo 64": ["nintendo 64", "n64"],
  "Nintendo - Virtual Boy": ["nintendo virtual boy", "virtual boy"],
  "Sega - 32X": ["sega 32x", "32x", "megadrive 32x"],
  "Sega - Dreamcast": ["sega dreamcast", "dreamcast", "dc"],
  "Sega - Saturn": ["sega saturn", "saturn"],
  "Nintendo - Family Computer Disk System": ["fds", "famicom disk system", "nintendo fds"],
  "SNK - Neo Geo Pocket": ["neo geo pocket", "ngp"],
  "SNK - Neo Geo Pocket Color": ["neo geo pocket color", "neo geo pocket colour", "ngpc"],
  "Nintendo - Nintendo 3DS": ["nintendo 3ds", "3ds"],
  "Nintendo - Nintendo DS": ["nintendo ds", "nds", "ds"],
  "Nintendo - Nintendo Entertainment System": [
    "nintendo entertainment system",
    "nes",
    "famicom",
    "nintendo famicom",
    "family computer",
  ],
  "Nintendo - Game Boy": ["nintendo game boy", "game boy", "gameboy", "gb"],
  "Nintendo - Game Boy Advance": [
    "nintendo game boy advance",
    "game boy advance",
    "gameboy advance",
    "gba",
  ],
  "Nintendo - Game Boy Color": [
    "nintendo game boy color",
    "game boy color",
    "gameboy color",
    "gbc",
  ],
  "Nintendo - GameCube": ["nintendo gamecube", "gamecube", "gc", "ngc"],
  "Nintendo - Super Nintendo Entertainment System": [
    "nintendo super nintendo entertainment system",
    "snes",
    "super famicom",
    "super nintendo",
    "super nes",
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
    "tg16",
    "pc engine",
    "pce",
  ],
});

export const DEFAULT_PACK_PLATFORMS = Object.freeze([
  "Atari - 2600",
  "Atari - 5200",
  "Atari - 7800",
  "Atari - Lynx",
  "Microsoft - Xbox",
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
  "Nintendo - Wii U",
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
  "Sony - PlayStation 3",
  "Sony - PlayStation Portable",
  "Sony - PlayStation Vita",
]);

const DEFAULT_PACK_SET = new Set(DEFAULT_PACK_PLATFORMS);
const COMPUTER_PACK_PATTERN =
  /^(?:Amstrad|Commodore|DOS$|Enterprise|Memotech|Microsoft - MSX|SAM Coupé|Sharp|Sinclair|Tandy|Tangerine|Thomson|Videoton)|^Atari - (?:8-bit Family|ST$)/u;
export const packGroupFor = (platform) => {
  if (DEFAULT_PACK_SET.has(platform)) return "default";
  if (COMPUTER_PACK_PATTERN.test(platform)) return "optional-computers";
  if (/^(?:LowRes NX|MicroW8|PICO-8|TIC-80|WASM-4)$/u.test(platform)) return "optional-fantasy";
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

const usage = () => `Build per-system RWFP1 ROM-identify packs from pinned Libretro DATs.
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

async function runCommandText(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
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

// Build the tar invocation that extracts `members` into `sourceRoot`.
//
// No absolute path may reach tar. The Windows CI job keeps the workspace on
// `D:`, and the Git-bash tar mishandles such a path twice over: it reads a name
// containing a colon as `host:file`, and it mangles the backslash separators.
// Running from the extraction root and naming the archive by a relative POSIX
// path avoids both, and removes the need for `-C`. `path.relative` yields
// platform separators, so they are rewritten.
//
// Exported for the unit tests, which assert on Windows-shaped inputs that no
// argument carries a colon or a backslash.
export function archiveExtractionCommand({ archive, members, sourceRoot }, pathApi = path) {
  const relativeArchive = pathApi.relative(sourceRoot, archive).split(pathApi.sep).join("/");
  return {
    args: ["-xzf", relativeArchive, "--strip-components=1", ...members],
    cwd: sourceRoot,
  };
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
    const { args, cwd } = archiveExtractionCommand({
      archive,
      members: missing.map((entry) => `${prefix}/${entry.sourcePath}`),
      sourceRoot,
    });
    await runCommandText("tar", args, { cwd });
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

async function ensureOpenGoodDats(
  datFiles,
  cacheDir,
  revision = OPENGOOD_REVISION,
  label = "opengood",
) {
  const sourcePaths = datFiles.map((datFile) => `dats/${datFile}`);
  const paths = await ensureArchiveFiles({
    archiveUrl: `${OPENGOOD_REPOSITORY}/archive/${revision}.tar.gz`,
    cacheDir,
    label,
    prefix: `opengood-${revision}`,
    requestedPaths: sourcePaths,
    revision,
  });
  return new Map(datFiles.map((datFile) => [datFile, paths.get(`dats/${datFile}`)]));
}

async function ensureGoodToolsHeaderedDat(cacheDir) {
  const cacheKey = `${GOODTOOLS_RELEASE}-${GOODTOOLS_ARCHIVE_SHA256}`;
  const archiveDir = path.join(cacheDir, "goodtools", cacheKey);
  const archive = path.join(archiveDir, GOODTOOLS_ARCHIVE);
  const target = path.join(archiveDir, GOODTOOLS_RELEASE, GOODTOOLS_DAT_PATH);
  const targetInfo = await fileStat(target);
  if (!targetInfo?.isFile() || targetInfo.size === 0) {
    await mkdir(archiveDir, { recursive: true });
    const archiveInfo = await fileStat(archive);
    if (archiveInfo?.isFile() && archiveInfo.size > 0) {
      const actualSha256 = await sha256File(archive);
      if (actualSha256 !== GOODTOOLS_ARCHIVE_SHA256) {
        throw new Error(
          `GoodTools cache checksum mismatch: expected ${GOODTOOLS_ARCHIVE_SHA256}, got ${actualSha256}`,
        );
      }
    } else {
      const partial = `${archive}.part`;
      await runCurl(
        `${GOODTOOLS_REPOSITORY}/releases/download/${GOODTOOLS_RELEASE}/${encodeURIComponent(GOODTOOLS_ARCHIVE)}`,
        partial,
        undefined,
      );
      const actualSha256 = await sha256File(partial);
      if (actualSha256 !== GOODTOOLS_ARCHIVE_SHA256) {
        throw new Error(
          `GoodTools download checksum mismatch: expected ${GOODTOOLS_ARCHIVE_SHA256}, got ${actualSha256}`,
        );
      }
      await rename(partial, archive);
    }
    await mkdir(path.dirname(target), { recursive: true });
    requireExecutable("unzip");
    const dat = await runCommandText("unzip", ["-p", archive, GOODTOOLS_DAT_PATH]);
    if (!dat.trim()) throw new Error(`GoodTools archive is missing ${GOODTOOLS_DAT_PATH}`);
    await writeFile(target, dat);
  }
  return target;
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

function base64Utf8(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

// Normalize one ROM's hashes and append a row to the shared rows stream.
// Shared by the Redump (JSON) and OpenGood (XML) producers so both emit the
// identical `crc\tmd5\tsha1\tplatformB64\tnameB64` line format.
async function writeRow(state, rawCrc, rawMd5, rawSha1, platform, name) {
  state.romRows += 1;
  const crc32 = normalizeHex(rawCrc, 8);
  const md5 = normalizeHex(rawMd5, 32);
  const sha1 = normalizeHex(rawSha1, 40);
  if (!crc32 && !md5 && !sha1) {
    state.rowsMissingAllHashes += 1;
    return;
  }
  if (
    !state.stream.write(`${crc32}\t${md5}\t${sha1}\t${base64Utf8(platform)}\t${base64Utf8(name)}\n`)
  ) {
    await once(state.stream, "drain");
  }
  state.rowsWithAnyHash += 1;
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

// Parse a Logiqx XML DAT (OpenGood / clrmamepro export). The <game name="...">
// attribute is the exact dump name we want to surface (e.g.
// `Legend of Zelda, The (U) (PRG0) [!]`); each nested <rom> carries the
// crc/md5/sha1. One normalized row is emitted per <rom>.
async function parseOpenGoodDat(text, platform, state) {
  const gameChunks = text.split(/<game\b/u);
  for (let index = 1; index < gameChunks.length; index += 1) {
    if (state.stopParsing) return;
    state.jsonObjects += 1;
    if (state.maxObjects && state.jsonObjects > state.maxObjects) {
      state.stopParsing = true;
      return;
    }
    const chunk = gameChunks[index];
    const headerEnd = chunk.indexOf(">");
    if (headerEnd < 0) continue;
    const nameMatch = chunk.slice(0, headerEnd).match(/\bname="([^"]*)"/u);
    if (!nameMatch) continue;
    const gameName = xmlUnescape(nameMatch[1]).trim();
    if (!gameName) continue;

    const romMatcher = /<rom\b([^>]*?)\/?>/gu;
    let romMatch = romMatcher.exec(chunk);
    while (romMatch) {
      const rom = parseAttributes(romMatch[1]);
      await writeRow(state, rom.crc, rom.md5, rom.sha1, platform, gameName);
      romMatch = romMatcher.exec(chunk);
    }

    if (state.jsonObjects % 25000 === 0) {
      console.error(
        `[identify] parsed ${state.jsonObjects.toLocaleString("en-US")} game object(s), ` +
          `${state.rowsWithAnyHash.toLocaleString("en-US")} hash row(s)`,
      );
    }
  }
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

export function parseOpenGoodGames(
  text,
  platform,
  datFile,
  { revision = OPENGOOD_REVISION, sourceVariant } = {},
) {
  const headerMatch = text.match(/<header>([\s\S]*?)<\/header>/u);
  const header = {};
  if (headerMatch) {
    for (const match of headerMatch[1].matchAll(/<([\w-]+)>([^<]*)<\/\1>/gu)) {
      header[match[1]] = xmlUnescape(match[2]).trim();
    }
  }
  const provenance = sourceProvenance(
    "SnowflakePowered/opengood",
    `${OPENGOOD_REPOSITORY}/blob/${revision}/dats/${encodeURIComponent(datFile)}`,
    revision,
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
        sourceVariant,
        upstreamSource: "open-good",
      });
    }
  }
  return { games, header };
}

export function parseGoodToolsHeaderedGames(text, platform) {
  const headerMatch = text.match(/<header>([\s\S]*?)<\/header>/u);
  const header = {};
  if (headerMatch) {
    for (const match of headerMatch[1].matchAll(/<([\w-]+)>([^<]*)<\/\1>/gu)) {
      header[match[1]] = xmlUnescape(match[2]).trim();
    }
  }
  const provenance = sourceProvenance(
    "Eggmansworld/Datfiles",
    `${GOODTOOLS_REPOSITORY}/releases/tag/${GOODTOOLS_RELEASE}`,
    GOODTOOLS_RELEASE,
    GOODTOOLS_LICENSE,
    header.date,
  );
  const games = [];
  for (const match of text.matchAll(/<rom\b([^>]*?)\/?>(?:\r?\n)?/gu)) {
    const rom = parseAttributes(match[1]);
    const sourceName = String(rom.name ?? "").trim();
    const size = /^\d+$/u.test(String(rom.size ?? "")) ? Number.parseInt(rom.size, 10) : 0;
    if (!sourceName.startsWith("SNESRen/") || !sourceName.endsWith(".smc") || size % 1024 !== 512)
      continue;
    const filename = sourceName.slice("SNESRen/".length);
    const name = filename.slice(0, -".smc".length);
    const component = componentFromRom({ ...rom, name: filename }, 0, "open-good");
    if (!component.crc32 && !component.md5 && !component.sha1) continue;
    games.push({
      components: [component],
      dumpTags: extractGoodToolsDumpTags(name),
      legacyVariant: true,
      name,
      platform,
      provenance: [provenance],
      source: "opengood",
      sourceVariant: "headered",
      upstreamSource: "open-good",
    });
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
// The headered and headerless NES DATs use the same GoodTools dump name, so
// that name links the two representations after exact matching is attempted.
export function mergeLegacyFallbackGames(libretroGames, openGoodGames) {
  const merged = libretroGames.map((game) => ({ ...game, components: [...game.components] }));
  const owners = new Map();
  const preferredNameOwners = new Set();
  const legacyNameOwners = new Map();
  const registerLegacyName = (name, game) => {
    if (!name) return;
    const existing = legacyNameOwners.get(name);
    if (existing !== undefined && existing !== game) {
      legacyNameOwners.set(name, null);
      return;
    }
    legacyNameOwners.set(name, game);
  };
  const addOwner = (game, component) => {
    for (const key of componentKeys(component)) owners.set(key, game);
  };
  for (const game of merged) for (const component of game.components) addOwner(game, component);

  // The current OpenGood record must register its name before the older
  // headered record is merged. This also makes the result independent of the
  // order in which callers collect the source files.
  const orderedFallbacks = [...openGoodGames].sort(
    (left, right) =>
      Number(left.sourceVariant === "headered") - Number(right.sourceVariant === "headered"),
  );
  for (const fallback of orderedFallbacks) {
    const exactOwner = fallback.components
      .flatMap(componentKeys)
      .map((key) => owners.get(key))
      .find(Boolean);
    const namedOwner =
      fallback.sourceVariant === "headered" ? legacyNameOwners.get(fallback.name) : undefined;
    const owner = exactOwner ?? namedOwner ?? undefined;
    if (!owner) {
      const copy = { ...fallback, components: [...fallback.components] };
      merged.push(copy);
      for (const component of copy.components) addOwner(copy, component);
      registerLegacyName(copy.name, copy);
      continue;
    }
    registerLegacyName(fallback.name, owner);
    owner.provenance = mergeProvenance(owner.provenance, fallback.provenance);
    owner.dumpTags = [...new Set([...owner.dumpTags, ...fallback.dumpTags])].sort();
    // OpenGood retains the filename-style name, which can carry revision and
    // dump tags that the Libretro record omits. Prefer it when both sources
    // describe the same dump, and keep every other name available.
    const names = [...(owner.alternateNames ?? []), ...(fallback.alternateNames ?? [])];
    if (!preferredNameOwners.has(owner)) {
      names.push(owner.name);
      owner.name = fallback.name;
      preferredNameOwners.add(owner);
    } else if (fallback.name !== owner.name) {
      names.push(fallback.name);
    }
    owner.alternateNames = [...new Set(names.filter((name) => name !== owner.name))].sort();
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

async function openGoodFingerprint(platform, ctx) {
  const fingerprint = [];
  for (const datFile of OPENGOOD_PLATFORMS[platform]) {
    const info = await stat(ctx.openGoodPaths.get(datFile));
    fingerprint.push({ datFile, mtimeMs: Math.trunc(info.mtimeMs), sizeBytes: info.size });
  }
  return fingerprint;
}

function platformRowPaths(cacheDir, slug) {
  const dir = path.join(cacheDir, "identify-rows");
  return {
    dir,
    manifestPath: path.join(dir, `${slug}.manifest.json`),
    rowsPath: path.join(dir, `${slug}.tsv`),
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

function rowsCacheValid(manifest, fingerprint, source, maxObjects) {
  if (!manifest || manifest.format !== ROW_CACHE_FORMAT) return false;
  if (manifest.source !== source) return false;
  if (manifest.maxObjects !== (maxObjects ?? null)) return false;
  return JSON.stringify(manifest.fingerprint) === JSON.stringify(fingerprint);
}

async function produceOpenGoodRows(platform, state, ctx) {
  for (const datFile of OPENGOOD_PLATFORMS[platform]) {
    if (state.stopParsing) break;
    const text = await readFile(ctx.openGoodPaths.get(datFile), "utf8");
    await parseOpenGoodDat(text, platform, state);
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

// Build (or reuse a cached) normalized rows.tsv for a single OpenGood platform.
// Each platform is cached independently so re-runs only rebuild what changed.
export async function buildPlatformRows(platform, ctx) {
  const source = "opengood";
  const slug = slugifyPlatform(platform);
  const paths = platformRowPaths(ctx.cacheDir, slug);
  const fingerprint = await openGoodFingerprint(platform, ctx);

  const rowsStat = await fileStat(paths.rowsPath);
  const manifest = await readJsonFile(paths.manifestPath);
  if (
    rowsStat?.isFile() &&
    !ctx.forceRowCache &&
    rowsCacheValid(manifest, fingerprint, source, ctx.maxObjects)
  ) {
    console.error(`[identify] ${platform}: using cached rows (${formatBytes(rowsStat.size)})`);
    return { ...paths, manifest, slug, source };
  }

  await mkdir(paths.dir, { recursive: true });
  const tempRowsPath = `${paths.rowsPath}.part`;
  const stream = createWriteStream(tempRowsPath);
  const state = {
    jsonObjects: 0,
    maxObjects: ctx.maxObjects,
    romRows: 0,
    rowsMissingAllHashes: 0,
    rowsWithAnyHash: 0,
    stopParsing: false,
    stream,
  };

  console.error(`[identify] ${platform}: extracting rows from ${source}`);
  await produceOpenGoodRows(platform, state, ctx);

  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(resolve);
  });
  await rename(tempRowsPath, paths.rowsPath);

  const nextManifest = {
    format: ROW_CACHE_FORMAT,
    generatedAt: ctx.generatedAt,
    platform,
    source,
    fingerprint,
    maxObjects: ctx.maxObjects ?? null,
    stats: {
      gameObjects: state.jsonObjects,
      romRows: state.romRows,
      rowsMissingAllHashes: state.rowsMissingAllHashes,
      rowsWithAnyHash: state.rowsWithAnyHash,
    },
  };
  await writeFile(paths.manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  const written = await stat(paths.rowsPath);
  console.error(
    `[identify] ${platform}: wrote rows (${formatBytes(written.size)}, ` +
      `${state.rowsWithAnyHash.toLocaleString("en-US")} hash row(s))`,
  );
  return { ...paths, manifest: nextManifest, slug, source };
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

function writePack(entries, magic = PACK_MAGIC_V1) {
  const headerBytes =
    magic.length +
    4 +
    entries.reduce((sum, entry) => sum + 2 + 8 + Buffer.byteLength(entry.name, "utf8"), 0);
  const payloadBytes = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const buffer = Buffer.allocUnsafe(headerBytes + payloadBytes);
  magic.copy(buffer, 0);
  let cursor = magic.length;
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
      `[identify] skipped ${skippedOverCaps} game record(s) that exceed the RWFP1 reader caps`,
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

// Mark components byte-identical across MORE THAN ONE game (same size plus the
// same md5 or the same sha1) as non-discriminating. They stay in games.json but
// are excluded from route.bin: a shared CD audio track can never pick one game.
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

function buildStringTable(values) {
  const strings = [...new Set(values.filter((value) => value !== undefined).map(String))].sort(
    (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  const ids = new Map(strings.map((value, index) => [value, index]));
  return { ids, values: strings };
}

function encodeUvarint(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new Error("RWFP1 variable integer cannot be negative");
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function variableTable(magic, count, records) {
  return Buffer.concat([
    Buffer.from(magic, "ascii"),
    Buffer.from([1]),
    encodeUvarint(count),
    ...records,
  ]);
}

function buildRwfp5Tables(platform, source, games) {
  const stringValues = [];
  for (const game of games) {
    stringValues.push(
      game.name,
      game.gameId,
      game.region,
      game.language,
      game.revision,
      game.parent,
      ...(game.dumpTags ?? []),
      ...(game.alternateNames ?? []),
    );
    for (const component of game.components)
      stringValues.push(component.filename, component.hashScope ?? "full_file");
  }
  const strings = buildStringTable(stringValues);
  const stringId = (value) => {
    if (value === undefined) return undefined;
    return strings.ids.get(String(value));
  };
  const hashByKey = new Map();
  const hashes = [];
  const componentHashes = [];
  for (const game of games) {
    if (game.platform !== platform)
      throw new Error(`RWFP1 game platform does not match pack: ${game.name}`);
    if (game.source !== source)
      throw new Error(`RWFP1 game source does not match pack: ${game.name}`);
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
      componentHashes.push(key);
    }
  }
  hashes.sort((a, b) => {
    const sizeA = BigInt(a.size);
    const sizeB = BigInt(b.size);
    if (sizeA !== sizeB) return sizeA < sizeB ? -1 : 1;
    return (
      Buffer.compare(Buffer.from(a.scope), Buffer.from(b.scope)) ||
      Buffer.compare(Buffer.from(a.key), Buffer.from(b.key))
    );
  });
  hashByKey.clear();
  hashes.forEach((hash, index) => hashByKey.set(hash.key, index));
  const hashRows = [];
  let priorSize = 0n;
  for (const hash of hashes) {
    const size = BigInt(hash.size);
    const scope =
      hash.scope === "full_file"
        ? [0]
        : hash.scope === "track_file"
          ? [1]
          : [255, encodeUvarint(stringId(hash.scope))];
    const mask =
      (hash.crc32 ? 1 : 0) | (hash.md5 ? 2 : 0) | (hash.sha1 ? 4 : 0) | (hash.sha256 ? 8 : 0);
    const values = [];
    for (const field of ["crc32", "md5", "sha1", "sha256"])
      if (hash[field]) values.push(Buffer.from(hash[field], "hex"));
    hashRows.push(
      Buffer.concat([
        encodeUvarint(size - priorSize),
        Buffer.concat(scope.map((v) => (Buffer.isBuffer(v) ? v : Buffer.from([v])))),
        Buffer.from([mask]),
        ...values,
      ]),
    );
    priorSize = size;
  }
  const components = [];
  games.forEach((game) =>
    game.components.forEach((component) =>
      components.push({ component, hashId: hashByKey.get(componentHashes[components.length]) }),
    ),
  );
  const componentRows = components.map(({ component, hashId }) => {
    let presence = 0;
    const values = [encodeUvarint(hashId)];
    if (component.filename !== undefined) {
      presence |= 1;
      values.push(encodeUvarint(stringId(component.filename)));
    }
    if (component.track !== undefined) {
      presence |= 2;
      values.push(encodeUvarint(component.track));
    }
    if (component.session !== undefined) {
      presence |= 4;
      values.push(encodeUvarint(component.session));
    }
    return Buffer.concat([
      values[0],
      Buffer.from([presence]),
      ...values.slice(1),
      Buffer.from([
        ROLE_CODES[component.role ?? "primary_payload"],
        (component.required === false ? 0 : 1) | (component.discriminating ? 2 : 0),
      ]),
    ]);
  });
  const provenance = [];
  const provenanceIds = new Map();
  const intern = (value, table, ids) => {
    const key = JSON.stringify(value);
    let id = ids.get(key);
    if (id === undefined) {
      id = table.length;
      ids.set(key, id);
      table.push(value);
    }
    return id;
  };
  const provenanceSets = games.map((game) =>
    (game.provenance ?? []).map((value) => intern(value, provenance, provenanceIds)),
  );
  const tagSets = games.map((game) => (game.dumpTags ?? []).map(stringId));
  const internSets = (sets) => {
    const unique = [[]];
    const ids = new Map([["[]", 0]]);
    const mapped = sets.map((set) => {
      const key = JSON.stringify(set);
      if (!ids.has(key)) ids.set(key, unique.push(set) - 1);
      return ids.get(key);
    });
    return { unique, mapped };
  };
  const pSets = internSets(provenanceSets);
  const tSets = internSets(tagSets);
  const gameRows = games.map((game, index) => {
    let presence = 0;
    const values = [encodeUvarint(stringId(game.name))];
    const trailing = [];
    const optional = [
      ["gameId", 0],
      ["region", 1],
      ["language", 2],
      ["revision", 3],
      ["parent", 4],
    ];
    optional.forEach(([field, bit]) => {
      if (game[field] !== undefined) {
        presence |= 1 << bit;
        values.push(encodeUvarint(stringId(game[field])));
      }
    });
    if (game.discNumber !== undefined) {
      presence |= 1 << 5;
      trailing.push(encodeUvarint(game.discNumber));
    }
    const upstream = game.upstreamSource ?? "unknown";
    if (upstream !== "unknown") {
      presence |= 1 << 6;
      trailing.push(encodeUvarint(UPSTREAM_CODES[upstream]));
    }
    if (game.legacyVariant) presence |= 1 << 7;
    values.push(
      encodeUvarint(game.components.length),
      encodeUvarint(pSets.mapped[index]),
      encodeUvarint(tSets.mapped[index]),
      ...trailing,
    );
    return Buffer.concat([values[0], Buffer.from([presence]), ...values.slice(1)]);
  });
  // One row per game, in the game table's order. The member is written only
  // when a game carries an alternate name, so a pack without any keeps the
  // exact bytes it had before the member existed.
  const alternateNameRows = games.map((game) => {
    const ids = [...new Set((game.alternateNames ?? []).map(stringId))].sort((a, b) => a - b);
    return Buffer.concat([encodeUvarint(ids.length), ...ids.map(encodeUvarint)]);
  });
  const hasAlternateNames = games.some((game) => (game.alternateNames ?? []).length > 0);
  const ownerRows = hashes.map((_, hashId) => {
    const owners = [];
    components.forEach(({ hashId: id }, componentId) => {
      if (id === hashId) owners.push(componentId);
    });
    let prior = 0;
    return Buffer.concat([
      encodeUvarint(owners.length),
      ...owners.map((id) => {
        const delta = id - prior;
        prior = id;
        return encodeUvarint(delta);
      }),
    ]);
  });
  const routeIds = hashes
    .map((hash, id) => ({ hash, id }))
    .filter(
      ({ hash, id }) =>
        hash.crc32 &&
        hash.size > 0 &&
        components.some(
          (component) => component.hashId === id && component.component.discriminating,
        ),
    )
    .sort((a, b) =>
      a.hash.crc32 < b.hash.crc32
        ? -1
        : a.hash.crc32 > b.hash.crc32
          ? 1
          : Number(a.hash.size) - Number(b.hash.size) ||
            Buffer.compare(Buffer.from(a.hash.scope), Buffer.from(b.hash.scope)) ||
            a.id - b.id,
    )
    .map(({ id }) => id);
  const setRows = (sets) =>
    sets.unique.flatMap((set) => [encodeUvarint(set.length), ...set.map(encodeUvarint)]);
  return {
    componentCount: components.length,
    hashCount: hashes.length,
    provenance,
    routedKeys: routeIds.length,
    members: [
      {
        name: "strings.bin",
        bytes: variableTable(
          "RWS5",
          strings.values.length,
          strings.values.map((value) =>
            Buffer.concat([encodeUvarint(Buffer.byteLength(value)), Buffer.from(value)]),
          ),
        ),
      },
      { name: "hashes.bin", bytes: variableTable("RWH5", hashes.length, hashRows) },
      { name: "components.bin", bytes: variableTable("RWC5", components.length, componentRows) },
      { name: "games.bin", bytes: variableTable("RWG5", games.length, gameRows) },
      { name: "owners.bin", bytes: variableTable("RWO5", hashes.length, ownerRows) },
      {
        name: "routes.bin",
        bytes: variableTable("RWR5", routeIds.length, routeIds.map(encodeUvarint)),
      },
      {
        name: "sets.bin",
        bytes: Buffer.concat([
          Buffer.from("RWX5", "ascii"),
          Buffer.from([1]),
          encodeUvarint(pSets.unique.length),
          ...setRows(pSets),
          encodeUvarint(tSets.unique.length),
          ...setRows(tSets),
        ]),
      },
      ...(hasAlternateNames
        ? [
            {
              name: "alternate-names.bin",
              bytes: variableTable("RWN5", games.length, alternateNameRows),
            },
          ]
        : []),
    ],
  };
}

export function buildSystemPackV1(platform, games, source = "libretro") {
  const sharedComponents = markSharedComponents(games);
  const tables = buildRwfp5Tables(platform, source, games);
  const manifest = {
    format: INDEX_FORMAT,
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
  const pack = writePack(
    [
      ...tables.members,
      { name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest), "utf8") },
    ],
    PACK_MAGIC_V1,
  );
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
  const goodToolsHeaders = [];
  for (const fallbackFile of fallbackFiles) {
    const parsed = parseOpenGoodGames(
      await readFile(paths.opengood.get(fallbackFile), "utf8"),
      platform,
      fallbackFile,
      { sourceVariant: "current" },
    );
    fallback.push(...parsed.games);
    openGoodHeaders.push({ datFile: fallbackFile, revision: OPENGOOD_REVISION, ...parsed.header });
  }
  for (const fallbackFile of OPENGOOD_HEADERED_FALLBACKS[platform] ?? []) {
    const parsed = parseOpenGoodGames(
      await readFile(paths.opengoodHeadered.get(fallbackFile), "utf8"),
      platform,
      fallbackFile,
      { revision: OPENGOOD_HEADERED_REVISION, sourceVariant: "headered" },
    );
    fallback.push(...parsed.games);
    openGoodHeaders.push({
      datFile: fallbackFile,
      revision: OPENGOOD_HEADERED_REVISION,
      ...parsed.header,
    });
  }
  if (GOODTOOLS_HEADERED_FALLBACKS[platform]) {
    const parsed = parseGoodToolsHeaderedGames(
      await readFile(paths.goodToolsHeadered, "utf8"),
      platform,
    );
    fallback.push(...parsed.games);
    goodToolsHeaders.push({
      datFile: GOODTOOLS_DAT_PATH,
      release: GOODTOOLS_RELEASE,
      ...parsed.header,
    });
  }
  const source = sourcePaths.length ? "libretro" : "opengood";
  const games = sortGames(mergeLegacyFallbackGames(libretro, fallback)).map((game) => {
    const { sourceVariant: _sourceVariant, ...withoutSourceVariant } = game;
    return { ...withoutSourceVariant, platform, source };
  });
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
        commit: header.revision,
        generationDate: header.date ?? null,
        license: OPENGOOD_LICENSE,
        name: "SnowflakePowered/opengood",
        path: `dats/${header.datFile}`,
        url: `${OPENGOOD_REPOSITORY}/blob/${header.revision}/dats/${encodeURIComponent(header.datFile)}`,
      })),
      goodTools: goodToolsHeaders.map((header) => ({
        commit: header.release,
        generationDate: header.date ?? null,
        license: GOODTOOLS_LICENSE,
        name: "Eggmansworld/Datfiles",
        path: GOODTOOLS_DAT_PATH,
        url: `${GOODTOOLS_REPOSITORY}/releases/tag/${GOODTOOLS_RELEASE}`,
      })),
    },
    source,
  };
}

const CHECKSUM_ROUTER_FILE = "checksum-routes.bin";
const CHECKSUM_ROUTER_ALGORITHMS = ["crc32", "md5", "sha1"];
// Self-test sample per pack. A miss on a key the pack owns means the filter is
// wrong, so the build MUST fail instead of shipping a router that hides games.
const CHECKSUM_ROUTER_SAMPLE = 64;

/** Evenly strided keys across the pack, so the self-test is not just the first rows. */
function sampleRouterKeys(keys) {
  if (keys.length <= CHECKSUM_ROUTER_SAMPLE) return keys.slice();
  const stride = keys.length / CHECKSUM_ROUTER_SAMPLE;
  return Array.from({ length: CHECKSUM_ROUTER_SAMPLE }, (_, i) => keys[Math.floor(i * stride)]);
}

// Every routable digest in a pack, deduplicated. sha256 is skipped: the router
// only answers the algorithms a user can paste.
function collectRouterKeys(games) {
  const keys = new Map();
  for (const game of games) {
    for (const component of game.components) {
      for (const algorithm of CHECKSUM_ROUTER_ALGORITHMS) {
        const value = component[algorithm];
        if (!value) continue;
        const hex = value.toLowerCase();
        keys.set(`${algorithm}:${hex}`, { algorithm, hex });
      }
    }
  }
  return [...keys.values()];
}

async function writeChecksumRouter(filters, samples, options) {
  const bytes = Buffer.from(encodeChecksumRouter(filters));
  const router = parseChecksumRouter(bytes);
  for (const { slug, keys } of samples) {
    for (const key of keys) {
      if (!routeChecksums(router, [key.hex]).includes(slug)) {
        throw new Error(
          `checksum router self-test failed: ${key.algorithm} ${key.hex} does not route to ${slug}`,
        );
      }
    }
  }
  const outPath = path.join(options.outPath, CHECKSUM_ROUTER_FILE);
  await writeFile(outPath, bytes);
  const entry = {
    format: CHECKSUM_ROUTER_FORMAT,
    file: CHECKSUM_ROUTER_FILE,
    rawBytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    packs: filters.length,
  };
  if (options.brotli) {
    const compressed = brotliCompressBuffer(bytes, {
      parameterProfile: "default",
      quality: options.brotliQuality,
    });
    await writeFile(`${outPath}.br`, compressed);
    entry.brotliFile = `${CHECKSUM_ROUTER_FILE}.br`;
    entry.brotliBytes = compressed.length;
  }
  console.error(
    `[identify] wrote ${CHECKSUM_ROUTER_FILE} (${formatBytes(entry.rawBytes)}` +
      `${entry.brotliBytes ? `, br ${formatBytes(entry.brotliBytes)}` : ""}` +
      `, ${filters.length} pack(s))`,
  );
  return entry;
}

async function writeSystemPackV1(platform, gamesInfo, options) {
  console.error(`[identify] ${platform}: building RWFP1 pack`);
  const games = gamesInfo.games;
  const { componentCount, pack, routedKeys, sharedComponents } = buildSystemPackV1(
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
    packFormat: "RWFP1",
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
    const compressed = brotliCompressBuffer(pack, {
      parameterProfile: "default",
      quality: options.brotliQuality,
    });
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
      packFormat: system.packFormat ?? "RWFP1",
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
  const neededOpenGoodHeadered = new Set();
  const neededGoodToolsHeadered = new Set();
  for (const platform of selected) {
    for (const sourcePath of LIBRETRO_PLATFORM_PATHS[platform] ?? [])
      neededLibretro.add(sourcePath);
    for (const datFile of COMPLETE_OPENGOOD_FALLBACKS[platform] ??
      OPENGOOD_STANDALONE_PLATFORMS[platform] ??
      []) {
      neededOpenGood.add(datFile);
    }
    for (const datFile of OPENGOOD_HEADERED_FALLBACKS[platform] ?? []) {
      neededOpenGoodHeadered.add(datFile);
    }
    if (GOODTOOLS_HEADERED_FALLBACKS[platform]) neededGoodToolsHeadered.add(platform);
  }
  const paths = {
    libretro: await ensureLibretroDats([...neededLibretro].sort(), options.cacheDir),
    opengood: await ensureOpenGoodDats([...neededOpenGood].sort(), options.cacheDir),
    opengoodHeadered: await ensureOpenGoodDats(
      [...neededOpenGoodHeadered].sort(),
      options.cacheDir,
      OPENGOOD_HEADERED_REVISION,
      "opengood-headered",
    ),
    goodToolsHeadered: neededGoodToolsHeadered.size
      ? await ensureGoodToolsHeaderedDat(options.cacheDir)
      : undefined,
  };
  if (options.downloadOnly) {
    console.log(
      JSON.stringify(
        {
          libretro: [...neededLibretro].sort(),
          opengood: [...neededOpenGood].sort(),
          opengoodHeadered: [...neededOpenGoodHeadered].sort(),
          goodToolsHeadered: [...neededGoodToolsHeadered].sort(),
        },
        null,
        2,
      ),
    );
    return;
  }

  await mkdir(options.outPath, { recursive: true });
  const systems = [];
  const routerFilters = [];
  const routerSamples = [];
  for (const platform of selected) {
    const games = await readPlatformGames(platform, options, paths);
    const system = await writeSystemPackV1(platform, games, options);
    systems.push(system);
    const keys = collectRouterKeys(games.games);
    routerFilters.push(buildPackFilter(system.slug, keys));
    routerSamples.push({ slug: system.slug, keys: sampleRouterKeys(keys) });
  }
  const checksumRoutes = await writeChecksumRouter(routerFilters, routerSamples, options);

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
        packFormat: "RWFP1",
      },
    );
  }
  const catalog = {
    format: CATALOG_FORMAT,
    generated: {
      opengoodRevision: OPENGOOD_REVISION,
      opengoodHeaderedRevision: OPENGOOD_HEADERED_REVISION,
      goodToolsRelease: GOODTOOLS_RELEASE,
      goodToolsArchiveSha256: GOODTOOLS_ARCHIVE_SHA256,
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
    checksumRoutes,
    hashStrategy: "crc-primary-md5-sha1-fallback-per-system",
    catalog: "catalog.json",
    sources: {
      opengood: {
        url: OPENGOOD_REPOSITORY,
        license: OPENGOOD_LICENSE,
        revision: OPENGOOD_REVISION,
      },
      opengoodHeadered: {
        url: OPENGOOD_REPOSITORY,
        license: OPENGOOD_LICENSE,
        revision: OPENGOOD_HEADERED_REVISION,
      },
      goodToolsHeadered: {
        url: GOODTOOLS_REPOSITORY,
        license: GOODTOOLS_LICENSE,
        release: GOODTOOLS_RELEASE,
        archive: GOODTOOLS_ARCHIVE,
        archiveSha256: GOODTOOLS_ARCHIVE_SHA256,
        datPath: GOODTOOLS_DAT_PATH,
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
        checksumRouterBytes: checksumRoutes.rawBytes,
        checksumRouterHuman: formatBytes(checksumRoutes.rawBytes),
        checksumRouterBrotliBytes: checksumRoutes.brotliBytes ?? 0,
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
