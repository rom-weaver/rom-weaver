type FileHandlePermissionMode = "read" | "readwrite";
type FileHandlePermissionState = "denied" | "granted" | "prompt";
type FileHandlePermissionDescriptor = { mode?: FileHandlePermissionMode };
type PermissionAwareFileHandle = FileSystemFileHandle & {
  queryPermission?: (descriptor?: FileHandlePermissionDescriptor) => Promise<FileHandlePermissionState>;
  requestPermission?: (descriptor?: FileHandlePermissionDescriptor) => Promise<FileHandlePermissionState>;
};

const READ_WRITE_PERMISSION: FileHandlePermissionDescriptor = { mode: "readwrite" };

const createOutputWriteError = (message: string, cause?: unknown) => {
  const error = new Error(message) as Error & { cause?: unknown; code?: string };
  error.name = "OutputWriteError";
  error.code = "OUTPUT_WRITE_FAILED";
  if (cause !== undefined) error.cause = cause;
  return error;
};

const isWritablePermissionError = (error: unknown) => {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return (
      error.name === "NoModificationAllowedError" || error.name === "NotAllowedError" || error.name === "SecurityError"
    );
  }
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  return (
    message.includes("createwritable") &&
    (message.includes("modifications are not allowed") ||
      message.includes("not allowed") ||
      message.includes("permission") ||
      message.includes("read-only"))
  );
};

const ensureWritablePermission = async (fileHandle: FileSystemFileHandle) => {
  const permissionAwareHandle = fileHandle as PermissionAwareFileHandle;
  if (
    typeof permissionAwareHandle.queryPermission !== "function" &&
    typeof permissionAwareHandle.requestPermission !== "function"
  ) {
    return;
  }
  const currentState =
    typeof permissionAwareHandle.queryPermission === "function"
      ? await permissionAwareHandle.queryPermission(READ_WRITE_PERMISSION).catch(() => null)
      : null;
  if (currentState === "granted") return;
  const requestedState =
    typeof permissionAwareHandle.requestPermission === "function"
      ? await permissionAwareHandle.requestPermission(READ_WRITE_PERMISSION).catch(() => null)
      : currentState;
  if (requestedState === "granted") return;
  throw createOutputWriteError(
    "Destination file is not writable. Choose a writable file with showSaveFilePicker or grant read/write access.",
  );
};

const writeBlobToFileHandle = async (fileHandle: FileSystemFileHandle, blob: Blob) => {
  await ensureWritablePermission(fileHandle);
  let writable: Awaited<ReturnType<FileSystemFileHandle["createWritable"]>>;
  try {
    writable = await fileHandle.createWritable();
  } catch (error) {
    if (isWritablePermissionError(error)) {
      throw createOutputWriteError(
        "Destination file is not writable. Choose a writable file with showSaveFilePicker or grant read/write access.",
        error,
      );
    }
    throw error;
  }
  let writeError: unknown = null;
  try {
    await writable.write(blob);
  } catch (error) {
    writeError = error;
    throw error;
  } finally {
    if (writeError && typeof writable.abort === "function") {
      await writable.abort(writeError).catch(() => undefined);
    } else {
      await writable.close();
    }
  }
};

export { writeBlobToFileHandle };
