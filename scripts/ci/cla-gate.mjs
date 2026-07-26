#!/usr/bin/env node
//
// Post the required `CLA Signed` commit status for a pull request, and record
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
} = process.env;

const CLA_DOCUMENT =
  process.env.CLA_DOCUMENT ?? `${GITHUB_SERVER_URL}/${REPO}/blob/main/CLA.md`;
// Quoted verbatim in CLA.md section 7. Changing it here without changing it
// there leaves contributors typing a phrase this gate will not accept.
const SIGN_PHRASE = "I have read and agree to the CLA";
const COMMENT_MARKER = "<!-- rom-weaver-cla-gate -->";
const STATUS_CONTEXT = "CLA Signed";
// The verdict at a glance, the way the CLA Assistant comment carried one.
// shields.io is already the badge service the README uses, and these are static
// URLs - they encode no repository, pull request or contributor, so GitHub's
// image proxy has nothing about this pull request to leak upstream. Colours are
// the README's palette rather than shields' defaults.
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

// The phrase must still be a line of its own - a substring match signed anyone
// who quoted it while asking how signing works - but exact equality rejected a
// trailing full stop, a capital letter, or the emphasis GitHub's editor adds,
// and rejected it in total silence. Deliberately NOT stripped: a leading `>`.
// Accepting a quoted line would turn "quote the request, then ask what it
// means" into a signature, and the quote-reply flow does not need it - the text
// you type under the quote is unquoted already.
// The two classes are kept identical on purpose. They drifted once - the
// trailing one carried a backtick and a `-` bullet that the leading one did
// not - so a phrase pasted back inside a code span was rejected while the same
// phrase in bold signed, and that is the shape of silent rejection this
// normalizing exists to end. The gate offers the phrase in a fenced block, so
// backticks are precisely what a contributor has to hand.
const DELIMITERS = String.raw`\s*_\-\``;
const normalize = (line) =>
  line
    .replace(new RegExp(`^[${DELIMITERS}]+`), "")
    .replace(new RegExp(`[${DELIMITERS}.!]+$`), "")
    .toLowerCase()
    .replaceAll(/\s+/g, " ");
const wanted = normalize(SIGN_PHRASE);
const signedByComment = COMMENT_BODY.split("\n").some((line) => normalize(line) === wanted);

// Said the words, but not as the whole line: extra words around them, or a
// quote-reply. Neither signs - but both used to fall through in silence, and a
// contributor who believes they have signed is exactly who this gate owes an
// answer. The `>` is stripped only to recognise the near miss, never to accept
// one.
const nearMiss =
  !signedByComment &&
  COMMENT_BODY.split("\n").some((line) => normalize(line.replace(/^[\s>]+/, "")).includes(wanted));

// `COMMENT_AUTHOR` is `github.event.comment.user.login`, which GitHub sets from
// the authenticated session that posted the comment - not content the commenter
// controls. Requiring it to be one of this pull request's authors is what stops
// anyone appending themselves to the file from an unrelated thread.
//
// The gate runs on an edited comment too, because the near-miss note asks for a
// correction and editing the offending comment is the obvious way to make one.
// That is also why the sender has to be the author: anyone with write access can
// edit somebody else's comment, and without this a maintainer could type the
// phrase into a contributor's comment and record a signature that contributor
// never gave. `sender` is the editor, so signing needs the two to agree.
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

// Exit 0 on an unsigned verdict, deliberately. The `CLA Signed` status is the
// single signal for CLA compliance and the one the ruleset can require; a red
// job on top of it says the same thing twice. Keeping the job green here means
// a red `CLA Check` job says something the status cannot: the gate itself broke - a
// failed API call, an unparseable signature file - rather than someone simply
// not having signed. Every other failure path throws.
process.exit(0);
