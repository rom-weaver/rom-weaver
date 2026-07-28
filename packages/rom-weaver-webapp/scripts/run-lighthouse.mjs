#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const CONFIG_PATH = path.join(PACKAGE_ROOT, "performance-budgets.json");
const REPORT_DIR = path.join(REPO_ROOT, "target", "lighthouse");
const PORT = 4173;
const ORIGIN = `https://localhost:${PORT}`;

export function median(values) {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function aggregate(values, method, higherIsBetter) {
  if (method === "optimistic") return higherIsBetter ? Math.max(...values) : Math.min(...values);
  return median(values);
}

export function evaluateThreshold(value, threshold, higherIsBetter) {
  if (higherIsBetter) {
    if (value < threshold.minimum) return "error";
    if (value < threshold.expected) return "warning";
  } else {
    if (value > threshold.maximum) return "error";
    if (value > threshold.expected) return "warning";
  }
  return "pass";
}

const waitForServer = () =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const attempt = () => {
      const request = https.get(ORIGIN, { rejectUnauthorized: false }, (response) => {
        response.resume();
        if ((response.statusCode || 500) < 500) resolve();
        else retry();
      });
      request.on("error", retry);
      request.setTimeout(1000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() >= deadline) reject(new Error("preview server did not become ready within 15 seconds"));
      else setTimeout(attempt, 100);
    };
    attempt();
  });

const startPreviewServer = async () => {
  const server = spawn(process.execPath, ["scripts/dev-server.mjs", "preview", "--port", String(PORT)], {
    cwd: PACKAGE_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk;
  });
  server.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((_, reject) => {
    server.once("exit", (code) => reject(new Error(`preview server exited with ${code}\n${output}`)));
  });
  await Promise.race([waitForServer(), exited]);
  return server;
};

const stopPreviewServer = (server) =>
  new Promise((resolve) => {
    if (server.exitCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    server.kill("SIGTERM");
  });

const verifyProductionBuild = () => {
  const verify = spawnSync(process.execPath, ["scripts/verify-seo-build.mjs"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { ...process.env, ROM_WEAVER_CHANNEL: "prod" },
  });
  if (verify.status !== 0)
    throw new Error(`Lighthouse requires an indexable production build\n${verify.stdout || ""}${verify.stderr || ""}`);
};

export const lighthouseArguments = (url, outputBase, ignoreNoIndex = false) => [
  url,
  "--quiet",
  "--output=json",
  "--output=html",
  `--output-path=${outputBase}`,
  "--only-categories=performance,accessibility,best-practices,seo",
  ...(ignoreNoIndex ? ["--skip-audits=is-crawlable"] : []),
  "--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage --ignore-certificate-errors",
];

const runAudit = (url, outputBase, ignoreNoIndex) => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("lighthouse/cli/index.js")),
      ...lighthouseArguments(url, outputBase, ignoreNoIndex),
    ],
    { cwd: PACKAGE_ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(`Lighthouse failed for ${url}\n${result.stdout || ""}${result.stderr || ""}`);
  return JSON.parse(fs.readFileSync(`${outputBase}.report.json`, "utf8"));
};

const formatValue = (value, unit = "") => (unit === "ms" ? `${Math.round(value)} ms` : `${value.toFixed(3)}${unit}`);

const annotate = (severity, label, value, threshold, higherIsBetter) => {
  if (severity === "pass") return;
  const boundary = higherIsBetter
    ? `${severity === "error" ? "minimum" : "expected"} ${threshold[severity === "error" ? "minimum" : "expected"]}`
    : `${severity === "error" ? "maximum" : "expected"} ${threshold[severity === "error" ? "maximum" : "expected"]}`;
  process.stdout.write(`::${severity} title=Lighthouse budget::${label} was ${value} (${boundary})\n`);
};

const evaluateReports = (route, reports, config) => {
  const rows = [];
  let failures = 0;
  for (const [id, threshold] of Object.entries(config.scores)) {
    const value = aggregate(
      reports.map((report) => report.categories[id].score),
      threshold.aggregation,
      true,
    );
    const severity = evaluateThreshold(value, threshold, true);
    const formatted = value.toFixed(2);
    rows.push({ label: `${route.name} ${id}`, severity, value: formatted });
    annotate(severity, `${route.name} ${id}`, formatted, threshold, true);
    if (severity === "error") failures += 1;
  }
  for (const [id, threshold] of Object.entries(config.metrics)) {
    const value = aggregate(
      reports.map((report) => report.audits[id].numericValue),
      threshold.aggregation,
      false,
    );
    const severity = evaluateThreshold(value, threshold, false);
    const formatted = formatValue(value, threshold.unit);
    rows.push({ label: `${route.name} ${id}`, severity, value: formatted });
    annotate(severity, `${route.name} ${id}`, formatted, threshold, false);
    if (severity === "error") failures += 1;
  }
  return { failures, rows };
};

const summary = (rows) =>
  [
    "### Lighthouse budgets",
    "",
    "| Audit | Value | Result |",
    "| --- | ---: | --- |",
    ...rows.map(({ label, severity, value }) => `| ${label} | ${value} | ${severity} |`),
    "",
  ].join("\n");

export const reportIndex = (rows, routes, runs) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Lighthouse reports</title>
  <style>
    body { font: 16px system-ui, sans-serif; max-width: 72rem; margin: 2rem auto; padding: 0 1rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #ccc; padding: .5rem; text-align: left; }
    .error { color: #b42318; } .warning { color: #b54708; } .pass { color: #067647; }
  </style>
</head>
<body>
  <h1>Lighthouse reports</h1>
  <table>
    <thead><tr><th>Audit</th><th>Value</th><th>Result</th></tr></thead>
    <tbody>${rows.map(({ label, severity, value }) => `<tr><td>${label}</td><td>${value}</td><td class="${severity}">${severity}</td></tr>`).join("")}</tbody>
  </table>
  <h2>Detailed runs</h2>
  <ul>${routes.flatMap((route) => Array.from({ length: runs }, (_, index) => `<li><a href="${route.name.toLowerCase()}-${index + 1}.report.html">${route.name} run ${index + 1}</a></li>`)).join("")}</ul>
</body>
</html>
`;

export async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).lighthouse;
  const remoteOrigin = String(process.env.LIGHTHOUSE_BASE_URL || "").replace(/\/$/, "");
  const auditOrigin = remoteOrigin || ORIGIN;
  const ignoreNoIndex = process.env.LIGHTHOUSE_IGNORE_NOINDEX === "true";
  fs.rmSync(REPORT_DIR, { force: true, recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  let server;
  const rows = [];
  let failures = 0;
  try {
    if (!remoteOrigin) {
      verifyProductionBuild();
      server = await startPreviewServer();
    }
    for (const route of config.routes) {
      const reports = [];
      for (let run = 1; run <= config.runs; run += 1) {
        process.stdout.write(`Lighthouse ${route.name} run ${run}/${config.runs}\n`);
        const outputBase = path.join(REPORT_DIR, `${route.name.toLowerCase()}-${run}`);
        reports.push(runAudit(`${auditOrigin}${route.path}`, outputBase, ignoreNoIndex));
      }
      const result = evaluateReports(route, reports, config);
      rows.push(...result.rows);
      failures += result.failures;
    }
  } finally {
    if (server) await stopPreviewServer(server);
  }
  for (const row of rows) process.stdout.write(`${row.severity.toUpperCase().padEnd(7)} ${row.label}: ${row.value}\n`);
  fs.writeFileSync(path.join(REPORT_DIR, "index.html"), reportIndex(rows, config.routes, config.runs));
  fs.writeFileSync(path.join(REPORT_DIR, "_headers"), "/*\n  X-Robots-Tag: noindex, nofollow\n");
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(rows));
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then((code) => {
    process.exitCode = code;
  });
