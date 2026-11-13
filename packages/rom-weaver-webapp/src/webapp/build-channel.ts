import { createLogger } from "../lib/logging.ts";
import type { Accent } from "./accent.ts";

/**
 * The build channel supplies the masthead badge and default UI accent.
 * Production uses no badge and the madder accent.
 */

const logger = createLogger("build-channel");

const CHANNELS = ["prod", "beta", "nightly", "preview", "dev"] as const;
type BuildChannel = (typeof CHANNELS)[number];

const isBuildChannel = (value: unknown): value is BuildChannel => CHANNELS.includes(value as BuildChannel);

// The channel comes from the deployment's <html>, so no URL or storage key can change it.
// Prerendering has no document, so it passes the channel in ROM_WEAVER_PRERENDER_CHANNEL.
// To preview a channel locally, run `ROM_WEAVER_CHANNEL=beta npm run dev`.
const readStampedChannel = (): { channel?: string; label?: string } => {
  if (globalThis.ROM_WEAVER_PRERENDER_CHANNEL) return globalThis.ROM_WEAVER_PRERENDER_CHANNEL;
  if (typeof document === "undefined") return {};
  const { channel, channelLabel } = document.documentElement.dataset;
  return { channel, label: channelLabel };
};
const stampedChannel = readStampedChannel();
const ACTIVE_CHANNEL: BuildChannel = isBuildChannel(stampedChannel.channel) ? stampedChannel.channel : "dev";
const ACTIVE_CHANNEL_LABEL = stampedChannel.label || ACTIVE_CHANNEL;

/** Production wears the plain brand; every other channel is marked. */
const CHANNEL_BADGE = ACTIVE_CHANNEL === "prod" ? "" : ACTIVE_CHANNEL_LABEL;

/**
 * The accent each channel starts on, so nightly and beta are distinguishable
 * out of the box. This is only the default - the `accent` setting overrides it,
 * and once the user picks one their choice travels with them across channels.
 */
const CHANNEL_DEFAULT_ACCENTS: Record<BuildChannel, Accent> = {
  beta: "woad",
  dev: "madder",
  nightly: "verdigris",
  preview: "plum",
  prod: "madder",
};

const DEFAULT_CHANNEL_ACCENT: Accent = CHANNEL_DEFAULT_ACCENTS[ACTIVE_CHANNEL];

logger.debug("Resolved build channel", {
  accent: DEFAULT_CHANNEL_ACCENT,
  channel: ACTIVE_CHANNEL,
  label: ACTIVE_CHANNEL_LABEL,
});

export { CHANNEL_BADGE, DEFAULT_CHANNEL_ACCENT };
