#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runMain } from "./run-main.mjs";
export function guardrailSource(base, git) {
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const path = "scripts/quality-guardrails.mjs";
  const exists = git(["ls-tree", "--name-only", mergeBase, "--", path]).trim();
  return { mergeBase, source: exists ? git(["show", `${mergeBase}:${path}`]) : null };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runMain(() => {
    const base = process.argv[2];
    if (!base) throw new Error("A guardrail merge-base ref is required");
    const { mergeBase, source } = guardrailSource(base, (args) =>
      execFileSync("git", args, { encoding: "utf8" }),
    );
    const scratch = resolve(".agent/quality-signals/trusted-guardrails.mjs");
    let script = "scripts/quality-guardrails.mjs";
    if (source) {
      mkdirSync(resolve(".agent/quality-signals"), { recursive: true });
      writeFileSync(scratch, source);
      script = scratch;
    } else
      process.stderr.write(
        "Bootstrap: merge base predates this checker; candidate implementation is used. Review checker introduction.\n",
      );
    try {
      const result = spawnSync("node", [script, mergeBase], { stdio: "inherit", timeout: 120000 });
      if (result.error) throw result.error;
      return result.status ?? 1;
    } finally {
      if (source) rmSync(scratch, { force: true });
    }
  });
