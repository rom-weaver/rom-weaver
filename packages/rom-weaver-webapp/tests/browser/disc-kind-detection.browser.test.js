import { expect, test } from "vitest";
import { getDiscFormatLabel } from "../../src/lib/input/rom-specific-file-utils.ts";
import { buildCompressPanel } from "../../src/public/react/compress-options.ts";

// The UI reads the disc-medium label from Rust metadata.format; filename and cue-text guesses cannot supply it.

test("getDiscFormatLabel maps the engine disc_format verdict to a media label", () => {
  expect(getDiscFormatLabel("GD-ROM")).toBe("GD-ROM");
  expect(getDiscFormatLabel("CD")).toBe("CD-ROM");
  expect(getDiscFormatLabel("DVD")).toBe("DVD");
  // Case/whitespace-insensitive against the wire value.
  expect(getDiscFormatLabel(" gd-rom ")).toBe("GD-ROM");
});

test("getDiscFormatLabel returns null for an absent or unknown verdict", () => {
  expect(getDiscFormatLabel(undefined)).toBeNull();
  expect(getDiscFormatLabel("")).toBeNull();
  expect(getDiscFormatLabel("cartridge")).toBeNull();
});

test("CHD output panel note surfaces the engine-detected disc type", () => {
  const gdPanel = buildCompressPanel("chd", {}, { fileName: "game.cue", metadata: { format: "GD-ROM", mode: "cd" } });
  expect(gdPanel?.note).toBe("GD-ROM");

  const cdPanel = buildCompressPanel("chd", {}, { fileName: "disc.cue", metadata: { format: "CD", mode: "cd" } });
  expect(cdPanel?.note).toBe("CD-ROM");
});

test("CHD output panel omits the disc label when the engine reports no medium", () => {
  // An unidentifiable disc has no engine verdict; the codecs still resolve via
  // `metadata.mode`, but no cosmetic medium note is shown (no TS regex guess).
  const panel = buildCompressPanel("chd", {}, { fileName: "disc.cue", metadata: { mode: "cd" } });
  expect(panel?.note).toBeUndefined();
  // The codec chip still reports what the run will use.
  expect(panel?.fields[0]?.chip.value).toBeTruthy();
});
