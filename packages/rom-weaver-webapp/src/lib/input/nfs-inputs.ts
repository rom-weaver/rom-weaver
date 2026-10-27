const isNfsPartName = (name: string) => /^hif_\d{6}\.nfs$/i.test(name);

const groupNfsFiles = (files: readonly File[]): [File, ...File[]] | null => {
  const source = files.find((file) => /^hif_000000\.nfs$/i.test(file.name));
  if (!source) return null;
  return [
    source,
    ...files.filter((file) => file !== source && (isNfsPartName(file.name) || /^htk\.bin$/i.test(file.name))),
  ];
};

export { groupNfsFiles, isNfsPartName };
