/** @type {Record<string, string>} */
const CHANNEL_SUFFIXES = { beta: "b", dev: "d", nightly: "n" };

/** The badge a channel wears: "" for production, else its label. @param {string} channel @param {string | undefined} label */
export const channelBadgeFor = (channel, label) => (channel === "prod" ? "" : label || channel);

/** The letter a channel appends to the build tag version, or "" when it has none. @param {string | undefined} channelBadge */
export const channelSuffix = (channelBadge) => CHANNEL_SUFFIXES[channelBadge?.toLowerCase() ?? ""] ?? "";

/** @param {number | null | undefined} commitsSinceVersion */
const commitDistance = (commitsSinceVersion) =>
  typeof commitsSinceVersion === "number" && Number.isInteger(commitsSinceVersion) && commitsSinceVersion > 0
    ? commitsSinceVersion
    : 0;

/**
 * The build tag's version text, such as `v0.25.1` or `v0.24.0d+125*`.
 * @param {{ channelBadge?: string, commitsSinceVersion?: number | null, dirty?: boolean, version: string }} build
 */
export const buildTagVersionText = ({ channelBadge, commitsSinceVersion, dirty, version }) => {
  const distance = commitDistance(commitsSinceVersion);
  return `v${version}${channelSuffix(channelBadge)}${distance ? `+${distance}` : ""}${dirty ? "*" : ""}`;
};
