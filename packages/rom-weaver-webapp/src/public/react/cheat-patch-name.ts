/**
 * Shared naming rules for a patch built from cheats. Both the create workflow's
 * cheat-codes mode and the apply workflow's "Save as patch" name a patch after
 * the ROM plus the cheats that went into it, so the sanitizing and the length
 * cap live here rather than in either caller.
 */

/** Characters no common file system accepts in a name. */
const UNSAFE_FILE_NAME_CHARACTERS = /[/\\:*?"<>|]/gu;

/**
 * Past this many characters the descriptions stop identifying the patch and
 * start breaking name columns and archive members, so the suffix is cut short.
 */
const MAX_DESCRIPTION_SUFFIX_LENGTH = 80;

/** Replace characters a file name cannot carry, keeping the text readable. */
const sanitizeCheatPatchNamePart = (value: string): string =>
  String(value || "")
    .replace(UNSAFE_FILE_NAME_CHARACTERS, "-")
    .trim();

/** Sanitize the assembled description suffix and cap its length with an ellipsis. */
const toCheatPatchNameSuffix = (value: string): string => {
  const sanitized = sanitizeCheatPatchNamePart(value);
  if (sanitized.length <= MAX_DESCRIPTION_SUFFIX_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_DESCRIPTION_SUFFIX_LENGTH).trimEnd()}…`;
};

export { sanitizeCheatPatchNamePart, toCheatPatchNameSuffix };
