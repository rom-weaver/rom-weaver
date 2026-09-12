#!/usr/bin/env node
// The status MUST target the current pull request head, including after a force push.
// The allowlist stays review-gated on the default branch; signatures use SIGNATURES_BRANCH because direct pushes to the default branch are forbidden.
//
// Required env:
//   GH_TOKEN            token with statuses:write, pull-requests:write, contents:write
//   GITHUB_REPOSITORY   owner/repo
//   PR_NUMBER           pull request number
//   COMMENT_BODY        body of the triggering comment (empty for pull_request events)
//   COMMENT_AUTHOR      login of the comment author (empty for pull_request events)
//   COMMENT_SENDER      login of whoever triggered it; differs from the author
//                       on an edit, and must match it for the comment to sign
import { readFileSync } from "node:fs";

import { createGitHubApi, createMarkerComment, createStatusPoster } from "./github-api.mjs";

const {
  GH_TOKEN,
  GITHUB_REPOSITORY: REPO,
  PR_NUMBER,
  COMMENT_BODY = "",
  COMMENT_AUTHOR = "",
  COMMENT_SENDER = "",
  GITHUB_API_URL = "https://api.github.com",
  GITHUB_SERVER_URL = "https://github.com",
  GITHUB_RUN_ID = "",
  SIGNATURES_BRANCH = "cla-signatures",
  SIGNATURES_PATH = "signatures.json",
  ALLOWLIST_FILE = ".github/cla-allowlist.txt",
  CLA_FILE = "CLA.md",
  CLA_REF = "",
} = process.env;

// CLA.md section 6 requires each signature to identify the agreed text.
// The workflow MUST supply CLA_REF from the pull request's base commit to keep that link immutable.
const CLA_DOCUMENT =
  process.env.CLA_DOCUMENT ??
  `${GITHUB_SERVER_URL}/${REPO}/blob/${CLA_REF || "main"}/${CLA_FILE}`;
// CLA.md section 6 requires a readable version in each signature record.
// A missing version MUST stop the gate before it records signatures.
const CLA_VERSION = readClaVersion();

function readClaVersion() {
  let contents;
  try {
    contents = readFileSync(CLA_FILE, "utf8");
  } catch (cause) {
    throw new Error(`cla-gate: cannot read the CLA document at ${CLA_FILE}`, { cause });
  }
  const version = contents.match(/^Version\s+(\S+)/m)?.[1];
  if (!version) {
    throw new Error(
      `cla-gate: no \`Version X.Y\` line found in ${CLA_FILE}; the signature record cannot name a version`,
    );
  }
  return version;
}
// This phrase MUST match CLA.md section 7 so the documented signature is accepted.
const SIGN_PHRASE = "I have read and agree to the CLA";
const COMMENT_MARKER = "<!-- rom-weaver-cla-gate -->";
const STATUS_CONTEXT = "CLA Signed";
// Static badge URLs contain no repository, pull request, or contributor data.
const BADGE = {
  required: "![CLA: signature required](https://img.shields.io/badge/CLA-signature%20required-c1440e)",
  signed: "![CLA: signed](https://img.shields.io/badge/CLA-signed-4a6d63)",
};

for (const [name, value] of Object.entries({ GH_TOKEN, REPO, PR_NUMBER })) {
  if (!value) throw new Error(`cla-gate: ${name} is required but was empty`);
}

const { api, paginate } = createGitHubApi({
  token: GH_TOKEN,
  apiUrl: GITHUB_API_URL,
  name: "cla-gate",
});

// Only * and ? are wildcards; brackets in bot logins MUST stay literal.
function globToRegExp(pattern) {
  const escaped = pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", ".*").replaceAll("\\?", ".")}$`);
}

function readAllowlist() {
  let contents;
  try {
    contents = readFileSync(ALLOWLIST_FILE, "utf8");
  } catch {
    return [];
  }
  return contents
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map(globToRegExp);
}

const allowlist = readAllowlist();
const isAllowed = (login) => allowlist.some((pattern) => pattern.test(login));

async function readSignatures() {
  const file = await api(
    `/repos/${REPO}/contents/${SIGNATURES_PATH}?ref=${SIGNATURES_BRANCH}`,
    { allow404: true },
  );
  if (!file) return { sha: null, signatures: [] };
  // The contents API wraps base64 across lines; Buffer accepts those newlines.
  return {
    sha: file.sha,
    signatures: JSON.parse(Buffer.from(file.content, "base64").toString("utf8")),
  };
}

const pr = await api(`/repos/${REPO}/pulls/${PR_NUMBER}`);
const headSha = pr.head.sha;

// `login` is null for commits whose author email matches no GitHub account.
// Those cannot sign by comment, so they are reported by name rather than
// silently dropped.
const commits = await paginate(`/repos/${REPO}/pulls/${PR_NUMBER}/commits`);
const authors = [
  ...new Set([
    pr.user.login,
    ...commits.map((commit) => commit.author?.login ?? `unlinked:${commit.commit.author.name}`),
  ]),
].filter(Boolean);

let { sha: signaturesSha, signatures } = await readSignatures();
const hasSigned = (login) => signatures.some((entry) => entry.login === login);

// A signature MUST occupy a complete, unquoted line; surrounding Markdown delimiters, case, and trailing punctuation are normalized.
// Leading > characters MUST remain so quoted requests cannot count as signatures.
const DELIMITERS = String.raw`\s*_\-\``;
const normalize = (line) =>
  line
    .replace(new RegExp(`^[${DELIMITERS}]+`), "")
    .replace(new RegExp(`[${DELIMITERS}.!]+$`), "")
    .toLowerCase()
    .replaceAll(/\s+/g, " ");
const wanted = normalize(SIGN_PHRASE);
const signedByComment = COMMENT_BODY.split("\n").some((line) => normalize(line) === wanted);

// Quoted or extended phrases receive correction guidance but MUST NOT count as signatures.
const nearMiss =
  !signedByComment &&
  COMMENT_BODY.split("\n").some((line) => normalize(line.replace(/^[\s>]+/, "")).includes(wanted));

// Signatures MUST come from a pull request author editing their own comment.
// The event sender identifies the editor, who can differ from the comment author.
const selfAuthored = !COMMENT_SENDER || COMMENT_SENDER === COMMENT_AUTHOR;
if (
  signedByComment &&
  COMMENT_AUTHOR &&
  selfAuthored &&
  authors.includes(COMMENT_AUTHOR) &&
  !hasSigned(COMMENT_AUTHOR) &&
  !isAllowed(COMMENT_AUTHOR)
) {
  const { id } = await api(`/users/${COMMENT_AUTHOR}`);
  const updated = [
    ...signatures,
    {
      login: COMMENT_AUTHOR,
      id,
      pullRequest: Number(PR_NUMBER),
      signedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      claVersion: CLA_VERSION,
      cla: CLA_DOCUMENT,
    },
  ];

  await api(`/repos/${REPO}/contents/${SIGNATURES_PATH}`, {
    method: "PUT",
    body: {
      message: `chore(cla): record signature from ${COMMENT_AUTHOR} (#${PR_NUMBER})`,
      branch: SIGNATURES_BRANCH,
      content: Buffer.from(`${JSON.stringify(updated, null, 2)}\n`).toString("base64"),
      // Absent on the very first signature, when the PUT creates the file.
      ...(signaturesSha ? { sha: signaturesSha } : {}),
    },
  });
  console.log(`recorded CLA signature from ${COMMENT_AUTHOR}`);

  ({ sha: signaturesSha, signatures } = await readSignatures());
}

const unsigned = authors.filter((login) => !isAllowed(login) && !hasSigned(login));

const postStatus = createStatusPoster({ api, repo: REPO, sha: headSha, context: STATUS_CONTEXT });

// `editOnly` on the success path keeps the overwhelmingly common case - a pull
// request from someone who has already signed - completely silent.
const { upsert: upsertComment } = createMarkerComment({
  api,
  paginate,
  repo: REPO,
  prNumber: PR_NUMBER,
  marker: COMMENT_MARKER,
});

if (unsigned.length === 0) {
  await postStatus("success", "All contributors have signed the CLA", CLA_DOCUMENT);
  await upsertComment(
    `${COMMENT_MARKER}
${BADGE.signed}

> [!TIP]
> Every contributor to this pull request has signed the [CLA](${CLA_DOCUMENT}).`,
    { editOnly: true },
  );
  console.log(`${STATUS_CONTEXT} success on ${headSha} (authors: ${authors.join(" ")})`);
  process.exit(0);
}

const runUrl = `${GITHUB_SERVER_URL}/${REPO}/actions/runs/${GITHUB_RUN_ID}`;
await postStatus("failure", `Awaiting CLA signature from ${unsigned.length} contributor(s)`, runUrl);

// `unlinked:<name>` authors cannot be mentioned and cannot sign by comment, so
// they are shown as code and explained - but only when one is actually present.
const mention = (login) => (login.startsWith("unlinked:") ? `\`${login}\`` : `@${login}`);
const unlinked = unsigned.filter((login) => login.startsWith("unlinked:"));

await upsertComment(`${COMMENT_MARKER}
${BADGE.required}

> [!WARNING]
> ${unsigned.map(mention).join(", ")} ${unsigned.length === 1 ? "has" : "have"} not signed the [CLA](${CLA_DOCUMENT}). ${unsigned.length === 1 ? "Post a comment" : "Each of you must post a comment"} whose own line reads:

\`\`\`
${SIGN_PHRASE}
\`\`\`
${
  nearMiss
    ? "\n> [!NOTE]\n> A comment on this pull request has that phrase, but not as the whole line - it was quoted, or it had other words around it. Post it on a line of its own, unquoted.\n"
    : ""
}
Edit a comment or post another to retry.${
  unlinked.length
    ? "\n\nAn `unlinked:<name>` author has a commit email matching no GitHub account, so they cannot sign by comment - fix the commit author or say so in the thread."
    : ""
}`);

console.error(`${STATUS_CONTEXT} failure on ${headSha}; unsigned: ${unsigned.join(" ")}`);

// Unsigned contributors fail the CLA Signed status; the job fails only when the
// gate cannot evaluate signatures, such as an API or parsing error.
process.exit(0);
