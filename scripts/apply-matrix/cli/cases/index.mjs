import { registerPatchFormats } from "./patch-formats.mjs";

export const registerAll = async (env) => {
  registerPatchFormats(env);
  for (const name of ["patch-features", "containers", "outputs", "misc", "reference-disc", "reference-patch", "reference-archive", "fuzz", "create", "trim", "compress", "extract", "apply-matrix", "registry"]) {
    const module = await import(`./${name}.mjs`);
    await module.register(env);
  }
};
