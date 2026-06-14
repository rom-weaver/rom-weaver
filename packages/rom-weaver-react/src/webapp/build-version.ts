const APP_VERSION = __APP_VERSION__;
const COMMIT_HASH = __COMMIT_HASH__;
const GIT_BRANCH = __GIT_BRANCH__;
const DIRTY_HASH = __DIRTY_HASH__;

const VERSION_BRANCH_PREFIX = GIT_BRANCH ? `${GIT_BRANCH}.` : "";
const APP_BUILD_VERSION = `${APP_VERSION}+${VERSION_BRANCH_PREFIX}${DIRTY_HASH ? `dirty.${DIRTY_HASH}` : COMMIT_HASH}`;
const hasUnresolvedVersionTokens = [APP_VERSION, COMMIT_HASH, GIT_BRANCH, DIRTY_HASH].some(
  (value) => typeof value === "string" && value.indexOf("__") !== -1,
);
const RESOLVED_APP_BUILD_VERSION = hasUnresolvedVersionTokens ? "" : APP_BUILD_VERSION;

export { APP_BUILD_VERSION, RESOLVED_APP_BUILD_VERSION };
