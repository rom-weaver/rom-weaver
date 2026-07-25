#!/usr/bin/env node
//
// Post the required `Gates/PR Title Lint` commit status, and keep one comment
// on the pull request for as long as - and only as long as - the title is
// wrong.
//
// commitlint itself runs in the workflow step, not here: this script only turns
// its verdict into the two things a contributor actually sees. Splitting it
// that way keeps the untrusted title out of `GITHUB_OUTPUT` (a title containing
// a heredoc delimiter could otherwise forge step outputs) and leaves this half
// testable without installing commitlint.
//
// Like the CLA gate, the verdict is the status and never the job's exit code: a
// red job means the gate itself broke. The gate exits 0 on a bad title.
//
// Required env:
//   GH_TOKEN            token with statuses:write and pull-requests:write
//   GITHUB_REPOSITORY   owner/repo
//   PR_NUMBER           pull request number
//   LINT_VERDICT        "pass" or "fail", from commitlint's exit code
//   LINT_OUTPUT_FILE    file holding commitlint's stdout+stderr (read on "fail")
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createGitHubApi, createMarkerComment, createStatusPoster } from "./github-api.mjs";

const {
  GH_TOKEN,
  GITHUB_REPOSITORY: REPO,
  PR_NUMBER,
  LINT_VERDICT,
  LINT_OUTPUT_FILE = "",
  GITHUB_API_URL = "https://api.github.com",
  GITHUB_SERVER_URL = "https://github.com",
  GITHUB_RUN_ID = "",
  GITHUB_STEP_SUMMARY = "",
  COMMITLINT_CONFIG = ".config/commitlint.config.mjs",
} = process.env;

const STATUS_CONTEXT = "Gates/PR Title Lint";
const COMMENT_MARKER = "<!-- rom-weaver-pr-title-gate -->";
// Matches the CLA gate's badge, for the same reason and from the same palette.
// This gate has no signed-style twin: a passing title deletes the comment.
const BADGE =
  "![PR title: not conventional](https://img.shields.io/badge/PR%20title-not%20conventional-c1440e)";

for (const [name, value] of Object.entries({ GH_TOKEN, REPO, PR_NUMBER, LINT_VERDICT })) {
  if (!value) throw new Error(`pr-title-gate: ${name} is required but was empty`);
}
if (LINT_VERDICT !== "pass" && LINT_VERDICT !== "fail") {
  throw new Error(`pr-title-gate: LINT_VERDICT must be "pass" or "fail", got "${LINT_VERDICT}"`);
}

// The allowed types come from the config commitlint was just run with, so the
// advice a contributor is given cannot drift from the rule that rejected them.
async function readRules() {
  const config = await import(pathToFileURL(COMMITLINT_CONFIG).href);
  const types = config.default?.rules?.["type-enum"];
  if (!Array.isArray(types?.[2])) {
    throw new Error(`pr-title-gate: ${COMMITLINT_CONFIG} declares no type-enum values`);
  }
  return { types: types[2], headerLimit: config.default?.rules?.["header-max-length"]?.[2] ?? 100 };
}

// commitlint echoes the offending title back, so the quoted block holds
// attacker-controlled text. Inside a fence GitHub neither links nor notifies an
// `@mention`; the only way out is a closing fence, and a closing fence may not
// be shorter than the one that opened the block. Indenting would not do:
// CommonMark accepts a closing fence indented up to three spaces.
const fenced = (text) => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
};

const list = (values) => values.map((value) => `\`${value}\``).join(", ");

// A mechanically valid rename of the contributor's own title, not a generic
// placeholder: prefixing a type is the whole fix in the overwhelming majority
// of cases. Suppressed when the prefix would push the header past the
// configured limit, since suggesting a title the gate would also reject is
// worse than suggesting nothing.
function suggestion(title, limit) {
  const proposed = `fix: ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
  return proposed.length <= limit ? proposed : null;
}

function failureBody(problems, types, title, limit) {
  const proposed = suggestion(title, limit);
  return `${BADGE}

> [!WARNING]
> This pull request's title is not a Conventional Commit. Rename it with the
> **Edit** button beside the title at the top of this pull request.

${fenced(problems)}

The title must read \`type(scope): description\`; the scope is optional. Valid
types: ${list(types)}.
${
  proposed
    ? `\nFor this title, that would be:\n\n\`\`\`\n${proposed}\n\`\`\`\n`
    : "\nExample: \`feat(webapp): add sample assets\`\n"
}
This check reruns when the title is edited, and this comment disappears once it
passes.`;
}

const { api, paginate } = createGitHubApi({
  token: GH_TOKEN,
  apiUrl: GITHUB_API_URL,
  name: "pr-title-gate",
});

const pr = await api(`/repos/${REPO}/pulls/${PR_NUMBER}`);
const postStatus = createStatusPoster({
  api,
  repo: REPO,
  sha: pr.head.sha,
  context: STATUS_CONTEXT,
});
const comment = createMarkerComment({
  api,
  paginate,
  repo: REPO,
  prNumber: PR_NUMBER,
  marker: COMMENT_MARKER,
});

if (LINT_VERDICT === "pass") {
  await postStatus("success", "Pull request title follows Conventional Commits");
  // Deleted rather than edited to a success note: the title being right is the
  // normal state, and a passing pull request should carry no gate chatter.
  await comment.remove();
  console.log(`${STATUS_CONTEXT} success on ${pr.head.sha}: ${pr.title}`);
  process.exit(0);
}

const problems = LINT_OUTPUT_FILE ? readFileSync(LINT_OUTPUT_FILE, "utf8").trim() : "";
const { types, headerLimit } = await readRules();
const body = failureBody(problems || "commitlint reported no detail", types, pr.title, headerLimit);

await postStatus(
  "failure",
  "Rename the pull request to type(scope): description",
  `${GITHUB_SERVER_URL}/${REPO}/actions/runs/${GITHUB_RUN_ID}`,
);
await comment.upsert(`${COMMENT_MARKER}\n${body}`);

if (GITHUB_STEP_SUMMARY) {
  appendFileSync(GITHUB_STEP_SUMMARY, `## Invalid pull request title\n\n${body}\n`);
}

console.log("::error title=Invalid pull request title::Rename the pull request using Conventional Commits; see the comment on the pull request.");
console.error(`${STATUS_CONTEXT} failure on ${pr.head.sha}: ${pr.title}`);

// Exit 0 on a bad title, deliberately - see the header. Every other failure
// path throws.
process.exit(0);
