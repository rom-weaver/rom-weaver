import {
  filterValidPatchEntries as filterValidPatchEntriesCore,
  filterValidPatchEntriesFromFile as filterValidPatchEntriesFromFileCore,
} from "../../protocol/archive-patch-validation.ts";
import PatchFile from "../../shared/file-io/patch-file.ts";

type CoreBufferPatchValidationOptions = Parameters<typeof filterValidPatchEntriesCore>[0];
type CoreFilePatchValidationOptions = Parameters<typeof filterValidPatchEntriesFromFileCore>[0];
type BufferPatchValidationOptions = Omit<CoreBufferPatchValidationOptions, "PatchFileClass">;
type FilePatchValidationOptions = Omit<CoreFilePatchValidationOptions, "PatchFileClass">;

const filterValidPatchEntries = (options: BufferPatchValidationOptions) =>
  filterValidPatchEntriesCore({
    ...options,
    PatchFileClass: PatchFile,
  });

const filterValidPatchEntriesFromFile = (options: FilePatchValidationOptions) =>
  filterValidPatchEntriesFromFileCore({
    ...options,
    PatchFileClass: PatchFile,
  });

export { filterValidPatchEntries, filterValidPatchEntriesFromFile };
