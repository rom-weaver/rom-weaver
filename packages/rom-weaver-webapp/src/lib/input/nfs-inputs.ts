const isNfsPartName = (name: string) => /^hif_\d{6}\.nfs$/i.test(name);

const directoryOf = (file: File) => {
  const path = (file.webkitRelativePath || "").replaceAll("\\", "/");
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
};

const groupNfsFiles = (files: readonly File[]): [File, ...File[]] | null => {
  const source = files.find((file) => /^hif_000000\.nfs$/i.test(file.name));
  if (!source) return null;
  const directory = directoryOf(source);
  const group = files.filter(
    (file) =>
      file !== source && directoryOf(file) === directory && (isNfsPartName(file.name) || /^htk\.bin$/i.test(file.name)),
  );
  const names = new Set([source.name.toLowerCase()]);
  for (const file of group) {
    const name = file.name.toLowerCase();
    if (names.has(name)) {
      throw new Error("More than one NFS set was supplied; add one set (hif_*.nfs and htk.bin) at a time.");
    }
    names.add(name);
  }
  return [source, ...group];
};

export { groupNfsFiles, isNfsPartName };
