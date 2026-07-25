#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

export function assertJobs(changesResult, selected, dependencies) {
  const output = [];
  let failed = false;

  if (changesResult !== "success") {
    output.push(`::error::changes job reported '${changesResult}'; cannot trust the selection`);
    failed = true;
  }

  for (const pair of dependencies) {
    const separator = pair.indexOf("=");
    const job = separator < 0 ? pair : pair.slice(0, separator);
    const result = separator < 0 ? "" : pair.slice(separator + 1);
    if (result === "success") continue;
    if (result === "skipped" && selected !== "true") {
      output.push(`${job}: skipped (group not selected for this change)`);
      continue;
    }
    output.push(`::error::${job} reported '${result}' (group selected: ${selected || "unset"})`);
    failed = true;
  }

  return { failed, output };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length < 3) {
    process.stderr.write("usage: node scripts/ci/assert-jobs.mjs <changes-result> <selected> <job>=<result>...\n");
    return 2;
  }
  const result = assertJobs(argv[0], argv[1], argv.slice(2));
  process.stdout.write(`${result.output.join("\n")}${result.output.length ? "\n" : ""}`);
  return result.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
