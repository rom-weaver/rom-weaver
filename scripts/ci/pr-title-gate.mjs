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
// The verdict arrives as a structured report rather than commitlint's own
// paragraph, written by `commitlint-report.mjs`, so the advice can name the
// rule that actually failed instead of restating the same three sentences under
// every kind of failure.
//
// Like the CLA gate, the verdict is the status and never the job's exit code: a
// red job means the gate itself broke. The gate exits 0 on a bad title.
//
// Required env:
//   GH_TOKEN            token with statuses:write and pull-requests:write
//   GITHUB_REPOSITORY   owner/repo
//   PR_NUMBER           pull request number
//   LINT_VERDICT        "pass" or "fail", from commitlint's exit code
//   LINT_REPORT_FILE    JSON report from commitlint-report.mjs (read on "fail")
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createGitHubApi, createMarkerComment, createStatusPoster } from "./github-api.mjs";

const {
  GH_TOKEN,
  GITHUB_REPOSITORY: REPO,
  PR_NUMBER,
  LINT_VERDICT,
  LINT_REPORT_FILE = "",
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

// A failing report with no result in it means commitlint never got as far as
// linting - a missing config, a broken install. That is the gate breaking, not
// a bad title, so it throws rather than posting a comment about nothing.
function readReport() {
  if (!LINT_REPORT_FILE) throw new Error("pr-title-gate: LINT_REPORT_FILE is required on a failure");
  const report = JSON.parse(readFileSync(LINT_REPORT_FILE, "utf8"));
  const [result] = report.results ?? [];
  if (!result) throw new Error(`pr-title-gate: ${LINT_REPORT_FILE} holds no lint result`);
  return { errors: result.errors ?? [], warnings: result.warnings ?? [] };
}

// The title is attacker-controlled, so every place it is echoed is a fenced
// block or an inline code span. Inside either GitHub neither links nor notifies
// an `@mention`; the only way out is a delimiter, and both helpers below open
// with one longer than any run in the text. Indenting would not do: CommonMark
// accepts a closing fence indented up to three spaces.
const longestRun = (text) => Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));

const fenced = (text) => {
  const fence = "`".repeat(Math.max(3, longestRun(text) + 1));
  return `${fence}\n${text}\n${fence}`;
};

// A code span may not begin or end with a backtick unless it is padded, and a
// span cannot hold a line break at all - a title with one falls back to a fence.
const code = (text) => {
  if (text.includes("\n")) return `\n\n${fenced(text)}\n`;
  const tick = "`".repeat(longestRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${tick}${pad}${text}${pad}${tick}`;
};

const list = (values) => values.map((value) => `\`${value}\``).join(", ");

// commitlint's messages come from the rules in the base branch's config, not
// from the title, so they are ordinary trusted text - only the pipe that would
// split a table cell needs handling.
const cell = (text) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

// The level column earns its place only when there is something to tell apart:
// a failure is all errors unless a warning happens to ride along with it.
function table(errors, warnings) {
  const rows = [
    ...errors.map((problem) => ({ level: "error", problem })),
    ...warnings.map((problem) => ({ level: "warning", problem })),
  ];
  const graded = warnings.length > 0;
  return [
    graded ? "| Level | Rule | Problem |" : "| Rule | Problem |",
    graded ? "| --- | --- | --- |" : "| --- | --- |",
    ...rows.map(
      ({ level, problem }) =>
        `|${graded ? ` ${level} |` : ""} \`${problem.name}\` | ${cell(problem.message)} |`,
    ),
  ].join("\n");
}

// Rule names, not prose: what commitlint reports and what a contributor has to
// do about it are not the same thing. A title with no `type:` prefix trips both
// `type-empty` and `subject-empty`, which reads like two unrelated faults on a
// title that plainly has a subject; saying so once is the whole point of having
// the report structured.
function notes(names, title, { headerLimit }) {
  const out = [];
  if (names.has("type-empty")) {
    out.push(
      `The title carries no ${code("type:")} prefix, so commitlint finds neither a type nor a subject in it - that is why both are reported.`,
    );
  } else if (names.has("type-enum") || names.has("type-case")) {
    out.push(`${code(titleType(title) ?? "The type")} is not one of the types this project allows.`);
  }
  if (names.has("header-max-length")) {
    out.push(
      `The title is ${title.length} characters and the limit is ${headerLimit}, so ${title.length - headerLimit} have to go.`,
    );
  }
  if (names.has("subject-empty") && !names.has("type-empty")) {
    out.push("Everything after the colon is the description, and it may not be blank.");
  }
  return out.join(" ");
}

const titleType = (title) => title.match(/^([^\s(:!]+)/)?.[1];

// A mechanically valid rename of the contributor's own title, not a generic
// placeholder. Only two failures have one: no type at all (prefix one) and a
// type that is right but miscased (lower-case it). Anything else - an invented
// type, an over-long header - needs a decision this script cannot make, and
// suggesting a title the gate would reject in turn is worse than suggesting
// nothing.
function suggestion(title, names, { types, headerLimit }) {
  let proposed = null;
  if (names.has("type-empty")) {
    proposed = `fix: ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
  } else if (names.has("type-case") || names.has("type-enum")) {
    const type = titleType(title);
    const lowered = type?.toLowerCase();
    if (lowered && types.includes(lowered)) proposed = `${lowered}${title.slice(type.length)}`;
  }
  return proposed && proposed.length <= headerLimit ? proposed : null;
}

function failureBody(title, { errors, warnings }, rules) {
  const names = new Set(errors.map((problem) => problem.name));
  const explanation = notes(names, title, rules);
  const proposed = suggestion(title, names, rules);
  const typeRule = ["type-empty", "type-enum", "type-case"].some((name) => names.has(name));

  return `${BADGE}

> [!WARNING]
> This pull request's title is not a Conventional Commit. Rename it with the
> **Edit** button beside the title at the top of this pull request.

${fenced(title)}

${table(errors, warnings)}
${explanation ? `\n${explanation}\n` : ""}${
    proposed ? `\nRename it to:\n\n${fenced(proposed)}\n` : ""
  }
The title must read \`type(scope): description\`; the scope is optional.${
    typeRule ? ` Valid types: ${list(rules.types)}.` : ""
  }${
    // Worth spelling out only for someone whose type is what went wrong. A
    // title rejected for its length already has the shape right, and being
    // shown the shape again reads as the gate not having looked.
    typeRule && !proposed ? "\n\nExample: `feat(webapp): add sample assets`" : ""
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

const report = readReport();
const rules = await readRules();
const body = failureBody(pr.title, report, rules);

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
console.error(
  `${STATUS_CONTEXT} failure on ${pr.head.sha}: ${pr.title} (${report.errors
    .map((problem) => problem.name)
    .join(" ")})`,
);

// Exit 0 on a bad title, deliberately - see the header. Every other failure
// path throws.
process.exit(0);
