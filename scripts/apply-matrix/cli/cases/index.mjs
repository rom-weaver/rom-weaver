import { registerPatchFormats } from "./patch-formats.mjs";

export const registerAll = async (env) => {
  registerPatchFormats(env);
  for (const name of ["patch-features", "containers", "outputs", "misc", "fuzz"]) {
    const module = await import(`./${name}.mjs`);
    await module.register(env);
  }
};
