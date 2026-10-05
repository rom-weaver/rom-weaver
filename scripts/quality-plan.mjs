#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runMain } from "./run-main.mjs";
export function qualityPlan(paths, broad = false) {
  const shared = paths.some((path) =>
    /^(?:Cargo\.(?:toml|lock)|\.cargo\/|\.config\/|\.github\/workflows\/(?:ci|quality-deep)\.yml|scripts\/quality-)/.test(
      path,
    ),
  );
  const signals = [];
  if (
    broad ||
    shared ||
    paths.some((path) => /^crates\/rom-weaver-(?:core|checksum|patches)\//.test(path))
  )
    signals.push("mutation");
  if (broad || shared || paths.some((path) => /^(?:crates\/|fuzz\/)/.test(path)))
    signals.push("fuzz");
  if (
    broad ||
    shared ||
    paths.some((path) =>
      /^(?:crates\/rom-weaver-(?:core|containers|cli)\/|tests\/fixtures\/quality-reference\/)/.test(
        path,
      ),
    )
  )
    signals.push("reference");
  return signals;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runMain(() => {
    const base = process.argv[2];
    let paths = [];
    if (base) {
      const mergeBase = execFileSync("git", ["merge-base", base, "HEAD"], {
        encoding: "utf8",
      }).trim();
      paths = execFileSync("git", ["diff", "--name-only", "--no-ext-diff", mergeBase], {
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean);
    }
    const matrix = qualityPlan(paths, !base).map((signal) => ({ signal }));
    process.stdout.write(`${JSON.stringify({ base: base || "broad", paths, matrix }, null, 2)}\n`);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `matrix=${JSON.stringify(matrix.filter((entry) => entry.signal !== "reference"))}\nreference=${matrix.some((entry) => entry.signal === "reference")}\n`,
      );
  });
