import path from "node:path";

// `?worker&url` makes Vite bundle each worker entry in its own isolated rolldown
// build, so two workers that share a runtime each ship a private copy of it -
// the runner and WASI thread workers overlapped by ~85 kB raw. Intercepting the
// import at build time and emitting the worker as an extra entry chunk of the
// *main* graph instead puts both workers under one code-splitting pass, so the
// shared runtime is hoisted into a chunk both of them import. Build-only: dev
// keeps Vite's own `?worker&url` handling, and the import form stays the rule
// (see "Worker URLs" in docs/development/ARCHITECTURE.md).
const WORKER_URL_IMPORT_PATTERN = /[?&]worker(?:&|$)/;
const URL_IMPORT_PATTERN = /[?&]url(?:&|$)/;
const WORKER_OR_URL_IMPORT_FILTER = /[?&](?:worker|url)(?:&|$)/;

// Filled by the plugin below with the absolute path of every emitted worker
// entry, so the chunk grouping can tell worker-only modules from app modules.
const workerEntryFiles = new Set();
/** Memoized worker graph classifications; the module graph is rebuilt per build. */
const workerModuleKinds = new Map();

export const shareWorkerRuntimeChunks = () => {
  const chunkRefs = new Map();
  return {
    apply: "build",
    buildStart() {
      chunkRefs.clear();
      workerEntryFiles.clear();
      workerModuleKinds.clear();
    },
    enforce: "pre",
    load: {
      filter: { id: WORKER_OR_URL_IMPORT_FILTER },
      handler(id) {
        if (!(WORKER_URL_IMPORT_PATTERN.test(id) && URL_IMPORT_PATTERN.test(id))) return null;
        const workerFile = id.split("?")[0];
        let ref = chunkRefs.get(workerFile);
        if (!ref) {
          workerEntryFiles.add(workerFile);
          ref = this.emitFile({
            id: workerFile,
            name: path.basename(workerFile, path.extname(workerFile)),
            preserveSignature: false,
            type: "chunk",
          });
          chunkRefs.set(workerFile, ref);
        }
        return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
      },
    },
    name: "rom-weaver-share-worker-runtime-chunks",
  };
};

// Classify worker reachability and whether document code can also reach a module.
// Directory names alone cannot distinguish shared helpers from worker-only code.
const classifyWorkerModule = (moduleId, ctx) => {
  const cached = workerModuleKinds.get(moduleId);
  if (cached) return cached;
  const visited = new Set([moduleId]);
  const pending = [moduleId];
  let workerOnly = true;
  let workerReachable = false;
  while (pending.length > 0 && !(workerReachable && !workerOnly)) {
    const id = pending.pop();
    // Only the bare path is the worker entry; the `?worker&url` module of the same file is the
    // URL stub the app imports, and its own importers decide where it belongs.
    if (workerEntryFiles.has(id)) {
      workerReachable = true;
      continue;
    }
    const info = ctx.getModuleInfo(id);
    if (!info || (info.importers.length === 0 && info.dynamicImporters.length === 0)) {
      workerOnly = false;
      continue;
    }
    for (const importer of [...info.importers, ...info.dynamicImporters]) {
      if (visited.has(importer)) continue;
      visited.add(importer);
      pending.push(importer);
    }
  }
  const result = { workerOnly, workerReachable };
  workerModuleKinds.set(moduleId, result);
  return result;
};

const isWorkerOnlyModule = (moduleId, ctx) => classifyWorkerModule(moduleId, ctx).workerOnly;

// True when at least one import path reaching this module starts at a worker
// entry. `isWorkerOnlyModule` above answers the stricter question; this one
// catches the modules a worker and the document both use, which is what decides
// whether a worker has to download the document's chunk to reach them.
const isWorkerReachableModule = (moduleId, ctx) => {
  return classifyWorkerModule(moduleId, ctx).workerReachable;
};

/** Everything a worker can reach that is not worker-only: the overlap between a
 * worker's graph and the document's. Without a chunk of its own it lands in
 * `shared`, and since a chunk is the unit of loading, an 8 kB thread worker then
 * pulls the whole document chunk - React and all - into every worker realm. */
export const nameWorkerSharedGroup = (moduleId, ctx) =>
  isWorkerReachableModule(moduleId, ctx) ? "worker-shared" : null;

/**
 * Group worker-only modules before the worker-shared and general shared groups.
 * includeDependenciesRecursively MUST stay off to keep app-facing dependencies separate.
 */
export const nameWorkerRuntimeGroup = (moduleId, ctx) => (isWorkerOnlyModule(moduleId, ctx) ? "wasm-runtime" : null);
