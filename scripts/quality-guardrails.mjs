import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(resolve(process.cwd(), "packages/rom-weaver-webapp/package.json"));
const { parseSync } = require("oxc-parser");

export function syntaxSignals(path, source) {
  const signals = [];
  const add = (kind, line, detail) => signals.push({ kind, line, detail });
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    const parsed = parseSync(path, source);
    if (parsed.errors.length)
      throw new Error(`Cannot analyze ${path}: ${parsed.errors[0].message}`);
    const tree = parsed.program;
    const testNames = new Set([
      "test",
      "it",
      "describe",
      "suite",
      "fit",
      "fdescribe",
      "xit",
      "xdescribe",
      "xtest",
    ]);
    for (const statement of tree.body) {
      if (
        statement.type === "ImportDeclaration" &&
        /(?:vitest|jest|node:test|playwright)/.test(statement.source.value)
      ) {
        for (const specifier of statement.specifiers) testNames.add(specifier.local.name);
      }
    }
    const testRoot = (node) => {
      if (!node) return false;
      if (node.type === "Identifier") return testNames.has(node.name);
      if (node.type === "MemberExpression") return testRoot(node.object);
      if (node.type === "CallExpression") return testRoot(node.callee);
      return false;
    };
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "MemberExpression") {
        const member = node.computed ? node.property.value : node.property.name;
        const line = source.slice(0, node.start).split("\n").length;
        if (member === "only" && testRoot(node.object))
          add("focus", line, source.slice(node.start, node.end));
        if (["skip", "todo", "skipIf"].includes(member) && testRoot(node.object))
          add("suppression", line, source.slice(node.start, node.end));
      }
      if (node.type === "CallExpression") {
        const expression = node.callee;
        const text = source.slice(expression.start, expression.end);
        const line = source.slice(0, node.start).split("\n").length;
        if (testRoot(expression)) {
          if (
            expression.type === "MemberExpression" &&
            expression.property.name === "runIf" &&
            node.arguments[0]?.value === false
          )
            add("suppression", line, source.slice(node.start, node.end));
          for (const argument of node.arguments.filter((arg) => arg.type === "ObjectExpression")) {
            for (const property of argument.properties) {
              const key = property.key?.name ?? property.key?.value;
              if (["skip", "only", "todo"].includes(key) && property.value?.value === true)
                add(
                  key === "only" ? "focus" : "suppression",
                  line,
                  source.slice(property.start, property.end),
                );
            }
          }
        }
        if (/\b(?:fit|fdescribe)$/.test(text)) add("focus", line, text);
        if (/\b(?:xit|xdescribe|xtest)$/.test(text)) add("suppression", line, text);
        if (/^(?:assert(?:\.|\[)|expect$)/.test(text))
          add("assertion", line, source.slice(node.start, node.end));
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    };
    visit(tree);
  }
  source.split("\n").forEach((line, index) => {
    if (
      /^\s*#\s*\[\s*ignore(?:\s*=.*)?\s*\]/.test(line) ||
      /(?:eslint|oxlint|biome|@ts)-?(?:ignore|disable|expect-error)/.test(line)
    )
      add("suppression", index + 1, line.trim());
    if (/\b(?:assert|assert_eq|assert_ne|debug_assert)(?:_eq|_ne)?!\s*\(/.test(line))
      add("assertion", index + 1, line.trim());
  });
  return signals;
}

function configurationChanges(path, before, after) {
  if (!path.endsWith(".json") || !before || !after) return [];
  let oldValue;
  let newValue;
  try {
    oldValue = JSON.parse(before);
    newValue = JSON.parse(after);
  } catch {
    return [];
  }
  const changes = [];
  const visit = (old, next, keys) => {
    const key = keys.join(".");
    if (
      typeof old === "number" &&
      typeof next === "number" &&
      old !== next &&
      /(?:coverage|threshold|budget|limit|max|min)/i.test(key + path)
    )
      changes.push({
        path,
        severity: "review",
        kind: "numeric-policy-change",
        detail: `${key}: ${old} -> ${next}; inspect whether assurance was reduced.`,
      });
    if (Array.isArray(old) && Array.isArray(next) && /(?:ignore|exclude|skip)/i.test(key)) {
      for (const value of next)
        if (!old.some((prior) => JSON.stringify(prior) === JSON.stringify(value)))
          changes.push({
            path,
            severity: "review",
            kind: "exclusion-added",
            detail: `${key}: ${JSON.stringify(value)}`,
          });
    }
    if (old && next && typeof old === "object" && typeof next === "object")
      for (const child of Object.keys(next)) visit(old[child], next[child], [...keys, child]);
  };
  visit(oldValue, newValue, []);
  return changes;
}

export function inspectChange(path, before, after) {
  const findings = configurationChanges(path, before, after);
  const old = syntaxSignals(path, before);
  const current = syntaxSignals(path, after);
  const hasReason = (source, signal) =>
    /quality-reason:\s*\S.{9,}|#\s*\[\s*ignore\s*=\s*"[^"\n]{10,}"/.test(
      source
        .split("\n")
        .slice(Math.max(0, signal.line - 3), signal.line + 1)
        .join("\n"),
    );
  const remaining = new Map();
  for (const signal of old)
    remaining.set(
      signal.kind + signal.detail,
      (remaining.get(signal.kind + signal.detail) ?? 0) + 1,
    );
  for (const signal of current) {
    const key = signal.kind + signal.detail;
    if (remaining.get(key)) {
      remaining.set(key, remaining.get(key) - 1);
      if (
        signal.kind === "suppression" &&
        !hasReason(after, signal) &&
        old.some((prior) => prior.detail === signal.detail && hasReason(before, prior))
      )
        findings.push({
          path,
          ...signal,
          severity: "error",
          detail: "Suppression justification removed.",
        });
      continue;
    }
    if (signal.kind === "assertion") continue;
    const adjacent = after
      .split("\n")
      .slice(Math.max(0, signal.line - 3), signal.line + 1)
      .join("\n");
    const reason = /quality-reason:\s*\S.{9,}|#\s*\[\s*ignore\s*=\s*"[^"\n]{10,}"/.test(adjacent);
    findings.push({
      path,
      ...signal,
      severity: signal.kind === "focus" || !reason ? "error" : "review",
    });
  }
  if (
    old.filter((s) => s.kind === "assertion").length >
    current.filter((s) => s.kind === "assertion").length
  )
    findings.push({
      path,
      severity: "review",
      kind: "assertions-removed",
      detail: "Assertion count decreased; inspect behavioral coverage.",
    });
  if (
    before !== after &&
    /(?:snapshot|fixture|golden|reference|budget|coverage|mutant|fuzz|quality-guard|quality-architecture|(?:^|\/)\.github\/|(?:^|\/)\.config\/|(?:lint|vitest|playwright|biome|oxlint|tsconfig).*\.(?:jsonc?|[cm]?[jt]s)|package\.json)/i.test(
      path,
    )
  )
    findings.push({
      path,
      severity: "review",
      kind: "verification-change",
      detail:
        "Evaluation configuration, oracle, or checker changed; review exclusions, thresholds, test selection and enforcement.",
    });
  return findings;
}

export function checkDiff(base, cwd = process.cwd()) {
  const git = (args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const paths = git(["diff", "--name-only", "-z", mergeBase, "--"]).split("\0").filter(Boolean);
  const findings = [];
  for (const path of paths) {
    let before = "";
    try {
      before = git(["show", `${mergeBase}:${path}`]);
    } catch {
      /* New files have no baseline. */
    }
    const full = resolve(cwd, path);
    const after = existsSync(full) ? readFileSync(full, "utf8") : "";
    findings.push(...inspectChange(path, before, after));
  }
  return { mergeBase, checkedFiles: paths.length, findings };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  if (!base) throw new Error("Usage: node scripts/quality-guardrails.mjs <base-ref>");
  const result = checkDiff(base);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.findings.some((finding) => finding.severity === "error") ? 1 : 0;
}
