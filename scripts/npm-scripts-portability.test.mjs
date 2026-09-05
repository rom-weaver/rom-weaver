import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFESTS = ["package.json", "packages/rom-weaver-webapp/package.json"];

// npm runs a script through cmd.exe on Windows unless `script-shell` says
// otherwise, and cmd.exe has no `NAME=value command` form: it reports the
// assignment as an unknown command. `cross-env` sets the variable portably, so
// a script that exports one MUST go through it.
const LEADING_ASSIGNMENTS = /^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/u;

const scriptsOf = (manifest) =>
  Object.entries(JSON.parse(readFileSync(join(ROOT, manifest), "utf8")).scripts ?? {});

test("no npm script sets an environment variable without cross-env", () => {
  const offenders = [];
  for (const manifest of MANIFESTS) {
    for (const [name, command] of scriptsOf(manifest)) {
      if (LEADING_ASSIGNMENTS.test(command.trim())) offenders.push(`${manifest} → ${name}: ${command}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `prefix these with \`cross-env\` so they run on Windows:\n${offenders.join("\n")}`,
  );
});

test("every cross-env script actually assigns a variable", () => {
  // A stray `cross-env` with nothing to set is dead weight; keep the two in step.
  for (const manifest of MANIFESTS) {
    for (const [name, command] of scriptsOf(manifest)) {
      if (!command.includes("cross-env ")) continue;
      const remainder = command.slice(command.indexOf("cross-env ") + "cross-env ".length);
      assert.ok(
        LEADING_ASSIGNMENTS.test(remainder),
        `${manifest} → ${name} calls cross-env without setting a variable: ${command}`,
      );
    }
  }
});

test("cross-env is declared where the scripts that use it live", () => {
  for (const manifest of MANIFESTS) {
    const pkg = JSON.parse(readFileSync(join(ROOT, manifest), "utf8"));
    const uses = Object.values(pkg.scripts ?? {}).some((command) => command.includes("cross-env "));
    if (!uses) continue;
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    assert.ok(declared["cross-env"], `${manifest} uses cross-env but does not declare it`);
  }
});
