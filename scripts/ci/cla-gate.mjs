#!/usr/bin/env node
//
// Post the required `CLA Status` commit status for a pull request, and record
// signatures given by comment.
//
// This replaces the hosted CLA Assistant app, which only ever posted in
// response to a `pull_request` event and left a force-pushed head permanently
// without a status - an unmergeable pull request with no re-run button
// anywhere. A workflow reruns on demand, fires on `synchronize` (which
// force-pushes emit), and always targets the current head SHA.
//
// Policy (the allowlist) lives on the default branch where it is review-gated;
// signature data lives on the unprotected SIGNATURES_BRANCH, because the
// ruleset on the default branch forbids direct pushes and grants no bypass
// actors.
//
// Required env:
//   GH_TOKEN            token with statuses:write, pull-requests:write, contents:write
//   GITHUB_REPOSITORY   owner/repo
//   PR_NUMBER           pull request number
//   COMMENT_BODY        body of the triggering comment (empty for pull_request events)
//   COMMENT_AUTHOR      login of the comment author (empty for pull_request events)
import { readFileSync } from "node:fs";

const {
  GH_TOKEN,
  GITHUB_REPOSITORY: REPO,
  PR_NUMBER,
  COMMENT_BODY = "",
  COMMENT_AUTHOR = "",
  GITHUB_API_URL = "https://api.github.com",
  GITHUB_SERVER_URL = "https://github.com",
  GITHUB_RUN_ID = "",
  SIGNATURES_BRANCH = "cla-signatures",
  SIGNATURES_PATH = "signatures.json",
  ALLOWLIST_FILE = ".github/cla-allowlist.txt",
} = process.env;

const CLA_DOCUMENT =
  process.env.CLA_DOCUMENT ?? `${GITHUB_SERVER_URL}/${REPO}/blob/main/CLA.md`;
// Quoted verbatim in CLA.md section 7. Changing it here without changing it
// there leaves contributors typing a phrase this gate will not accept.
const SIGN_PHRASE = "I have read the CLA Document and I hereby sign the CLA";
const COMMENT_MARKER = "<!-- rom-weaver-cla-gate -->";

for (const [name, value] of Object.entries({ GH_TOKEN, REPO, PR_NUMBER })) {
  if (!value) throw new Error(`cla-gate: ${name} is required but was empty`);
}

async function api(path, { method = "GET", body, allow404 = false } = {}) {
  // The key has to be absent rather than undefined on a GET: fetch rejects the
  // combination, and oxlint flags it statically.
  const init = {
    method,
    headers: {
      authorization: `Bearer ${GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "rom-weaver-cla-gate",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await fetch(`${GITHUB_API_URL}${path}`, init);

  if (response.status === 404 && allow404) return null;
  if (!response.ok) {
    throw new Error(
      `cla-gate: ${method} ${path} failed with ${response.status}: ${await response.text()}`,
    );
  }
  return response.status === 204 ? null : response.json();
}

// The Link header is the only reliable page count; a short page is not proof of
// the last one.
async function paginate(path) {
  const items = [];
  let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (next) {
    const response = await fetch(`${GITHUB_API_URL}${next}`, {
      headers: {
        authorization: `Bearer ${GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "rom-weaver-cla-gate",
      },
    });
    if (!response.ok) {
      throw new Error(
        `cla-gate: GET ${next} failed with ${response.status}: ${await response.text()}`,
      );
    }
    items.push(...(await response.json()));
    const link = response.headers.get("link") ?? "";
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    next = match ? match[1].replace(GITHUB_API_URL, "") : null;
  }
  return items;
}

// `*` and `?` are wildcards; every other character is literal. Escaping the
// rest matters most for brackets: every GitHub App login ends in the four
// characters `[bot]`, and treating those as a character class would match a
// trailing b, o or t instead - the bug the shell version of this shipped with.
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
  // Buffer ignores the newlines the contents API wraps its base64 with, which
  // jq's @base64d did not - the second bug the shell version shipped with.
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

// The phrase must be a line of its own. A substring match signed anyone who
// quoted it while asking how signing works.
const signedByComment = COMMENT_BODY.split("\n").some((line) => line.trim() === SIGN_PHRASE);

// `COMMENT_AUTHOR` is `github.event.comment.user.login`, which GitHub sets from
// the authenticated session that posted the comment - not content the commenter
// controls. Requiring it to be one of this pull request's authors is what stops
// anyone appending themselves to the file from an unrelated thread.
if (
  signedByComment &&
  COMMENT_AUTHOR &&
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

const postStatus = (state, description, targetUrl) =>
  api(`/repos/${REPO}/statuses/${headSha}`, {
    method: "POST",
    body: { state, context: "CLA Status", description, target_url: targetUrl },
  });

// One comment per pull request, edited in place, so a rebase does not bury the
// thread under duplicates. `editOnly` skips creating one at all, which keeps
// the overwhelmingly common case - a pull request from someone who has already
// signed - completely silent.
async function upsertComment(body, { editOnly = false } = {}) {
  const comments = await paginate(`/repos/${REPO}/issues/${PR_NUMBER}/comments`);
  const existing = comments.find((comment) => comment.body.includes(COMMENT_MARKER));
  if (existing) {
    await api(`/repos/${REPO}/issues/comments/${existing.id}`, { method: "PATCH", body: { body } });
  } else if (!editOnly) {
    await api(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, { method: "POST", body: { body } });
  }
}

if (unsigned.length === 0) {
  await postStatus("success", "All contributors have signed the CLA", CLA_DOCUMENT);
  await upsertComment(
    `${COMMENT_MARKER}\n**CLA signed.** All contributors to this pull request have signed the\n[Contributor License Agreement](${CLA_DOCUMENT}).`,
    { editOnly: true },
  );
  console.log(`CLA Status success on ${headSha} (authors: ${authors.join(" ")})`);
  process.exit(0);
}

const runUrl = `${GITHUB_SERVER_URL}/${REPO}/actions/runs/${GITHUB_RUN_ID}`;
await postStatus("failure", `Awaiting CLA signature from ${unsigned.length} contributor(s)`, runUrl);

await upsertComment(`${COMMENT_MARKER}
**CLA signature required.**

${unsigned.map((login) => `- @${login}`).join("\n")}

Please read the [Contributor License Agreement](${CLA_DOCUMENT}) and, if you
agree, post a new comment whose own line reads exactly:

> ${SIGN_PHRASE}

Signing covers all of your past and future contributions. Comment \`recheck\` at
any time to re-run this check.

Commits listed as \`unlinked:<name>\` have an author email that matches no
GitHub account - fix the commit author or say so in the thread.`);

console.error(`CLA Status failure on ${headSha}; unsigned: ${unsigned.join(" ")}`);

// Exit 0 on an unsigned verdict, deliberately. The `CLA Status` status is the
// single signal for CLA compliance and the one the ruleset can require; a red
// job on top of it says the same thing twice. Keeping the job green here means
// a red `CLA` job says something the status cannot: the gate itself broke - a
// failed API call, an unparseable signature file - rather than someone simply
// not having signed. Every other failure path throws.
process.exit(0);
