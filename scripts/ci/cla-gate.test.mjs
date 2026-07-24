import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "cla-gate.sh");
const repoRoot = join(here, "..", "..");

// A stand-in for `gh api` that serves canned GET bodies and records every
// write, so the gate's decisions can be asserted without touching GitHub.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
endpoint=""; jq_expr=""; method=GET; content=""
shift # 'api'
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jq) jq_expr=$2; shift 2 ;;
    --method) method=$2; shift 2 ;;
    --field) [[ $2 == content=* ]] && content=\${2#content=}; shift 2 ;;
    --paginate|--silent) shift ;;
    *) endpoint=$1; shift ;;
  esac
done
printf '%s %s\\n' "$method" "$endpoint" >>"$GH_LOG"
fixture() { printf '%s/%s' "$GH_FIXTURES" "$(printf '%s' "$1" | tr '/?=' '___')"; }
# A signature write must be visible to the re-read that follows it.
if [[ $method == PUT && $endpoint == *contents/signatures.json ]]; then
  jq -n --arg c "$content" '{sha: "newsha", content: $c}' \\
    >"$(fixture "\${endpoint}?ref=cla-signatures")"
  exit 0
fi
[[ $method == GET ]] || exit 0
file=$(fixture "$endpoint")
[[ -f $file ]] || exit 1
if [[ -n $jq_expr ]]; then jq -r "$jq_expr" <"$file"; else cat "$file"; fi
`;

const REPO = "rom-weaver/rom-weaver";
const HEAD_SHA = "deadbeef";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

function run({ prAuthor, commitAuthors = [], signatures = [], comment } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cla-gate-"));
  const bin = join(dir, "bin");
  const fixtures = join(dir, "fixtures");
  execFileSync("mkdir", ["-p", bin, fixtures]);

  const gh = join(bin, "gh");
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);

  const fixture = (endpoint, body) =>
    writeFileSync(join(fixtures, endpoint.replaceAll(/[/?=]/g, "_")), JSON.stringify(body));

  fixture(`repos/${REPO}/pulls/7`, { head: { sha: HEAD_SHA }, user: { login: prAuthor } });
  fixture(
    `repos/${REPO}/pulls/7/commits`,
    commitAuthors.map((login) => ({ author: login ? { login } : null, commit: { author: { name: "Nobody" } } })),
  );
  if (signatures) {
    fixture(`repos/${REPO}/contents/signatures.json?ref=cla-signatures`, {
      sha: "sigsha",
      content: encode(signatures),
    });
  }
  fixture(`repos/${REPO}/issues/7/comments`, []);
  fixture(`users/${comment?.author}`, { id: 4242 });

  const log = join(dir, "gh.log");
  writeFileSync(log, "");

  let status = 0;
  try {
    execFileSync(script, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_LOG: log,
        GH_FIXTURES: fixtures,
        GITHUB_REPOSITORY: REPO,
        PR_NUMBER: "7",
        COMMENT_BODY: comment?.body ?? "",
        COMMENT_AUTHOR: comment?.author ?? "",
      },
    });
  } catch (error) {
    status = error.status;
  }

  return { status, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

const wrote = (calls, method, fragment) =>
  calls.some((call) => call.startsWith(`${method} `) && call.includes(fragment));

test("the signing phrase matches the one CLA.md tells contributors to post", () => {
  const phrase = readFileSync(script, "utf8").match(/^SIGN_PHRASE="(.+)"$/m)[1];
  assert.ok(
    readFileSync(join(repoRoot, "CLA.md"), "utf8").includes(phrase),
    `CLA.md does not quote the phrase the gate accepts: ${phrase}`,
  );
});

test("a signed contributor passes", () => {
  const { status, calls } = run({ prAuthor: "outsider", signatures: [{ login: "outsider" }] });
  assert.equal(status, 0);
  assert.ok(wrote(calls, "POST", `statuses/${HEAD_SHA}`));
  // Nothing to say when the check already passes.
  assert.ok(!wrote(calls, "POST", "issues/7/comments"));
});

test("an unsigned contributor fails and is asked to sign", () => {
  const { status, calls } = run({ prAuthor: "outsider", signatures: [] });
  assert.equal(status, 1);
  assert.ok(wrote(calls, "POST", `statuses/${HEAD_SHA}`));
  assert.ok(wrote(calls, "POST", "issues/7/comments"));
});

test("bots are exempt without any signature", () => {
  const { status } = run({ prAuthor: "dependabot[bot]", signatures: [] });
  assert.equal(status, 0);
});

test("a bot pull request carrying a human's commit still needs that human", () => {
  const { status } = run({
    prAuthor: "dependabot[bot]",
    commitAuthors: ["outsider"],
    signatures: [],
  });
  assert.equal(status, 1);
});

test("the maintainer is exempt", () => {
  const { status } = run({ prAuthor: "brandonocasey", signatures: [] });
  assert.equal(status, 0);
});

test("the signing phrase records a signature and passes", () => {
  const { status, calls } = run({
    prAuthor: "outsider",
    signatures: [],
    comment: {
      author: "outsider",
      body: "I have read the CLA Document and I hereby sign the CLA",
    },
  });
  assert.ok(wrote(calls, "PUT", "contents/signatures.json"));
  assert.equal(status, 0);
});

test("the first signature ever creates the file instead of updating it", () => {
  // `signatures: null` stands for "the file does not exist yet", which is a
  // separate code path: the write must omit the blob sha.
  const { status, calls } = run({
    prAuthor: "outsider",
    signatures: null,
    comment: {
      author: "outsider",
      body: "I have read the CLA Document and I hereby sign the CLA",
    },
  });
  assert.ok(wrote(calls, "PUT", "contents/signatures.json"));
  assert.equal(status, 0);
});

test("the phrase from a bystander records nothing", () => {
  const { calls } = run({
    prAuthor: "outsider",
    signatures: [],
    comment: {
      author: "drive-by",
      body: "I have read the CLA Document and I hereby sign the CLA",
    },
  });
  assert.ok(!wrote(calls, "PUT", "contents/signatures.json"));
});

test("a commit author with no linked account is reported, not skipped", () => {
  const { status } = run({
    prAuthor: "brandonocasey",
    commitAuthors: [null],
    signatures: [],
  });
  assert.equal(status, 1);
});
