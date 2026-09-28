const CUE_REM_LINE_REGEX = /^REM\b/i;
const CUE_FILE_LINE_REGEX = /^FILE\s+"?(.+?)"?\s+(\S+)$/i;
const CUE_TRACK_LINE_REGEX = /^TRACK\s+(\d+)\s+(\S+)$/i;
const CUE_PREGAP_LINE_REGEX = /^PREGAP\b/i;
const CUE_INDEX_00_LINE_REGEX = /^INDEX\s+00\b/i;
const CUE_BINARY_FILE_ENTRY_REGEX = /^(\s*)FILE\s+"?.+?"?\s+BINARY\s*$/im;
const CUE_FILE_REFERENCE_REGEX = /^([ \t]*FILE[ \t]+)"?(.+?)"?([ \t]+\S+[ \t]*)$/gim;
const LINE_BREAK_REGEX = /\r?\n/;

type ChdCueFileEntry = {
  name: string;
  type: string;
};

type ChdCueTrackEntry = {
  number: number;
  mode: string;
  file: ChdCueFileEntry | null;
};

type ParsedCueFile = {
  files: ChdCueFileEntry[];
  tracks: ChdCueTrackEntry[];
  hasPregap: boolean;
  hasIndex00: boolean;
};

const parseCueLine = (trimmed: string, currentFile: ChdCueFileEntry | null, result: ParsedCueFile) => {
  const fileMatch = trimmed.match(CUE_FILE_LINE_REGEX);
  if (fileMatch) {
    const nextFile = {
      name: fileMatch[1] || "",
      type: (fileMatch[2] || "").toUpperCase(),
    };
    result.files.push(nextFile);
    return nextFile;
  }

  const trackMatch = trimmed.match(CUE_TRACK_LINE_REGEX);
  if (trackMatch) {
    result.tracks.push({
      file: currentFile,
      mode: (trackMatch[2] || "").toUpperCase(),
      number: parseInt(trackMatch[1] || "0", 10),
    });
    return currentFile;
  }

  if (CUE_PREGAP_LINE_REGEX.test(trimmed)) result.hasPregap = true;
  else if (CUE_INDEX_00_LINE_REGEX.test(trimmed)) result.hasIndex00 = true;
  return currentFile;
};

const parseCueFile = (cueText: string): ParsedCueFile => {
  const result: ParsedCueFile = {
    files: [],
    hasIndex00: false,
    hasPregap: false,
    tracks: [],
  };
  let currentFile: ChdCueFileEntry | null = null;

  for (const line of String(cueText || "").split(LINE_BREAK_REGEX)) {
    const trimmed = line.trim();
    if (!trimmed || CUE_REM_LINE_REGEX.test(trimmed)) continue;
    currentFile = parseCueLine(trimmed, currentFile, result);
  }

  return result;
};

const replaceCuePatchFileName = (cueText: string, binFileName: string) => {
  let replaced = false;
  const safePatchFileName = String(binFileName || "disc.bin").replace(/"/g, "");
  const updatedCueText = String(cueText || "").replace(CUE_BINARY_FILE_ENTRY_REGEX, (_line, indent: string) => {
    replaced = true;
    return `${indent}FILE "${safePatchFileName}" BINARY`;
  });
  if (!replaced) throw new Error("CD CHD cue does not contain a binary FILE entry");
  return updatedCueText;
};

const replaceCueFileReferences = (cueText: string, resolveFileName: (fileName: string) => string | undefined) =>
  cueText.replace(CUE_FILE_REFERENCE_REGEX, (line, prefix: string, fileName: string, suffix: string) => {
    const replacement = resolveFileName(fileName);
    return replacement ? `${prefix}"${replacement.replace(/"/g, "")}"${suffix}` : line;
  });

export { parseCueFile, replaceCueFileReferences, replaceCuePatchFileName };
