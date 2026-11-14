/** What scripts/vite-config/channel-stamp.mjs stamps into a deployment, from scripts/version.mjs. */
type BuildInfo = {
  commitHash: string;
  commitsSinceVersion: number | null;
  dirtyHash: string;
  gitBranch: string;
  version: string;
  versionBranch: string;
  versionIsTagged: boolean;
};

const isBuildInfo = (value: unknown): value is BuildInfo =>
  typeof value === "object" && value !== null && typeof (value as Partial<BuildInfo>).version === "string";

// Pages read <html data-build-info>; the service worker has no document, so the stamp
// writes the values into its script. Prerendering sets the same global, and an
// unstamped bundle has no build info.
const readStampedBuildInfo = (): BuildInfo | undefined => {
  const documentJson = typeof document === "undefined" ? undefined : document.documentElement.dataset.buildInfo;
  const stamped: unknown = globalThis.__ROM_WEAVER_BUILD_INFO__ ?? (documentJson && JSON.parse(documentJson));
  return isBuildInfo(stamped) ? stamped : undefined;
};

const stampedBuildInfo = readStampedBuildInfo();
const APP_VERSION = stampedBuildInfo?.version ?? "";
const COMMIT_HASH = stampedBuildInfo?.commitHash ?? "";
const COMMITS_SINCE_VERSION = stampedBuildInfo?.commitsSinceVersion ?? null;
const GIT_BRANCH = stampedBuildInfo?.gitBranch ?? "";
const DIRTY_HASH = stampedBuildInfo?.dirtyHash ?? "";

const formatBuildVersion = ({ commitHash, dirtyHash, version, versionBranch, versionIsTagged }: BuildInfo) => {
  // A clean build of the tagged release commit is just the version, no suffix.
  if (versionIsTagged && !dirtyHash) return version;
  const versionBranchPrefix = versionBranch ? `${versionBranch}.` : "";
  return `${version}+${versionBranchPrefix}${dirtyHash ? `dirty.${dirtyHash}` : commitHash}`;
};
const APP_BUILD_VERSION = stampedBuildInfo ? formatBuildVersion(stampedBuildInfo) : "";

export { APP_BUILD_VERSION, APP_VERSION, COMMITS_SINCE_VERSION, COMMIT_HASH, DIRTY_HASH, GIT_BRANCH };
