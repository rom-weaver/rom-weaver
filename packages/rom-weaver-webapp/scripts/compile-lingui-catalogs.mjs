import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getConfig } from "@lingui/conf";

// `src/presentation/localization/locales/*.ts` are compiled from the `.po` files
// beside them and are not in version control. Every entry point that resolves
// `catalog.ts` goes through Vite, so compiling here is the one place that keeps
// dev, build, preview, and every vitest config in step with the `.po` sources.
// The compile MUST run before module resolution, hence the `config` hook.

const packageRoot = path.resolve(import.meta.dirname, "..");
const linguiCli = path.join(packageRoot, "node_modules/@lingui/cli/dist/lingui.js");

const COMPILED_MESSAGES = /JSON\.parse\(("(?:\\.|[^"\\])*")\)/u;

const readCompiledMessages = (source) => {
  const match = COMPILED_MESSAGES.exec(source);
  if (!match) return null;
  try {
    const messages = JSON.parse(JSON.parse(match[1]));
    return messages && typeof messages === "object" && !Array.isArray(messages) ? messages : null;
  } catch {
    return null;
  }
};

const packCompiledCatalog = (englishSource, translatedSource, sourceLocale) => {
  const english = readCompiledMessages(englishSource);
  const translated = readCompiledMessages(translatedSource);
  if (!(english && translated)) return null;
  const keys = Object.keys(english);
  const translatedKeys = Object.keys(translated);
  if (keys.length !== translatedKeys.length || keys.some((key, index) => key !== translatedKeys[index])) {
    return null;
  }
  const values = keys.map((key) => translated[key]);
  return [
    'import type{Messages}from"@lingui/core";',
    `import{messages as englishMessages}from${JSON.stringify(`./${sourceLocale}.ts`)};`,
    `const values=JSON.parse(${JSON.stringify(JSON.stringify(values))});`,
    "export const messages=Object.fromEntries(Object.keys(englishMessages).map((key,index)=>[key,values[index]])) as Messages;",
  ].join("");
};

const packCatalogFiles = (template, locales, sourceLocale) => {
  const catalogPath = (locale) => `${template.replace("{locale}", locale)}.ts`;
  const englishFile = catalogPath(sourceLocale);
  const english = readFileSync(englishFile, "utf8");
  for (const locale of locales) {
    if (locale === sourceLocale) continue;
    const file = catalogPath(locale);
    if (path.dirname(file) !== path.dirname(englishFile)) {
      console.warn(`Lingui catalog ${locale} kept unmodified because its English import would be in another directory`);
      continue;
    }
    const original = readFileSync(file, "utf8");
    const packed = packCompiledCatalog(english, original, sourceLocale);
    if (packed) writeFileSync(file, packed);
    else console.warn(`Lingui catalog ${locale} kept unmodified because its compiled keys differ from ${sourceLocale}`);
  }
};

const packTranslatedCatalogs = () => {
  const { catalogs, locales, sourceLocale } = getConfig({ cwd: packageRoot });
  const template = catalogs.length === 1 ? catalogs[0]?.path : undefined;
  if (!sourceLocale || typeof template !== "string" || !template.includes("{locale}")) return;
  packCatalogFiles(template, locales, sourceLocale);
};

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
  packTranslatedCatalogs();
  compiled = true;
};

const compileLinguiCatalogs = () => ({
  config() {
    compileCatalogs();
  },
  name: "rom-weaver-compile-lingui-catalogs",
});

export { compileLinguiCatalogs, packCatalogFiles, packCompiledCatalog };
