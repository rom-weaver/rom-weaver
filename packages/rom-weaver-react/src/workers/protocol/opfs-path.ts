const OPFS_VERSION_DIRECTORY = "v4";

const LEADING_SLASHES_REGEX = /^\/+/;
const NOT_FOUND_ERROR_REGEX = /not\s+found|object\s+can\s+not\s+be\s+found/i;
const PATH_SEPARATOR_REGEX = /[\\/]+/;

const normalizeOpfsPathParts = (filePath: string): string[] => {
  const rawParts = String(filePath || "")
    .replace(LEADING_SLASHES_REGEX, "")
    .split(PATH_SEPARATOR_REGEX)
    .filter((part) => part && part !== "." && part !== "..");
  if (String(filePath || "").startsWith("/") && rawParts.length > 1) rawParts.shift();
  return rawParts;
};

const getManagedOpfsStorageName = (filePath: string): string =>
  normalizeOpfsPathParts(filePath).join("/") || "output.bin";

const getManagedOpfsDirectory = async (
  navigatorObject?: Pick<Navigator, "storage"> | null,
): Promise<FileSystemDirectoryHandle | null> => {
  const storage = navigatorObject?.storage || globalThis.navigator?.storage;
  if (!storage || typeof storage.getDirectory !== "function") return null;
  return storage.getDirectory();
};

const isNotFoundError = (error: unknown) =>
  typeof DOMException !== "undefined" && error instanceof DOMException
    ? error.name === "NotFoundError"
    : error instanceof Error && NOT_FOUND_ERROR_REGEX.test(error.message);

const getManagedOpfsFileHandle = async (
  filePath: string,
  options: { create?: boolean; navigatorObject?: Pick<Navigator, "storage"> | null } = {},
): Promise<FileSystemFileHandle | null> => {
  const directory = await getManagedOpfsDirectory(options.navigatorObject);
  if (!directory) return null;
  const parts = normalizeOpfsPathParts(filePath);
  const fileName = parts.pop();
  if (!fileName) return null;
  let parentDirectory = directory;
  try {
    for (const part of parts) {
      parentDirectory = await parentDirectory.getDirectoryHandle(part, { create: options.create === true });
    }
    return await parentDirectory.getFileHandle(fileName, { create: options.create === true });
  } catch (error) {
    if (options.create !== true && isNotFoundError(error)) return null;
    throw error;
  }
};

const removeManagedOpfsPath = async (
  filePath: string,
  navigatorObject?: Pick<Navigator, "storage"> | null,
): Promise<void> => {
  const directory = await getManagedOpfsDirectory(navigatorObject);
  if (!directory) return;
  const parts = normalizeOpfsPathParts(filePath);
  const fileName = parts.pop();
  if (!fileName) return;
  let parentDirectory = directory;
  try {
    for (const part of parts) parentDirectory = await parentDirectory.getDirectoryHandle(part, { create: false });
    await parentDirectory.removeEntry(fileName, { recursive: true });
  } catch (_error) {
    /* ignore cleanup errors */
  }
};

const getOpfsFileHandle = getManagedOpfsFileHandle;
const removeOpfsPath = removeManagedOpfsPath;

export {
  getManagedOpfsDirectory,
  getManagedOpfsFileHandle,
  getManagedOpfsStorageName,
  getOpfsFileHandle,
  OPFS_VERSION_DIRECTORY,
  removeManagedOpfsPath,
  removeOpfsPath,
};
