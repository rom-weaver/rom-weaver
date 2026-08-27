import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binaryName = process.platform === "win32" ? "rom-weaver.exe" : "rom-weaver";
const [platform, binaryPath = resolve(repoRoot, "target/release", binaryName)] =
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
copyFileSync(resolve(repoRoot, "LICENSE"), resolve(packageRoot, "LICENSE"));
const shareTarget = resolve(packageRoot, "share");
rmSync(shareTarget, { recursive: true, force: true });
cpSync(resolve(repoRoot, "target", "identify-release", "share"), shareTarget, {
  recursive: true,
});
execFileSync(
  process.execPath,
  [resolve(repoRoot, "scripts/gen-third-party-licenses.mjs"), packageRoot, "--target", "cli"],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);
if (!binaryTarget.endsWith(".exe")) chmodSync(binaryTarget, 0o755);
console.log(`Prepared ${manifest.name} from ${binaryPath}`);
