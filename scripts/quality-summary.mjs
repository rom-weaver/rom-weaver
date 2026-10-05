#!/usr/bin/env node
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runMain } from "./run-main.mjs";
export function renderSignals(signals, details = {}) {
  const rows = Object.entries(signals).map(([name, outcome]) => {
    if (!["success", "failure", "cancelled", "skipped", "not-run"].includes(outcome))
      throw new Error(`Unknown outcome for ${name}: ${outcome}`);
    const meaning = {
      success: "completed successfully",
      failure: "failed — inspect artifact/log",
      cancelled: "incomplete (cancelled)",
      skipped: "not selected/executed",
      "not-run": "not measured in this lane",
    }[outcome];
    return `| ${name} | ${meaning} |`;
  });
  const extra = [];
  if (details.guardrails) {
    const findings = details.guardrails.findings || [];
    extra.push(
      `Verification changes: ${findings.filter((item) => item.severity === "review").length} require review; ${findings.filter((item) => item.severity === "error").length} blocking findings.`,
    );
    for (const finding of findings)
      extra.push(`- ${finding.severity}: ${finding.path}:${finding.line} ${finding.kind}`);
  }
  if (details.mutation) {
    const mutation = details.mutation;
    extra.push(
      `Mutation outcomes: ${mutation.caught} caught; ${mutation.surviving} surviving; ${mutation.timeouts} timeouts; ${mutation.buildFailures} build failures; ${mutation.baselineFailures} baseline failures.`,
    );
    for (const item of (mutation.survivors || []).slice(0, 20))
      extra.push(`- ${item.outcome}: ${item.mutant.name || JSON.stringify(item.mutant)}`);
    if ((mutation.survivors || []).length > 20)
      extra.push("Additional locations are in the mutation summary artifact.");
    extra.push(`Exclusions: ${JSON.stringify(mutation.exclusions)}`);
  }
  if (details.coverage) {
    const coverage = details.coverage;
    extra.push(
      `Changed coverage: ${coverage.covered.length} covered; ${coverage.uncovered.length} zero-hit; ${coverage.notMeasured.length} not measured.`,
    );
    extra.push(
      `Changed branches: ${coverage.branches.covered.length} covered; ${coverage.branches.uncovered.length} zero-hit; ${coverage.branches.unknown.length} unknown; records available=${coverage.branches.recordsAvailable}.`,
    );
    for (const location of coverage.uncovered.slice(0, 20))
      extra.push(`- Uncovered changed line: ${location}`);
  }
  if (details.selection) {
    for (const suite of details.selection.suites)
      extra.push(
        `Rust ${suite.name}: ${suite.targets} targets executed; ${suite.passed} passed; ${suite.ignored} ignored; ${suite.filtered} filtered; ${suite.failed} failed.`,
      );
    extra.push(`Doctests instrumented=${details.selection.doctests.instrumented}.`);
  }
  for (const result of details.fuzz || [])
    extra.push(
      `Fuzz ${result.target}: exit=${result.status}; seed=${result.seed}; seconds=${result.seconds}; error=${result.error ?? "none"}.`,
    );
  for (const result of details.reference || [])
    extra.push(
      `Pinned reference ${result.archiveFormat || result.format}: ${result.status}; ${result.referenceTool}; ${result.archiveSha256 ? `archive SHA256=${result.archiveSha256}` : `compressed payload SHA256=${JSON.stringify(result.compressedPayloadSha256)}`}.`,
    );
  for (const [name, result] of Object.entries(details.runtime || {})) {
    extra.push(
      `Runtime ${name}: ${result.numPassedTests} passed; ${result.numFailedTests} failed; ${result.numPendingTests} skipped.`,
    );
    for (const suite of result.testResults)
      for (const assertion of suite.assertionResults || [])
        if (assertion.status === "failed")
          extra.push(
            `- Runtime invariant failure: ${assertion.fullName}: ${(assertion.failureMessages || []).join(" ")}`,
          );
  }
  return [
    "## Quality signals",
    "",
    "| Signal | Evidence |",
    "| --- | --- |",
    ...rows,
    "",
    ...extra,
    "",
    "These signals are separate evidence; no composite score is calculated.",
    "",
  ].join("\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runMain(() => {
    const signals = {};
    for (const arg of process.argv.slice(2)) {
      const separator = arg.indexOf("=");
      if (separator < 1) throw new Error("Usage: quality-summary.mjs signal=outcome ...");
      signals[arg.slice(0, separator)] = arg.slice(separator + 1);
    }
    if (!Object.keys(signals).length) throw new Error("No quality signals supplied");
    const file = ".agent/quality-signals/guardrails.json";
    const details = existsSync(file) ? { guardrails: JSON.parse(readFileSync(file, "utf8")) } : {};
    const mutation = ".agent/quality-mutation/summary.json";
    if (existsSync(mutation)) details.mutation = JSON.parse(readFileSync(mutation, "utf8"));
    const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);
    details.coverage = read("dist/coverage/changed-lines.json");
    details.selection = read("dist/coverage/rust/selection.json");
    details.reference = read(".agent/quality-signals/reference.json");
    details.fuzz = ["ips_apply", "save_parse", "disc_sheet", "bundle_parse", "dcp_zip", "iso9660"]
      .map((target) => read(`.agent/quality-fuzz/${target}.json`))
      .filter(Boolean);
    details.runtime = Object.fromEntries(
      ["unit", "browser"]
        .map((name) => [name, read(`.agent/quality-signals/runtime-${name}.json`)])
        .filter(([, result]) => result),
    );
    const summary = renderSignals(signals, details);
    process.stdout.write(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  });
