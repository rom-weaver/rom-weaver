import type { RomWeaverEngineErrorCode } from "../../workers/rom-weaver/runner-errors.ts";

const PATCH_FILE_CHECKSUM_INVALID: RomWeaverEngineErrorCode = "patch.file_checksum_invalid";

/** The engine coded the failure as the patch failing its own checksum: the patch file is damaged. */
export const isPatchFileChecksumFailure = (errorCode: string | undefined): boolean =>
  errorCode === PATCH_FILE_CHECKSUM_INVALID;
