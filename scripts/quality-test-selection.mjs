#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { coverageSelections } from "./coverage-rust.mjs";
import { runMain } from "./run-main.mjs";

export function checkSelection(metadata, selections, ordinaryTask) {
  const errors = [];
  const members = new Set(metadata.workspace_members);
  for (const pkg of metadata.packages.filter((pkg) => members.has(pkg.id))) {
    for (const target of pkg.targets.filter(
      (target) => target.test && (target["required-features"] || []).length,
    )) {
      const selected = selections.some(({ args }) => {
        const featureIndex = args.indexOf("--features");
        const features = featureIndex < 0 ? [] : args[featureIndex + 1].split(",");
        return (
          args[args.indexOf("-p") + 1] === pkg.name &&
          args.includes(target.name) &&
          target["required-features"].every((feature) => features.includes(feature))
        );
      });
      if (!selected)
        errors.push(
          `${pkg.name}/${target.name}: feature-gated test target absent from coverage selection`,
        );
      if (!ordinaryTask.includes(`--example ${target.name}`))
        errors.push(`${pkg.name}/${target.name}: absent from ordinary test task`);
    }
  }
  return errors;
}
export function checkBrowserSelection(config, suite, files) {
  const expected = {
    unit: "tests/unit/**/*.test.{ts,tsx}",
    ui: "tests/browser/**/*.browser.test.js",
    wasm: "tests/wasm/*.test.mjs",
  }[suite];
  if (!config.includes(`include: ["${expected}"]`))
    return [`${suite}: suite selection changed; update selection audit deliberately`];
  if (!files.length) return [`${suite}: no matching test files`];
  if (!config.includes("coverage:")) return [`${suite}: missing coverage configuration`];
  return [];
}
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`],
  );
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runMain(() => {
    const metadata = JSON.parse(
      execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version=1"], {
        encoding: "utf8",
      }),
    );
    const task =
      readFileSync(".config/mise.toml", "utf8")
        .split("[tasks.test-rust]")[1]
        ?.split("[tasks.coverage-rust]")[0] || "";
    const errors = checkSelection(metadata, coverageSelections, task);
    const root = "packages/rom-weaver-webapp";
    const suites = [
      ["unit", "vitest.unit.config.mjs", "tests/unit", /\.test\.(?:ts|tsx)$/],
      ["ui", "vitest.browser.config.mjs", "tests/browser", /\.browser\.test\.js$/],
      ["wasm", "vitest.wasm.browser.config.mjs", "tests/wasm", /\.test\.mjs$/],
    ];
    for (const [suite, config, directory, pattern] of suites) {
      const files = walk(resolve(root, directory)).filter((file) => pattern.test(file));
      errors.push(
        ...checkBrowserSelection(readFileSync(`${root}/${config}`, "utf8"), suite, files),
      );
      process.stdout.write(
        `${suite}: ${files.length} discovered test files; static selection validated (execution is recorded by its runner)\n`,
      );
    }
    if (errors.length) throw new Error(errors.join("\n"));
    process.stdout.write(
      "Feature-gated Rust test selections agree with ordinary and coverage tasks.\n",
    );
  });
