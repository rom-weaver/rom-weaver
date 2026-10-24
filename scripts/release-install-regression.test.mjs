import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
const release = readFileSync(process.env.RELEASE_FILE || ".github/workflows/release.yml", "utf8");
for (const name of ["publish-npm", "publish-containers"]) {
  test(`${name} requires successful semver checks`, () => {
    const job = release.split(`  ${name}:\n`)[1].split(/\n  [a-z][a-z-]*:/)[0];
    assert.match(job, /needs:.*semver-check/);
    assert.match(job, /needs\.semver-check\.result == 'success'/);
  });
}
test("baseline lookup only skips 404 and retries failures", () => {
  assert.match(release, /if \[\[ "\$status" = 404 \]\]/);
  assert.match(release, /--retry 3/);
  assert.match(release, /baseline lookup failed/);
});
test("PowerShell verifies docs outside download catch before extraction", () => {
  const source = readFileSync("install.ps1", "utf8");
  assert.match(source, /if \(\$docsPath\) \{\s+Confirm-Provenance "\$docsPath" \$docsAsset/);
  assert.ok(
    source.indexOf('Confirm-Provenance "$docsPath" $docsAsset') <
      source.indexOf("Expand-Archive -LiteralPath $docsPath"),
  );
});

test("baseline lookup fails unresolved errors and only skips missing crates", () => {
  const scratch = resolve(".agent/release-install");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "baseline-"));
  const write = (name, body) => {
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  try {
    write("cargo", 'if [ "$1" = metadata ]; then echo "{}"; else echo checked; fi');
    write("jq", "echo published");
    write("curl", 'printf "%s" "$STATUS"; exit "$CURL_EXIT"');
    const script = release
      .split("      - name: Check for accidental breaking API changes")[1]
      .split("        run: |\n")[1]
      .split("        env:")[0]
      .replace(/^          /gm, "");
    for (const [status, code, success] of [
      ["200", "0", true],
      ["404", "22", true],
      ["500", "22", false],
      ["429", "22", false],
      ["000", "6", false],
      ["200", "18", false],
    ]) {
      const result = spawnSync("bash", ["-eu", "-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:/usr/bin:/bin`,
          STATUS: status,
          CURL_EXIT: code,
          CRATES_IO_USER_AGENT: "test",
        },
      });
      assert.equal(result.status === 0, success, `${status}: ${result.stdout} ${result.stderr}`);
      assert.equal(result.stdout.includes("checked"), status === "200" && code === "0");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
