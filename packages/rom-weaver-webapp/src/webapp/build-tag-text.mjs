/** @type {Record<string, string>} */
const CHANNEL_SUFFIXES = { beta: "b", dev: "d", nightly: "n" };

/** The letter a channel appends to the build tag version, or "" when it has none. @param {string | undefined} channelBadge */
export const channelSuffix = (channelBadge) => CHANNEL_SUFFIXES[channelBadge?.toLowerCase() ?? ""] ?? "";

/**
 * The build tag's version text, such as `v0.25.1` or `v0.24.0d+125*`.
 * @param {{ channelBadge?: string, commitDistance: number, dirty?: boolean, version: string }} build
 */
export const buildTagVersionText = ({ channelBadge, commitDistance, dirty, version }) =>
  `v${version}${channelSuffix(channelBadge)}${commitDistance ? `+${commitDistance}` : ""}${dirty ? "*" : ""}`;
