#!/usr/bin/env node

// Restamps an existing build for another channel without rebuilding it:
//   npm run stamp-channel -- <channel> [label] [origin]
// The label defaults to the channel, and the origin to production, as with the
// build variables. dist and build/channel-stamp MUST come from the same build.

import path from "node:path";
import process from "node:process";
import { resolveAppChannel, resolveSiteOrigin } from "./vite-config/channel.mjs";
import { CHANNEL_STAMP_TEMPLATES_DIR, stampChannel } from "./vite-config/channel-stamp.mjs";
import { rootDir } from "./vite-config/paths.mjs";

const [channelArgument, labelArgument, originArgument] = process.argv.slice(2);
if (!channelArgument) {
  console.error("usage: npm run stamp-channel -- <channel> [label] [origin]");
  process.exit(2);
}
const channel = resolveAppChannel(channelArgument);
await stampChannel({
  channel,
  channelLabel: labelArgument || channel,
  distDir: path.join(rootDir, "dist"),
  siteOrigin: resolveSiteOrigin(originArgument),
  templatesDir: CHANNEL_STAMP_TEMPLATES_DIR,
});
console.log(`[rom-weaver] stamped dist for ${channel}`);
