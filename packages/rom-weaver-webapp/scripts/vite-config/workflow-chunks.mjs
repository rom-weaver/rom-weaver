import { isWorkerEntryFile } from "./worker-chunks.mjs";

// The Home and docs routes only need the app shell: the entry, the home page and
// the docs page, plus what they import statically. Everything else two or more
// route chunks reach (the Apply and Create forms, input staging, cheat
// database, output build services) is workflow code; left in the catch-all
// `shared` chunk it is modulepreloaded on every route. Grouping it into its own
// chunk keeps the compression context of a single chunk (see the comment above
// `codeSplitting`) while Home and docs stop fetching it. The chunk is only
// reached through dynamic imports, so it loads with the workflow route chunks.
const SHELL_ROOT_PATTERN = /\/src\/webapp\/(?:components\/home-page|docs-page)\.tsx$/;

/** Memoized shell reachability; the module graph is rebuilt per build. */
const shellKinds = new Map();

export const resetWorkflowChunks = () => ({
  apply: "build",
  buildStart() {
    shellKinds.clear();
  },
  name: "rom-weaver-reset-workflow-chunks",
});

const isShellRoot = (id, info) =>
  (info.isEntry && !isWorkerEntryFile(id)) || SHELL_ROOT_PATTERN.test(id.split("?")[0].replace(/\\/g, "/"));

/** True when a chain of static imports leads from the entry or a shell route to the module. */
const isShellModule = (moduleId, ctx) => {
  const cached = shellKinds.get(moduleId);
  if (cached !== undefined) return cached;
  const visited = new Set([moduleId]);
  const pending = [moduleId];
  let reachable = false;
  while (pending.length > 0 && !reachable) {
    const id = pending.pop();
    const info = ctx.getModuleInfo(id);
    if (!info) continue;
    if (isShellRoot(id, info)) {
      reachable = true;
      break;
    }
    for (const importer of info.importers) {
      if (visited.has(importer)) continue;
      visited.add(importer);
      pending.push(importer);
    }
  }
  shellKinds.set(moduleId, reachable);
  return reachable;
};

/** Names modules outside the shell's static graph so they share one workflow chunk. */
export const nameWorkflowSharedGroup = (moduleId, ctx) => (isShellModule(moduleId, ctx) ? null : "workflow-shared");
