import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const writeExecutable = (path, source) => {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
};

test("installs the checksummed binary for the host platform", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-"));
  try {
    const bin = join(directory, "bin");
    const installDirectory = join(directory, "install");
    const curlLog = join(directory, "curl.log");
    mkdirSync(bin);
    writeExecutable(
      join(bin, "uname"),
      `#!/bin/sh
case "$1" in
  -s) echo Darwin ;;
  -m) echo arm64 ;;
esac
`,
    );
    writeExecutable(
      join(bin, "curl"),
      `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    *) url=$1; shift ;;
  esac
done
echo "$url" >> "$CURL_LOG"
case "$url" in
  *.sha256) echo "${"a".repeat(64)}  rom-weaver-darwin-arm64" > "$output" ;;
  *) echo binary > "$output" ;;
esac
`,
    );
    writeExecutable(join(bin, "sha256sum"), "#!/bin/sh\nexit 0\n");

    const output = execFileSync("/bin/sh", [resolve("install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        CURL_LOG: curlLog,
        HOME: directory,
        PATH: `${bin}:/usr/bin:/bin`,
        ROM_WEAVER_INSTALL_DIR: installDirectory,
        SHELL: "/bin/zsh",
      },
    });

    assert.equal(readFileSync(join(installDirectory, "rom-weaver"), "utf8"), "binary\n");
    assert.ok(output.includes(`Installed rom-weaver to ${installDirectory}/rom-weaver`));
    assert.ok(
      output.includes(
        `echo 'export PATH="${installDirectory}:$PATH"' >> "${directory}/.zshrc"`,
      ),
    );
    assert.ok(output.includes(`source "${directory}/.zshrc"`));
    assert.ok(output.includes("Then run: rom-weaver --help"));
    assert.deepEqual(readFileSync(curlLog, "utf8").trim().split("\n"), [
      "https://github.com/rom-weaver/rom-weaver/releases/latest/download/rom-weaver-darwin-arm64",
      "https://github.com/rom-weaver/rom-weaver/releases/latest/download/rom-weaver-darwin-arm64.sha256",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selects Linux musl assets by architecture", () => {
  for (const [machine, platform] of [
    ["aarch64", "linux-arm64-musl"],
    ["i686", "linux-ia32-musl"],
    ["x86_64", "linux-x64-musl"],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-linux-"));
    try {
      const bin = join(directory, "bin");
      const curlLog = join(directory, "curl.log");
      mkdirSync(bin);
      writeExecutable(
        join(bin, "uname"),
        `#!/bin/sh
case "$1" in
  -s) echo Linux ;;
  -m) echo ${machine} ;;
esac
`,
      );
      writeExecutable(join(bin, "getconf"), "#!/bin/sh\nexit 1\n");
      writeExecutable(join(bin, "ldd"), "#!/bin/sh\necho 'musl libc' >&2\n");
      writeExecutable(
        join(bin, "curl"),
        `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    *) url=$1; shift ;;
  esac
done
echo "$url" >> "$CURL_LOG"
case "$url" in
  *.sha256) echo "${"a".repeat(64)}  rom-weaver-${platform}" > "$output" ;;
  *) echo binary > "$output" ;;
esac
`,
      );
      writeExecutable(join(bin, "sha256sum"), "#!/bin/sh\nexit 0\n");

      execFileSync("/bin/sh", [resolve("install.sh")], {
        env: {
          ...process.env,
          CURL_LOG: curlLog,
          HOME: directory,
          PATH: `${bin}:/usr/bin:/bin`,
          ROM_WEAVER_INSTALL_DIR: join(directory, "install"),
        },
      });

      assert.equal(
        readFileSync(curlLog, "utf8").trim().split("\n")[0],
        `https://github.com/rom-weaver/rom-weaver/releases/latest/download/rom-weaver-${platform}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
