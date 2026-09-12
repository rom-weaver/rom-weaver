import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageDir, "..", "..");

const generatedAssetsDir = path.join(repoRoot, "dist", "generated-assets");

export const generatedIconAssetsDir = path.join(generatedAssetsDir, "channel-icons");

export const generateIconAssets = () => {
  execFileSync(
    process.execPath,
    [path.join(packageDir, "scripts", "generate-channel-icons.mjs"), "--output-dir", generatedAssetsDir],
    { stdio: "inherit" },
  );
};

const generatedIconChannel = (channel) => (channel === "prod" || channel === "dev" ? "production" : channel);

export const generatedChannelAssetPath = (channel, name, assetDir = generatedIconAssetsDir) => {
  const selectedChannel = generatedIconChannel(channel);
  const sourcePath = path.join(assetDir, selectedChannel, name);
  if (fs.statSync(sourcePath, { throwIfNoEntry: false })?.isFile()) return sourcePath;
  throw new Error(`Generated ${selectedChannel} icon is missing: ${sourcePath}. Run npm run icons:channels.`);
};

/** The social card is one image for every channel, unlike the app icons. */
export const generatedSocialPreviewPath = (name, assetDir = generatedAssetsDir) => {
  const sourcePath = path.join(assetDir, name);
  if (fs.statSync(sourcePath, { throwIfNoEntry: false })?.isFile()) return sourcePath;
  throw new Error(`Generated social preview is missing: ${sourcePath}. Run npm run icons:channels.`);
};
