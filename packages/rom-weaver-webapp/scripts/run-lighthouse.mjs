#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const CONFIG_PATH = path.join(PACKAGE_ROOT, "performance-budgets.json");
const REPORT_DIR = path.join(REPO_ROOT, "target", "lighthouse");

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

// A fixed port collides with a preview server the developer already has up and
// with a second worktree auditing in parallel; PORT stays honoured so a run can
// be pinned when something else has to reach it.
const findFreePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const resolvePort = () => {
  const configured = Number.parseInt(process.env.PORT || "", 10);
  return Number.isFinite(configured) ? Promise.resolve(configured) : findFreePort();
};

const waitForServer = (origin) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const attempt = () => {
      const request = https.get(origin, { rejectUnauthorized: false }, (response) => {
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

const startPreviewServer = async (port, origin) => {
  const server = spawn(process.execPath, ["scripts/dev-server.mjs", "preview", "--port", String(port)], {
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
  try {
    await Promise.race([waitForServer(origin), exited]);
  } catch (error) {
    // A readiness timeout leaves a spawned server nobody owns, holding the port
    // against the next attempt.
    await stopPreviewServer(server);
    throw error;
  }
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
  const identify = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "ensure-identify-data.mjs")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (identify.status !== 0) throw new Error("failed to prepare ROM identify data");
  const verify = spawnSync(process.execPath, ["scripts/verify-seo-build.mjs"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { ...process.env, ROM_WEAVER_CHANNEL: "prod" },
  });
  if (verify.status !== 0)
    throw new Error(`Lighthouse requires an indexable production build\n${verify.stdout || ""}${verify.stderr || ""}`);
};

export const lighthouseArguments = (url, outputBase) => [
  url,
  "--quiet",
  "--output=json",
  "--output=html",
  `--output-path=${outputBase}`,
  "--only-categories=performance,accessibility,best-practices,seo",
  "--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage --ignore-certificate-errors",
];

export const LIGHTHOUSE_ATTEMPTS = 3;

export const shouldRetryLighthouse = (attempt, report) => attempt === 1 && Boolean(report?.runtimeError);

export const shouldRetryLighthouseAttempt = (attempt, report) =>
  attempt < LIGHTHOUSE_ATTEMPTS && report?.runtimeError?.code === "NO_NAVSTART";

const clearReports = (outputBase) => {
  for (const extension of ["json", "html"]) fs.rmSync(`${outputBase}.report.${extension}`, { force: true });
};

const runAudit = (url, outputBase) => {
  for (let attempt = 1; attempt <= LIGHTHOUSE_ATTEMPTS; attempt += 1) {
    clearReports(outputBase);
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.resolve("lighthouse/cli/index.js")), ...lighthouseArguments(url, outputBase)],
      { cwd: PACKAGE_ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const reportPath = `${outputBase}.report.json`;
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : undefined;
    if (shouldRetryLighthouseAttempt(attempt, report)) {
      process.stdout.write(
        `::warning title=Lighthouse retry::${url} hit ${report.runtimeError.code}; retrying (attempt ${attempt + 1}/${LIGHTHOUSE_ATTEMPTS})\n`,
      );
      continue;
    }
    if (result.status !== 0)
      throw new Error(`Lighthouse failed for ${url}\n${result.stdout || ""}${result.stderr || ""}`);
    if (!report) throw new Error(`Lighthouse produced no report for ${url}`);
    return report;
  }
};

const formatValue = (value, unit = "") => (unit === "ms" ? `${Math.round(value)} ms` : `${value.toFixed(3)}${unit}`);

const annotate = (severity, label, value, threshold, higherIsBetter) => {
  if (severity === "pass") return;
  const boundary = higherIsBetter
    ? `${severity === "error" ? "minimum" : "expected"} ${threshold[severity === "error" ? "minimum" : "expected"]}`
    : `${severity === "error" ? "maximum" : "expected"} ${threshold[severity === "error" ? "maximum" : "expected"]}`;
  process.stdout.write(`::${severity} title=Lighthouse budget::${label} was ${value} (${boundary})\n`);
};

export const evaluateReports = (route, reports, config) => {
  const rows = [];
  let failures = 0;

  // An audit that errors, or a category Lighthouse could not score, yields
  // undefined/null. Comparing that against a threshold is always false, so
  // without this it would read as a pass and a metric that stopped being
  // collected would silently stop being budgeted.
  const record = (id, values, threshold, higherIsBetter, format) => {
    const label = `${route.name} ${id}`;
    if (values.some((value) => !Number.isFinite(value))) {
      rows.push({ label, severity: "error", value: "unavailable" });
      process.stdout.write(`::error title=Lighthouse budget::${label} produced no value\n`);
      return 1;
    }
    const value = aggregate(values, threshold.aggregation, higherIsBetter);
    const severity = evaluateThreshold(value, threshold, higherIsBetter);
    const formatted = format(value);
    rows.push({ label, severity, value: formatted });
    annotate(severity, label, formatted, threshold, higherIsBetter);
    return severity === "error" ? 1 : 0;
  };

  for (const [id, threshold] of Object.entries(config.scores)) {
    failures += record(
      id,
      reports.map((report) => report.categories[id]?.score),
      threshold,
      true,
      (value) => value.toFixed(2),
    );
  }
  for (const [id, threshold] of Object.entries(config.metrics)) {
    failures += record(
      id,
      reports.map((report) => report.audits[id]?.numericValue),
      threshold,
      false,
      (value) => formatValue(value, threshold.unit),
    );
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
  fs.rmSync(REPORT_DIR, { force: true, recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  // Ahead of the first audit, not after the last: CI publishes whatever landed
  // here, and a run that dies partway through must not put reports on a public
  // URL without the header that keeps them out of search results.
  fs.writeFileSync(path.join(REPORT_DIR, "_headers"), "/*\n  X-Robots-Tag: noindex, nofollow\n");

  verifyProductionBuild();
  const port = await resolvePort();
  const origin = `https://localhost:${port}`;
  const server = await startPreviewServer(port, origin);
  const rows = [];
  let failures = 0;
  try {
    for (const route of config.routes) {
      const reports = [];
      for (let run = 1; run <= config.runs; run += 1) {
        process.stdout.write(`Lighthouse ${route.name} run ${run}/${config.runs}\n`);
        const outputBase = path.join(REPORT_DIR, `${route.name.toLowerCase()}-${run}`);
        reports.push(runAudit(`${origin}${route.path}`, outputBase));
      }
      const result = evaluateReports(route, reports, config);
      rows.push(...result.rows);
      failures += result.failures;
    }
  } finally {
    await stopPreviewServer(server);
    fs.writeFileSync(path.join(REPORT_DIR, "index.html"), reportIndex(rows, config.routes, config.runs));
  }
  for (const row of rows) process.stdout.write(`${row.severity.toUpperCase().padEnd(7)} ${row.label}: ${row.value}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(rows));
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
