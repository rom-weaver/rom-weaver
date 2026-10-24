// A `.gdi` track line is `num lba type sectorSize filename fileOffset`; the
// filename (5th column) may be quoted. The first non-empty line is the track
// count. Returns the referenced data-file names in order.
const parseGdiFileReferences = (gdiText: string): string[] => {
  const lines = gdiText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const references: string[] = [];
  for (const line of lines.slice(1)) {
    const match = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+(?:"([^"]+)"|(\S+))/);
    const name = match?.[1] ?? match?.[2];
    if (name) references.push(name);
  }
  return references;
};

const replaceGdiFileReferences = (gdiText: string, replace: (name: string) => string | undefined): string =>
  gdiText.replace(
    /^([ \t]*\d+[ \t]+\d+[ \t]+\d+[ \t]+\d+[ \t]+)(?:"([^"\r\n]+)"|([^\s"\r\n]+))/gm,
    (line, prefix: string, quoted: string | undefined, bare: string | undefined) => {
      const name = quoted ?? bare ?? "";
      const replacement = replace(name);
      return replacement && replacement !== name ? `${prefix}"${replacement}"` : line;
    },
  );

export { parseGdiFileReferences, replaceGdiFileReferences };
