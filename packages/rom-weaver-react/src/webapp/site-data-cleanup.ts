type OpfsDirectoryHandle = {
  entries?: () => AsyncIterable<[string, RuntimeValue]>;
  keys?: () => AsyncIterable<string>;
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>;
};

type StorageWithOpfsDirectory = {
  getDirectory?: () => Promise<OpfsDirectoryHandle>;
};

type ClearOpfsResult = {
  deletedEntries: number;
  failedEntries: number;
  skippedReason?: "cleanup-disabled" | "opfs-unavailable";
};

const listOpfsRootEntries = async (root: OpfsDirectoryHandle): Promise<string[]> => {
  const entries: string[] = [];
  if (typeof root.keys === "function") {
    for await (const name of root.keys()) entries.push(name);
    return entries;
  }
  if (typeof root.entries === "function") {
    for await (const [name] of root.entries()) entries.push(name);
  }
  return entries;
};

const clearOpfsRootDirectory = async (root: OpfsDirectoryHandle): Promise<ClearOpfsResult> => {
  const names = await listOpfsRootEntries(root);
  let deletedEntries = 0;
  let failedEntries = 0;
  for (const name of names) {
    try {
      await root.removeEntry(name, { recursive: true });
      deletedEntries++;
    } catch (_err) {
      failedEntries++;
    }
  }
  return { deletedEntries, failedEntries };
};

const clearOpfsOnPageLoad = async ({
  enabled = true,
  storage = typeof navigator === "undefined" ? undefined : (navigator.storage as StorageWithOpfsDirectory | undefined),
}: {
  enabled?: boolean;
  storage?: StorageWithOpfsDirectory;
} = {}): Promise<ClearOpfsResult> => {
  if (!enabled) return { deletedEntries: 0, failedEntries: 0, skippedReason: "cleanup-disabled" };
  if (!storage || typeof storage.getDirectory !== "function")
    return { deletedEntries: 0, failedEntries: 0, skippedReason: "opfs-unavailable" };

  try {
    return await clearOpfsRootDirectory(await storage.getDirectory());
  } catch (_err) {
    return { deletedEntries: 0, failedEntries: 1 };
  }
};

export { clearOpfsOnPageLoad };
