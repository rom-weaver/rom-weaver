import { isCueEntryFileName } from "./archive.ts";

type ArchiveRomResolutionOptions<TEntry, TCueInfo, TResult> = {
  entries: TEntry[];
  getCueInfo: (entry: TEntry, entries: TEntry[]) => Promise<TCueInfo | null>;
  chooseEntry: (entries: TEntry[]) => Promise<TEntry>;
  resolveCueInfo: (cueInfo: TCueInfo) => Promise<TResult>;
  resolveEntry: (entry: TEntry) => Promise<TResult>;
  getFileName: (entry: TEntry) => string;
  getNoEntriesMessage?: () => string;
  getInvalidCueMessage?: () => string;
};

const resolveArchiveRomSelection = async <TEntry, TCueInfo, TResult>({
  entries,
  getCueInfo,
  chooseEntry,
  resolveCueInfo,
  resolveEntry,
  getFileName,
  getNoEntriesMessage,
  getInvalidCueMessage,
}: ArchiveRomResolutionOptions<TEntry, TCueInfo, TResult>): Promise<TResult> => {
  const noEntriesMessage = getNoEntriesMessage?.() || "No valid ROM files found in archive";
  const invalidCueMessage = getInvalidCueMessage?.() || "Selected CUE does not reference a valid track in archive";
  if (!entries.length) throw new Error(noEntriesMessage);

  if (entries.length === 2) {
    const cueEntry = entries.find((entry) => isCueEntryFileName(getFileName(entry)));
    if (cueEntry) {
      const cueInfo = await getCueInfo(cueEntry, entries).catch(() => null);
      if (cueInfo) return resolveCueInfo(cueInfo);
    }
  }

  if (entries.length === 1) {
    const onlyEntry = entries[0];
    if (onlyEntry === undefined) throw new Error(noEntriesMessage);
    if (isCueEntryFileName(getFileName(onlyEntry))) {
      const cueInfo = await getCueInfo(onlyEntry, entries);
      if (!cueInfo) throw new Error(invalidCueMessage);
      return resolveCueInfo(cueInfo);
    }
    return resolveEntry(onlyEntry);
  }

  const selectedEntry = await chooseEntry(entries);
  if (selectedEntry === undefined) throw new Error(noEntriesMessage);
  if (isCueEntryFileName(getFileName(selectedEntry))) {
    const cueInfo = await getCueInfo(selectedEntry, entries);
    if (!cueInfo) throw new Error(invalidCueMessage);
    return resolveCueInfo(cueInfo);
  }
  return resolveEntry(selectedEntry);
};

export { resolveArchiveRomSelection };
