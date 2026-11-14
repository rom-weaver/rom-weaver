#!/usr/bin/env node

// Restamps an existing build for another channel without rebuilding it:
//   npm run stamp-channel -- <channel> [label] [origin]
// The label defaults to the channel, and the origin to production.
// dist and build/channel-stamp MUST come from the same build.

import path from "node:path";
import process from "node:process";
import { APP_CHANNELS, resolveSiteOrigin } from "./vite-config/channel.mjs";
import { CHANNEL_STAMP_TEMPLATES_DIR, stampChannel } from "./vite-config/channel-stamp.mjs";
import { rootDir } from "./vite-config/paths.mjs";

const [channel, labelArgument, originArgument] = process.argv.slice(2);
if (!channel) {
  console.error("usage: npm run stamp-channel -- <channel> [label] [origin]");
  process.exit(2);
}
// A build maps unknown channels to dev. A restamp rejects them, so a typo cannot stamp dev.
if (!APP_CHANNELS.has(channel)) {
  console.error(`unknown channel '${channel}'; expected one of ${[...APP_CHANNELS].join(", ")}`);
  process.exit(2);
}
await stampChannel({
  channel,
  channelLabel: labelArgument || channel,
  distDir: path.join(rootDir, "dist"),
  siteOrigin: resolveSiteOrigin(originArgument),
  templatesDir: CHANNEL_STAMP_TEMPLATES_DIR,
});
console.log(`[rom-weaver] stamped dist for ${channel}`);
