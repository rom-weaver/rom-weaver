import { execFileSync } from "node:child_process";
import path from "node:path";

// `src/presentation/localization/locales/*.ts` are compiled from the `.po` files
// beside them and are not in version control. Every entry point that resolves
// `catalog.ts` goes through Vite, so compiling here is the one place that keeps
// dev, build, preview, and every vitest config in step with the `.po` sources.
// The compile MUST run before module resolution, hence the `config` hook.

const packageRoot = path.resolve(import.meta.dirname, "..");
const linguiCli = path.join(packageRoot, "node_modules/@lingui/cli/dist/lingui.js");

let compiled = false;

const compileCatalogs = () => {
  // Once per process. The catalogs are process-wide files and Vite instantiates
  // this plugin once per config it loads.
  if (compiled) return;
  // @lingui/cli reaches for a `.jiti.js` worker that its published package does
  // not ship whenever NODE_ENV is "test" (node_modules/@lingui/cli/dist/api/
  // typedPool.js). Vitest sets NODE_ENV=test, so the child MUST NOT inherit it.
  const { NODE_ENV: _testEnv, ...env } = process.env;
  execFileSync(process.execPath, [linguiCli, "compile", "--typescript", "--output-prefix", ""], {
    cwd: packageRoot,
    env,
    stdio: "inherit",
  });
  compiled = true;
};

const compileLinguiCatalogs = () => ({
  config() {
    compileCatalogs();
  },
  name: "rom-weaver-compile-lingui-catalogs",
});

export { compileLinguiCatalogs };
