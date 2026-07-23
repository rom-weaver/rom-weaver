import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Destination for synced wasm artifacts: the @rom-weaver/wasm package's src/,
// where the package build and the webapp's attribution checks consume them.
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..", "..", "rom-weaver-wasm", "src");
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const ARTIFACTS_DIR_INPUT = process.argv[2] ?? process.env.ROM_WEAVER_WASM_ARTIFACT_DIR;

if (!ARTIFACTS_DIR_INPUT) {
  fail(
    "Missing artifacts directory. Pass it as `npm run prepare:dist -- /path/to/wasm-artifacts` or set ROM_WEAVER_WASM_ARTIFACT_DIR.",
  );
}

const DIST_WASM_DIR = resolve(process.cwd(), ARTIFACTS_DIR_INPUT);

const REQUIRED_DIST_COPIES = [
  { src: "rom-weaver-app.wasm", dst: "rom-weaver-app.wasm" },
  { src: "rom-weaver-app.wasm.br", dst: "rom-weaver-app.wasm.br" },
];
const REQUIRED_LICENSE_FILES = ["NOTICE", "THIRD_PARTY_LICENSES.md"];

function main() {
  mkdirSync(PACKAGE_DIR, { recursive: true });

  if (!existsSync(DIST_WASM_DIR)) {
    fail(`Missing artifacts directory: ${DIST_WASM_DIR}. Run mise run build-wasm and pass that output directory here.`);
  }

  for (const { src: srcName, dst: dstName } of REQUIRED_DIST_COPIES) {
    const src = resolve(DIST_WASM_DIR, srcName);
    const dst = resolve(PACKAGE_DIR, dstName);

    if (!existsSync(src)) {
      fail(`Missing artifact: ${src}. Run mise run build-wasm first.`);
    }

    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    log(`copied ${relativeFromRepo(src)} -> ${relativeFromRepo(dst)}`);
  }

  for (const filename of REQUIRED_LICENSE_FILES) {
    const src = resolve(DIST_WASM_DIR, filename);
    const dst = resolve(PACKAGE_DIR, filename);
    if (!existsSync(src)) {
      fail(`Missing generated attribution file: ${src}. Run the WASM build first.`);
    }
    copyFileSync(src, dst);
    log(`copied ${relativeFromRepo(src)} -> ${relativeFromRepo(dst)}`);
  }

  const licenseDir = resolve(DIST_WASM_DIR, "third_party", "licenses");
  if (!existsSync(licenseDir)) {
    fail(`Missing generated attribution directory: ${licenseDir}. Run the WASM build first.`);
  }
  const packageLicenseDir = resolve(PACKAGE_DIR, "third_party", "licenses");
  rmSync(packageLicenseDir, { force: true, recursive: true });
  cpSync(licenseDir, packageLicenseDir, { recursive: true });

  log("package sync complete");
}

function relativeFromRepo(path) {
  const repoPrefix = `${REPO_ROOT}/`;
  if (path.startsWith(repoPrefix)) {
    return path.slice(repoPrefix.length);
  }
  return path;
}

function log(message) {
  process.stdout.write(`[sync-dist] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[sync-dist] ${message}\n`);
  process.exit(1);
}

main();
