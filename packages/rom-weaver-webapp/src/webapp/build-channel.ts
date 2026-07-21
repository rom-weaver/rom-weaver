import { createLogger } from "../lib/logging.ts";
import type { Accent } from "./accent.ts";

/**
 * Deploy-channel identity. Every channel ships the same bundle from the same
 * commit range, so without a visual marker a nightly tab, a PR preview and
 * production are indistinguishable - including as installed PWAs. The channel
 * is stamped in at build time from CI's already-resolved deploy target and
 * surfaces as a masthead badge plus the default accent dye lot.
 *
 * Production is the baseline identity: no badge, madder accent.
 */

const logger = createLogger("build-channel");

const CHANNELS = ["prod", "beta", "nightly", "preview", "dev"] as const;
type BuildChannel = (typeof CHANNELS)[number];

const isBuildChannel = (value: unknown): value is BuildChannel => CHANNELS.includes(value as BuildChannel);

// The channel is a build fact, never a runtime one: no URL parameter or storage
// key can move it. To see a channel's out-of-box look locally, build or serve
// with the real thing - `ROM_WEAVER_CHANNEL=beta npm run dev`.
const ACTIVE_CHANNEL: BuildChannel = isBuildChannel(__APP_CHANNEL__) ? __APP_CHANNEL__ : "dev";
const ACTIVE_CHANNEL_LABEL = __APP_CHANNEL_LABEL__ || ACTIVE_CHANNEL;

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
