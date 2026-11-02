import { ARCHIVE_FILE_EXTENSIONS } from "./file-classification.ts";

/**
 * Trim's supported inputs for the 0x01 drop zone, grouped by platform. Every extension must appear in
 * the generated `ROM_WEAVER_TRIM_INPUT_EXTENSIONS` table (Rust's trim extension list); a unit test
 * checks that, so this list can only narrow the generated one, never drift from it.
 */
const TRIM_SUPPORTED_FILES = [
  { extensions: ["nds", "dsi", "srl"], label: "Nintendo DS/DSi" },
  { extensions: ["gba"], label: "Game Boy Advance" },
  { extensions: ["3ds", "cci", "cxi"], label: "Nintendo 3DS" },
  { extensions: ["xiso", "iso"], label: "Xbox XISO" },
  { extensions: ARCHIVE_FILE_EXTENSIONS, label: "Archives & containers" },
] as const;

/** Platforms named in user-facing Trim copy, in the same order as {@link TRIM_SUPPORTED_FILES}. */
const TRIM_PLATFORM_SUMMARY = "Nintendo DS/DSi, Game Boy Advance, Nintendo 3DS, and Xbox XISO";

export { TRIM_PLATFORM_SUMMARY, TRIM_SUPPORTED_FILES };
