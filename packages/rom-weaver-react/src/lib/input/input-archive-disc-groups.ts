import { type DiscGroupingEntryInput, runRomWeaverGroupDiscEntriesWorker } from "../runtime/wasm-command-runtime.ts";
import { isCueEntryFileName } from "./archive.ts";
import { decodeUtf8, type PatchFileInstance } from "./binary-service.ts";
import {
  type ArchiveEntryLike,
  describeArchiveFileForTrace,
  extractArchiveEntryBytes,
  type InputPreparationOptions,
  type InputPreparationRuntimeLike,
  traceArchivePreparation,
} from "./input-preparation-archive.ts";
import { DEFAULT_INPUT_PREPARATION_RUNTIME } from "./input-preparation-compression.ts";

// Build the entry list Rust's `group-disc-entries` consumes: each listed entry's name + coarse type,
// plus the raw `.cue` text for cue sheets (Rust is no-I/O, so the host extracts the sheet bytes once
// here and passes the text). `.gdi` sheets carry no text — Rust groups them from sibling `track`
// entries. Unreadable cue text is left absent so Rust marks the group as an unreadable CUE.
const buildDiscGroupingEntries = async (
  archiveFile: PatchFileInstance,
  entries: ArchiveEntryLike[],
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike,
): Promise<DiscGroupingEntryInput[]> => {
  const groupingEntries: DiscGroupingEntryInput[] = [];
  for (const entry of entries) {
    const filename = String(entry.filename || "");
    if (!filename) continue;
    const groupingEntry: DiscGroupingEntryInput = { filename };
    if (entry.archiveEntryType) groupingEntry.archiveEntryType = entry.archiveEntryType;
    // Only read `.cue` text — and only when there are no synthetic track entries already (those
    // produce a synthetic group in Rust without parsing). A `.gdi` is never read here.
    const isSheetThatNeedsText =
      isCueEntryFileName(filename) && entry.archiveEntryType !== "cue" && entry.archiveEntryType !== "gdi";
    if (isSheetThatNeedsText) {
      try {
        groupingEntry.sheetText = decodeUtf8(
          await extractArchiveEntryBytes(archiveFile, filename, options, runtime, undefined, { romFilter: true }),
        );
      } catch (_error) {
        // Leave sheetText absent so Rust reports an unreadable CUE.
      }
    }
    groupingEntries.push(groupingEntry);
  }
  return groupingEntries;
};

// Resolve the single ROM entry to auto-select from a container's ROM entries when no explicit
// selection was given, delegating the disc grouping (CUE/GDI reference resolution, identical
// track-set dedup) and the auto-pick decision tree to Rust's `group-disc-entries` command. Throws
// when Rust reports the source is ambiguous (multiple competing input candidates), matching the
// prior behavior so the caller falls through to the interactive ROM descent prompt.
const resolveCompressionRomAutoPickEntryName = async (
  archiveFile: PatchFileInstance,
  entries: ArchiveEntryLike[],
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<string | null> => {
  if (!entries.length) return null;
  const groupingEntries = await buildDiscGroupingEntries(archiveFile, entries, options, runtime);
  const result = await runRomWeaverGroupDiscEntriesWorker({
    entries: groupingEntries,
    logLevel: options?.logging?.level,
    sourceName: archiveFile.fileName,
  });
  traceArchivePreparation(options, "input.archive.disc-grouping", {
    ambiguous: result.autoPick.ambiguous,
    autoPick: result.autoPick.entryName || "",
    discGroups: result.discGroups.length,
    file: describeArchiveFileForTrace(archiveFile),
    standalones: result.standaloneEntries.length,
  });
  if (result.autoPick.ambiguous) {
    throw new Error(`${archiveFile.fileName || "Archive"} contains multiple input candidates`);
  }
  return result.autoPick.entryName;
};

export { resolveCompressionRomAutoPickEntryName };
