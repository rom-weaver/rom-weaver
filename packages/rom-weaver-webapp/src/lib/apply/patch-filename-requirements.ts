const HEX_DIGIT_REGEX = /^[0-9A-Fa-f]$/;
const ALPHANUMERIC_REGEX = /^[0-9A-Za-z]$/;
const CRC32_HEX_LENGTH = 8;
const CLOSING_BRACKET: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

const readHexRun = (text: string, start: number): number => {
  let end = start;
  while (end < text.length && HEX_DIGIT_REGEX.test(text.charAt(end))) end += 1;
  return end;
};

// `crc32:<hex>` / `crc32=<hex>` with any delimiters around it; the label is the whole alphanumeric
// run before the separator, so `notcrc32:..` does not count.
const collectLabeledCrc32 = (fileName: string, found: string[]): void => {
  let index = 0;
  while (index < fileName.length) {
    const separator = fileName.charAt(index);
    if (separator !== ":" && separator !== "=") {
      index += 1;
      continue;
    }
    let labelStart = index;
    while (labelStart > 0 && ALPHANUMERIC_REGEX.test(fileName.charAt(labelStart - 1))) labelStart -= 1;
    if (fileName.slice(labelStart, index).toLowerCase() === "crc32") {
      const hexEnd = readHexRun(fileName, index + 1);
      if (hexEnd - (index + 1) === CRC32_HEX_LENGTH) {
        found.push(fileName.slice(index + 1, hexEnd).toLowerCase());
        index = hexEnd;
        continue;
      }
    }
    index += 1;
  }
};

// Bracket-enclosed bare 8-digit hex (`[1a2b3c4d]`, `(..)`, `{..}`) is read as a crc32.
const collectEnclosedBareCrc32 = (fileName: string, found: string[]): void => {
  let index = 0;
  while (index < fileName.length) {
    const closing = CLOSING_BRACKET[fileName.charAt(index)];
    if (!closing) {
      index += 1;
      continue;
    }
    const hexEnd = readHexRun(fileName, index + 1);
    if (hexEnd > index + 1 && hexEnd < fileName.length && fileName.charAt(hexEnd) === closing) {
      if (hexEnd - (index + 1) === CRC32_HEX_LENGTH) found.push(fileName.slice(index + 1, hexEnd).toLowerCase());
      index = hexEnd + 1;
      continue;
    }
    index += 1;
  }
};

/**
 * The input CRC32 a patch file name declares, mirroring the crc32 rules of the CLI's
 * `parse_filename_requirements` (crates/rom-weaver-cli/src/patch_filename_checksum.rs). Browser staging
 * mounts sources under sanitized names (`:` becomes `_`), so the engine's ingest never sees the token
 * and the original file name has to be read here. A name that declares two different values yields none.
 */
const parseFilenameCrc32 = (fileName: string | undefined): string | undefined => {
  if (!fileName) return undefined;
  const found: string[] = [];
  collectLabeledCrc32(fileName, found);
  collectEnclosedBareCrc32(fileName, found);
  const [first] = found;
  return first && found.every((value) => value === first) ? first : undefined;
};

export { parseFilenameCrc32 };
