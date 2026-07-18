export default {
  defaultIgnores: false,
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["build", "chore", "ci", "docs", "dx", "feat", "fix", "perf", "refactor", "revert", "style", "test"],
    ],
  },
};
