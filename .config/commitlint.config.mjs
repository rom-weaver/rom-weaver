export default {
  defaultIgnores: false,
  // Merge commits are the one default wildcard worth keeping: git writes them,
  // nobody can make them conventional. commitlint's `--git-log-args=--no-merges`
  // cannot do this - v21 pipes it through parseArgs into a git client that only
  // honors a `merges` boolean, so `--no-merges` is silently dropped.
  ignores: [(message) => /^Merge (branch|pull request|remote-tracking branch|tag) /.test(message)],
  extends: ["@commitlint/config-conventional"],
  rules: {
    // config-conventional caps the header at 100 chars, which rejects grouped
    // dependabot titles ("bump the X group in /packages/... with N updates").
    "header-max-length": [2, "always", 150],
    "type-enum": [
      2,
      "always",
      ["build", "chore", "ci", "docs", "dx", "feat", "fix", "perf", "refactor", "revert", "style", "test"],
    ],
  },
};
