// Helpers for tests that build a scratch git repository.

import { execFileSync } from "node:child_process";

const IDENTITY = {
  GIT_AUTHOR_NAME: "ci",
  GIT_AUTHOR_EMAIL: "ci@example.com",
  GIT_COMMITTER_NAME: "ci",
  GIT_COMMITTER_EMAIL: "ci@example.com",
};

// Git hooks export GIT_DIR, GIT_INDEX_FILE, and friends. Inherited, they point
// these commands at the repository running the hook instead of the scratch one.
export const isolatedEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  ...IDENTITY,
  ...extra,
});

/** Runs git in `cwd` and returns its trimmed output. */
export function git(cwd, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: isolatedEnv(),
  }).trim();
}
