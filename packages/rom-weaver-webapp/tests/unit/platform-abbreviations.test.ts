import { describe, expect, it } from "vitest";

import { abbreviatePlatform } from "../../src/presentation/platform-abbreviations.ts";

/** Every platform in the default identify pack group, spelled the way the
 * packs report it. A miss here is a full platform name in the identify
 * drawer's header chip, which pushes the status chip off a phone screen. */
const DEFAULT_GROUP_PLATFORMS = [
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
];

describe("abbreviatePlatform", () => {
  it.each(DEFAULT_GROUP_PLATFORMS)("abbreviates %s", (platform) => {
    const code = abbreviatePlatform(platform);
    expect(code).not.toBe(platform);
    expect(code.length).toBeLessThanOrEqual(6);
  });

  it("matches the libretro and OpenGood spellings of one platform", () => {
    expect(abbreviatePlatform("Nintendo - Nintendo Entertainment System")).toBe("NES");
    expect(abbreviatePlatform("Nintendo Entertainment System")).toBe("NES");
    expect(abbreviatePlatform("Sega - Mega Drive - Genesis")).toBe("GEN");
    expect(abbreviatePlatform("Sega Mega Drive _ Genesis")).toBe("GEN");
  });

  it("ignores case and punctuation, because packs report upper case", () => {
    expect(abbreviatePlatform("NINTENDO - NINTENDO 64")).toBe("N64");
    expect(abbreviatePlatform("sony - playstation")).toBe("PSX");
  });

  it("returns an unknown platform unchanged", () => {
    expect(abbreviatePlatform("Acme - Wonder Machine")).toBe("Acme - Wonder Machine");
  });
});
