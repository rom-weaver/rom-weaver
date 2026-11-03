import { handleKeptRomFile } from "../../src/wasm/kept-rom-file-worker.ts";

const createKeptRomQuotaError = async (): Promise<DOMException> => {
  const access = { write: () => 0, close: () => undefined };
  const file = { createSyncAccessHandle: async () => access };
  const directory = { getFileHandle: async () => file };
  const root = { getDirectoryHandle: async () => directory } as unknown as FileSystemDirectoryHandle;
  const response = await handleKeptRomFile(
    {
      type: "kept-rom-file",
      action: "write",
      requestId: "quota-fixture",
      name: `${"a".repeat(40)}-11111111-1111-1111-1111-111111111111.rom`,
      blob: new Blob(["ROM"]),
    },
    Promise.resolve(root),
  );
  if (!response.error) throw new Error("The worker did not report the no-space write.");
  return new DOMException(response.error.message, response.error.name);
};

export { createKeptRomQuotaError };
