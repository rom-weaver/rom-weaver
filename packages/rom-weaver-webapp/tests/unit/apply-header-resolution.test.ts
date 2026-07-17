import { describe, expect, it } from "vitest";
import { resolveApplyHeaderMode } from "../../src/lib/workflow/apply-header-resolution.ts";
import type { ChecksumVariant } from "../../src/types/checksum.ts";

/**
 * The header decision mirrors the CLI's `--patch-header auto` rule: strip only when
 * the patch's required input crc32 provably matches the ROM's headerless
 * (remove-header) variant; keep on raw matches or any doubt; no resolution at all
 * when the ROM has no strippable header (nothing to show in the drawer).
 */

const RAW_CRC = "11111111";
const HEADERLESS_CRC = "22222222";

const removeHeaderVariant = (overrides?: Partial<ChecksumVariant>): ChecksumVariant => ({
  applyCompatibility: { removeHeader: true, strip_header: true },
  checksums: { crc32: HEADERLESS_CRC },
  id: "remove-header",
  label: "Remove header",
  transforms: { removeHeader: { profile: "No-Intro_NES.xml", strippedBytes: 16 } },
  ...overrides,
});

const target = (variants?: ChecksumVariant[]) => ({
  checksums: { crc32: RAW_CRC },
  checksumVariants: variants,
});

describe("resolveApplyHeaderMode", () => {
  it("returns undefined when the ROM has no strippable-header variant", () => {
    expect(resolveApplyHeaderMode({ sourceCrc32: HEADERLESS_CRC }, target())).toBeUndefined();
    expect(
      resolveApplyHeaderMode({ sourceCrc32: HEADERLESS_CRC }, target([{ checksums: {}, id: "raw", label: "Raw" }])),
    ).toBeUndefined();
  });

  it("decides remove when the required crc32 matches the headerless variant", () => {
    const resolution = resolveApplyHeaderMode({ sourceCrc32: HEADERLESS_CRC }, target([removeHeaderVariant()]));
    expect(resolution).toEqual({
      decided: true,
      headerlessChecksums: { crc32: HEADERLESS_CRC },
      headerlessCrc32: HEADERLESS_CRC,
      mode: "strip",
      strippedBytes: 16,
    });
  });

  it("decides keep when the required crc32 matches the raw bytes", () => {
    const resolution = resolveApplyHeaderMode({ sourceCrc32: RAW_CRC }, target([removeHeaderVariant()]));
    expect(resolution?.decided).toBe(true);
    expect(resolution?.mode).toBe("keep");
  });

  it("is undecided (default keep) without any required checksum", () => {
    const resolution = resolveApplyHeaderMode(undefined, target([removeHeaderVariant()]));
    expect(resolution).toEqual({
      decided: false,
      headerlessChecksums: { crc32: HEADERLESS_CRC },
      headerlessCrc32: HEADERLESS_CRC,
      mode: "keep",
      strippedBytes: 16,
    });
  });

  it("is undecided (default keep) when the requirement matches neither variant", () => {
    const resolution = resolveApplyHeaderMode({ sourceCrc32: "deadbeef" }, target([removeHeaderVariant()]));
    expect(resolution?.decided).toBe(false);
    expect(resolution?.mode).toBe("keep");
  });

  it("falls back to the filename crc32 token when no checksum is embedded", () => {
    const resolution = resolveApplyHeaderMode({ filenameCrc32: HEADERLESS_CRC }, target([removeHeaderVariant()]));
    expect(resolution?.decided).toBe(true);
    expect(resolution?.mode).toBe("strip");
  });

  it("carries the engine's retain-on-output classification for copier-junk headers", () => {
    const variant = removeHeaderVariant({
      transforms: { removeHeader: { profile: "SNES_COPIER_HEADER", retainOnOutput: false, strippedBytes: 512 } },
    });
    const resolution = resolveApplyHeaderMode({ sourceCrc32: HEADERLESS_CRC }, target([variant]));
    expect(resolution?.mode).toBe("strip");
    expect(resolution?.retainOnOutput).toBe(false);
    expect(resolution?.strippedBytes).toBe(512);
  });

  it("carries the engine's headered/headerless extension pair", () => {
    const variant = removeHeaderVariant({
      transforms: {
        removeHeader: {
          headeredExtension: ".smc",
          headerlessExtension: ".sfc",
          profile: "SNES_COPIER_HEADER",
          retainOnOutput: false,
          strippedBytes: 512,
        },
      },
    });
    const resolution = resolveApplyHeaderMode({ sourceCrc32: HEADERLESS_CRC }, target([variant]));
    expect(resolution?.headeredExtension).toBe(".smc");
    expect(resolution?.headerlessExtension).toBe(".sfc");
  });

  it("normalizes crc32 spellings before comparing", () => {
    const resolution = resolveApplyHeaderMode(
      { sourceCrc32: `0X${HEADERLESS_CRC.toUpperCase()}` },
      target([removeHeaderVariant()]),
    );
    expect(resolution?.mode).toBe("strip");
  });
});
