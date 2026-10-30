import { registerPatchFormats } from "./patch-formats.mjs";

export const registerAll = async (env) => {
  registerPatchFormats(env);
  for (const name of ["patch-features", "containers", "outputs", "misc", "fuzz"]) {
    try {
      const module = await import(`./${name}.mjs`);
      await module.register(env);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !String(error.message).includes(`${name}.mjs`)) throw error;
    }
  }
};
