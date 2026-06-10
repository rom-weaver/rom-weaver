import { getFileNameParts } from "../path-utils.ts";

const CRC32_HEX_REGEX = /^[0-9a-f]{8}$/;
// Labelled `crc32:<8 hex>` / `crc32=<8 hex>` token. The separator follows the
// word directly, so `crc32c` (a distinct algorithm) is not matched.
const LABELLED_CRC32_REGEX = /crc32[:=][0-9a-f]{8}(?![0-9a-f])/i;
// Bracket/paren/brace-enclosed bare 8-hex run, which the patch file-name parser
// infers as a crc32 requirement.
const ENCLOSED_BARE_CRC32_REGEX = /[[({][0-9a-f]{8}[\])}]/i;

const normalizeCrc32 = (crc32: string | undefined): string =>
  String(crc32 || "")
    .trim()
    .toLowerCase();

/**
 * Whether `fileName` already encodes a crc32 input requirement (labelled token or
 * a bracket-enclosed bare 8-hex run). Mirrors the Rust parser's crc32 detection
 * closely enough to keep {@link embedSourceCrc32InPatchName} idempotent.
 */
const fileNameEncodesCrc32 = (fileName: string): boolean =>
  LABELLED_CRC32_REGEX.test(fileName) || ENCLOSED_BARE_CRC32_REGEX.test(fileName);

/**
 * Embed a source crc32 into a patch output file name as a `[crc32:<hex>]` token
 * before the extension (for example `hack.ips` -> `hack [crc32:1a2b3c4d].ips`),
 * matching the Rust `patch-create --checksum-name` behaviour so the value round
 * trips back into apply/validate. Returns the name unchanged when the crc32 is
 * missing/invalid or the name already encodes one.
 */
const embedSourceCrc32InPatchName = (fileName: string, crc32: string | undefined): string => {
  const normalizedName = String(fileName || "").trim();
  const hex = normalizeCrc32(crc32);
  if (!(normalizedName && CRC32_HEX_REGEX.test(hex))) return fileName;
  if (fileNameEncodesCrc32(normalizedName)) return normalizedName;
  const { extension, stem } = getFileNameParts(normalizedName, normalizedName);
  const token = `[crc32:${hex}]`;
  return extension ? `${stem} ${token}${extension}` : `${normalizedName} ${token}`;
};

export { embedSourceCrc32InPatchName };
