#!/usr/bin/env node
import { createRequire } from "node:module";
import process from "node:process";
import browserslist from "browserslist";

const require = createRequire(import.meta.url);
const bcd = require("@mdn/browser-compat-data");

const BROWSER_KEY_BY_BROWSERSLIST_NAME = {
  and_chr: "chrome_android",
  chrome: "chrome",
  edge: "edge",
  firefox: "firefox",
  ios_saf: "safari_ios",
  safari: "safari",
};

const REQUIRED_FEATURES = [
  { label: "Atomics.waitAsync", path: "javascript.builtins.Atomics.waitAsync" },
  { label: "Blob.arrayBuffer", path: "api.Blob.arrayBuffer" },
  { label: "BroadcastChannel", path: "api.BroadcastChannel" },
  { label: "File", path: "api.File" },
  { label: "FileList", path: "api.FileList" },
  { label: "FileSystemDirectoryHandle", path: "api.FileSystemDirectoryHandle" },
  { label: "FileSystemFileHandle", path: "api.FileSystemFileHandle" },
  { label: "OPFS getDirectory", path: "api.StorageManager.getDirectory" },
  { label: "SharedArrayBuffer", path: "javascript.builtins.SharedArrayBuffer" },
  { label: "Worker", path: "api.Worker" },
  { label: "structuredClone", path: "api.structuredClone" },
  { label: "WebAssembly API", path: "webassembly.api" },
  { label: "Wasm bulk memory", path: "webassembly.bulk-memory-operations" },
  { label: "Wasm reference types", path: "webassembly.reference-types" },
  { label: "Wasm sign extension", path: "webassembly.sign-extension-operations" },
  { label: "Wasm SIMD", path: "webassembly.fixed-width-SIMD" },
  { label: "Wasm threads and atomics", path: "webassembly.threads-and-atomics" },
];

const getCompatNode = (path) => path.split(".").reduce((value, key) => value?.[key], bcd);

const parseTarget = (target) => {
  const [name, rawVersion] = String(target || "").split(/\s+/, 2);
  const version = String(rawVersion || "")
    .split("-")[0]
    .trim();
  if (!(name && version)) throw new Error(`Invalid Browserslist target: ${target}`);
  return { bcdBrowser: BROWSER_KEY_BY_BROWSERSLIST_NAME[name], name, raw: target, version };
};

const versionParts = (value) =>
  String(value || "")
    .replace(/^≤\s*/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));

const compareVersions = (left, right) => {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const isStatementSupported = (statement, targetVersion) => {
  if (!statement || statement.flags || statement.prefix || statement.alternative_name) return false;
  if (
    statement.version_removed &&
    typeof statement.version_removed === "string" &&
    compareVersions(targetVersion, statement.version_removed) >= 0
  )
    return false;
  if (statement.version_added === true) return true;
  return typeof statement.version_added === "string" && compareVersions(targetVersion, statement.version_added) >= 0;
};

const isFeatureSupported = (feature, target) => {
  const support = getCompatNode(feature.path)?.__compat?.support?.[target.bcdBrowser];
  const statements = Array.isArray(support) ? support : [support];
  return statements.some((statement) => isStatementSupported(statement, target.version));
};

const targets = browserslist(undefined, { path: process.cwd() }).map(parseTarget);
const unsupportedTargets = targets.filter((target) => !target.bcdBrowser);
if (unsupportedTargets.length) {
  console.error(
    `Unsupported browser target(s) for this compatibility audit: ${unsupportedTargets
      .map((target) => target.raw)
      .join(", ")}`,
  );
  process.exit(1);
}

const targetNames = new Set(targets.map((target) => target.name));
for (const requiredTargetName of ["safari", "ios_saf"]) {
  if (!targetNames.has(requiredTargetName)) {
    console.error(`Browserslist must include ${requiredTargetName} for Safari compatibility coverage.`);
    process.exit(1);
  }
}

const failures = [];
for (const feature of REQUIRED_FEATURES) {
  const node = getCompatNode(feature.path);
  if (!node?.__compat?.support) {
    failures.push(`${feature.label}: missing MDN browser compatibility data at ${feature.path}`);
    continue;
  }
  for (const target of targets) {
    if (!isFeatureSupported(feature, target)) failures.push(`${feature.label}: unsupported by ${target.raw}`);
  }
}

if (failures.length) {
  console.error("Browser compatibility audit failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Browser compatibility audit passed for ${targets.length} target(s): ${targets
    .map((target) => target.raw)
    .join(", ")}`,
);
