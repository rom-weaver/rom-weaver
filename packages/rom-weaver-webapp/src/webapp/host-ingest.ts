import { getManagedOpfsFileHandle } from "../workers/protocol/opfs-path.ts";

const HOST_INGEST_EVENT = "rom-weaver:ingest";
const HOST_INGEST_PATH_PREFIX = "/work/rom-weaver-imports/";

type HostIngestListener = (paths: readonly string[]) => void;

const pendingRequests: string[][] = [];
let activeListener: HostIngestListener | null = null;

const normalizeHostIngestPaths = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error("RomWeaver ingest requires at least one OPFS path");
  return value.map((path) => {
    if (typeof path !== "string" || !path.startsWith(HOST_INGEST_PATH_PREFIX))
      throw new Error(`RomWeaver ingest paths must start with ${HOST_INGEST_PATH_PREFIX}`);
    return path;
  });
};

const ingest = (paths: readonly string[]) => {
  const detail = normalizeHostIngestPaths(paths);
  if (typeof document === "undefined") {
    pendingRequests.push(detail);
    return;
  }
  document.dispatchEvent(new CustomEvent(HOST_INGEST_EVENT, { detail }));
};

const subscribeHostIngest = (listener: HostIngestListener) => {
  activeListener = listener;
  for (const paths of pendingRequests.splice(0)) listener(paths);
  return () => {
    if (activeListener === listener) activeListener = null;
  };
};

const resolveHostIngestFiles = async (paths: readonly string[]): Promise<File[]> =>
  Promise.all(
    normalizeHostIngestPaths(paths).map(async (filePath) => {
      const handle = await getManagedOpfsFileHandle(filePath);
      if (!handle) throw new Error(`RomWeaver ingest path does not exist: ${filePath}`);
      return Object.assign(await handle.getFile(), { filePath });
    }),
  );

if (typeof document !== "undefined") {
  document.addEventListener(HOST_INGEST_EVENT, (event) => {
    const paths = normalizeHostIngestPaths((event as CustomEvent<unknown>).detail);
    if (activeListener) activeListener(paths);
    else pendingRequests.push(paths);
  });
}

export { HOST_INGEST_EVENT, ingest, resolveHostIngestFiles, subscribeHostIngest };
