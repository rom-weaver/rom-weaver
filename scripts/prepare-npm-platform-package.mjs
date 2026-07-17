import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [platform, binaryPath = resolve(repoRoot, "target/release/rom-weaver")] =
  process.argv.slice(2);

if (!platform)
  throw new Error("usage: node scripts/prepare-npm-platform-package.mjs <platform> [binary]");

const packageRoot = resolve(repoRoot, "packages/rom-weaver-cli-platforms", platform);
const manifestPath = resolve(packageRoot, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const binary = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["rom-weaver"];
if (!binary) throw new Error(`${manifest.name} does not declare a binary`);

const binaryTarget = resolve(packageRoot, binary);
mkdirSync(dirname(binaryTarget), { recursive: true });
copyFileSync(binaryPath, binaryTarget);
copyFileSync(resolve(repoRoot, "LICENSE.md"), resolve(packageRoot, "LICENSE.md"));
execFileSync(
  process.execPath,
  [resolve(repoRoot, "scripts/gen-third-party-licenses.mjs"), packageRoot],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);
if (!binaryTarget.endsWith(".exe")) chmodSync(binaryTarget, 0o755);
console.log(`Prepared ${manifest.name} from ${binaryPath}`);
