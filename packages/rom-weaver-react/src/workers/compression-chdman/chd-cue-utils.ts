const CHDMAN_METADATA_TAG_REGEX = /Metadata:\s+Tag='([\s\S]{4})'/;
const CHDMAN_LOGICAL_SIZE_REGEX = /Logical size:\s+([\d,]+)\s+bytes/i;
const LINE_BREAK_REGEX = /\r?\n/;

export type ChdResolvedMode = "raw" | "hd" | "cd" | "dvd";

export type ChdInfo = {
  type: ChdResolvedMode;
  logicalSize: number | null;
  tags: string[];
};

export const buildSingleTrackCue = (binFileName: string, u8array?: { byteLength?: number } | null) => {
  const safePatchFileName = String(binFileName || "disc.bin").replace(/"/g, "");
  const mode = u8array?.byteLength && u8array.byteLength % 2352 === 0 ? "MODE1/2352" : "MODE1/2048";
  return [`FILE "${safePatchFileName}" BINARY`, `  TRACK 01 ${mode}`, "    INDEX 01 00:00:00", ""].join("\n");
};

export type {
  CdExtractionPlan,
  ChdCueFileEntry,
  ChdCueTrackEntry,
  ParsedCueFile,
} from "../protocol/cue-file-utils.ts";
export {
  getSingleTrackCdBinName,
  getSingleTrackCdExtractionPlan,
  parseCueFile,
  replaceCuePatchFileName,
} from "../protocol/cue-file-utils.ts";

export const parseChdInfo = (stdout: string): ChdInfo => {
  const tags: string[] = [];
  let logicalSize: number | null = null;
  for (const line of String(stdout || "").split(LINE_BREAK_REGEX)) {
    const match = line.match(CHDMAN_METADATA_TAG_REGEX);
    if (match) tags.push(match[1] || "");
    const logicalSizeMatch = line.match(CHDMAN_LOGICAL_SIZE_REGEX);
    if (logicalSizeMatch) logicalSize = parseInt((logicalSizeMatch[1] || "").replace(/,/g, ""), 10);
  }

  let type: ChdResolvedMode = "raw";
  if (tags.indexOf("DVD ") !== -1) {
    type = "dvd";
  } else if (
    tags.indexOf("CHCD") !== -1 ||
    tags.indexOf("CHTR") !== -1 ||
    tags.indexOf("CHT2") !== -1 ||
    tags.indexOf("CHGT") !== -1 ||
    tags.indexOf("CHGD") !== -1
  ) {
    type = "cd";
  } else if (tags.indexOf("GDDD") !== -1) {
    type = "hd";
  }

  return {
    logicalSize,
    tags,
    type,
  };
};
