#!/usr/bin/env node

// Pre-push hook: the bundle checks of
// docs/development/reproduce-ci-locally.md#prevent-repeat-failures, selected by
// the same classifier CI uses, so a push runs them exactly when CI's webapp
// build would.

import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { classifyChanges } from "./ci/classify-changes.mjs";
import { resolveNpmCli } from "./ci/npm-publish-package.mjs";

const WEBAPP = "packages/rom-weaver-webapp";

export const WEBAPP_BUNDLE_STEPS = [
  { label: "production WASM", command: "mise", args: ["run", "build-wasm-prod"] },
  { label: "production webapp build", command: "npm", args: ["--prefix", WEBAPP, "run", "build"], env: { ROM_WEAVER_CHANNEL: "prod" } },
  { label: "worker chunk guard", command: "npm", args: ["--prefix", WEBAPP, "run", "check:worker-chunk"] },
];

// The bundle from the steps above MUST be the one E2E reuses; a rebuild would default to the dev channel.
export const A11Y_STEP = {
  label: "accessibility E2E",
  command: "npm",
  args: ["--prefix", WEBAPP, "run", "test:e2e:a11y"],
  env: { ROM_WEAVER_CHANNEL: "prod", ROM_WEAVER_E2E_USE_PREBUILT_DIST: "1" },
};

// git writes one "<local ref> <local sha> <remote ref> <remote sha>" line per
// pushed ref; an all-zero local sha deletes the remote ref.
export function pushedCommits(stdin) {
  const refs = stdin
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 4);
  return { refs: refs.length, commits: refs.map((fields) => fields[1]).filter((sha) => !/^0+$/.test(sha)) };
}

// changedPaths is undefined when no base resolves; every check then runs, the
// classifier's own fail-open default.
export function planPrePush({ pushed, head, changedPaths, e2e = false }) {
  if (pushed.refs === 0) return { steps: [], reason: "git reported no pushed refs" };
  if (pushed.commits.length === 0) return { steps: [], reason: "the push only deletes refs" };
  // The checks build the working tree, which only matches a pushed HEAD.
  if (!pushed.commits.includes(head)) return { steps: [], reason: "HEAD is not among the pushed commits" };
  // A push to a branch reaches CI as its pull request, whose event narrows webapp_browser.
  const selection = classifyChanges(changedPaths ?? [], changedPaths === undefined, "pull_request");
  if (!selection.webapp) return { steps: [], reason: "no webapp or published-doc change since the base" };
  const browser = selection.webapp_browser;
  return { steps: browser && e2e ? [...WEBAPP_BUNDLE_STEPS, A11Y_STEP] : WEBAPP_BUNDLE_STEPS, browser };
}

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const tryGit = (args) => {
  try {
    return git(args);
  } catch {
    return undefined;
  }
};

// CI classifies a pull request against its base, so diff from the merge base
// with the remote's default branch rather than the remote branch's old tip.
function changedSinceBase(remote) {
  const base = [`refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/main`]
    .map((ref) => tryGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))
    .find(Boolean);
  const mergeBase = base && tryGit(["merge-base", base, "HEAD"]);
  if (!mergeBase) return undefined;
  // --no-renames as in classify-workflow.mjs: a move MUST report its old path too, which can select the webapp.
  return git(["diff", "--name-only", "--no-renames", `${mergeBase}...HEAD`]).split("\n").filter(Boolean);
}

// A synchronous read of fd 0 fails with EAGAIN when the pipe git or lefthook
// hands over is non-blocking; the stream API waits for the data instead.
async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const remote = argv[0] || "origin";
  const head = git(["rev-parse", "HEAD"]);
  const plan = planPrePush({
    pushed: pushedCommits(await readStdin()),
    head,
    changedPaths: changedSinceBase(remote),
    e2e: env.ROM_WEAVER_PRE_PUSH_E2E === "1",
  });
  // stderr: lefthook does not show a passing command's stdout when push runs without a terminal.
  const log = (message) => process.stderr.write(`[pre-push] ${message}\n`);
  if (plan.steps.length === 0) {
    log(`skipped bundle checks: ${plan.reason}`);
    return;
  }
  if (git(["status", "--porcelain", "--untracked-files=no"])) log("warning: uncommitted changes are part of the checked bundle");
  const root = git(["rev-parse", "--show-toplevel"]);
  for (const step of plan.steps) {
    log(`${step.label}: ${step.command} ${step.args.join(" ")}`);
    try {
      const npmCli = step.command === "npm" && process.platform === "win32" ? resolveNpmCli({ env }) : undefined;
      execFileSync(npmCli ? process.execPath : step.command, npmCli ? [npmCli, ...step.args] : step.args, { cwd: root, stdio: "inherit", env: { ...env, ...step.env } });
    } catch (error) {
      throw new Error(`${step.label} failed (${error.message.split("\n")[0]}); fix it, or push with --no-verify to skip these checks`);
    }
  }
  if (plan.browser && env.ROM_WEAVER_PRE_PUSH_E2E !== "1")
    log("UI change: run the affected browser tests from docs/development/reproduce-ci-locally.md#prevent-repeat-failures, or push with ROM_WEAVER_PRE_PUSH_E2E=1 to add the accessibility E2E on this bundle");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[pre-push] ${error.message}\n`);
    process.exitCode = 1;
  });
}
