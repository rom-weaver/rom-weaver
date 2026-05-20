const writeBlobToFileHandle = async (fileHandle: FileSystemFileHandle, blob: Blob) => {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
};

export { writeBlobToFileHandle };
