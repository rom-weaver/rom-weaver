import { expect, test } from "vitest";
import { getDiscFormatLabel } from "../../src/lib/input/rom-specific-file-utils.ts";
import { buildCompressPanel } from "../../src/public/react/compress-options.ts";

// The disc-media label is now driven by the engine's `disc_format` verdict
// (Rust `rom_identity::DiscFormat::label()` — "CD"/"GD-ROM"/"DVD") threaded onto
// the compress source as `metadata.format`, not a TS filename/cue-text regex.

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

test("CHD output panel summary surfaces the engine-detected disc type", () => {
  const gdPanel = buildCompressPanel("chd", {}, { fileName: "game.cue", metadata: { format: "GD-ROM", mode: "cd" } });
  expect(gdPanel?.summary).toMatch(/^GD-ROM ·/);

  const cdPanel = buildCompressPanel("chd", {}, { fileName: "disc.cue", metadata: { format: "CD", mode: "cd" } });
  expect(cdPanel?.summary).toMatch(/^CD-ROM ·/);
});

test("CHD output panel omits the disc label when the engine reports no medium", () => {
  // An unidentifiable disc has no engine verdict; the codecs still resolve via
  // `metadata.mode`, but no cosmetic medium prefix is shown (no TS regex guess).
  const panel = buildCompressPanel("chd", {}, { fileName: "disc.cue", metadata: { mode: "cd" } });
  expect(panel?.summary).not.toMatch(/·/);
});
