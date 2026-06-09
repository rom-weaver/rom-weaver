export async function openSyncAccessHandle({ fileHandle, mode }) {
  if (mode === undefined) return fileHandle.createSyncAccessHandle();
  try {
    return await fileHandle.createSyncAccessHandle({ mode });
  } catch (error) {
    if (mode === 'read-only') return fileHandle.createSyncAccessHandle();
    throw error;
  }
}

export function closeSyncFiles(files) {
  for (const file of files) {
    try {
      file.close();
    } catch {
      // ignore best-effort close failures
    }
  }
}

export function writableSyncAccessMode(mode) {
  return mode === 'read-only' ? undefined : mode;
}
