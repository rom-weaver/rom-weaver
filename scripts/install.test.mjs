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

const DIGEST = "b".repeat(64);

// install.sh hashes the download to build the attestation URL, so the stub has
// to answer both call shapes: `--check` against the sidecar, and a plain hash of
// the binary.
const SHA256SUM_STUB = `#!/bin/sh
case "$1" in
  --check) exit 0 ;;
esac
echo "${DIGEST}  $1"
`;

// Serves the release download, its sidecar, and the attestations API. A URL
// listed in FAIL_URLS exits non-zero the way \`curl --fail\` does on a 404.
const curlStub = (platform, attestationJson) => `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
echo "$url" >> "$CURL_LOG"
case "$url" in
  *attestations*)
    case " $FAIL_URLS " in *" attestations "*) exit 22 ;; esac
    cat > "$output" <<'JSON'
${attestationJson}
JSON
    ;;
  *.sha256) echo "${"a".repeat(64)}  rom-weaver-${platform}" > "$output" ;;
  *) echo binary > "$output" ;;
esac
`;

// A verbatim response from `GET /repos/{owner}/{repo}/attestations/{digest}`,
// captured from a real published image and used unmodified except that its
// `bundle_url` - a time-limited signed blob URL install.sh never reads - is
// replaced. Testing against the real bytes is the point: install.sh matches
// fixed strings rather than parsing, so a hand-written response could agree with
// the code while disagreeing with GitHub.
const REAL_RESPONSE = readFileSync(resolve("test/fixtures/attestations-response.json"), "utf8");
const REAL_RESPONSE_REPOSITORY = "https://github.com/rom-weaver/rom-weaver";

// The same response with the attesting repository swapped, which is what an
// attestation covering these bytes but produced by somebody else looks like.
const responseFrom = (repository) => {
  const { attestations } = JSON.parse(REAL_RESPONSE);
  for (const attestation of attestations) {
    const envelope = attestation.bundle.dsseEnvelope;
    const statement = Buffer.from(envelope.payload, "base64").toString("utf8");
    envelope.payload = Buffer.from(statement.replaceAll(REAL_RESPONSE_REPOSITORY, repository)).toString("base64");
  }
  return JSON.stringify({ attestations }, null, 2);
};

// Everything the provenance tests share: a Darwin host and a stubbed download.
// `bin` is returned so a test can add its own `gh`.
const setUpDarwinInstall = (directory, options = {}) => {
  const { attestation = REAL_RESPONSE } = options;
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeExecutable(join(bin, "uname"), '#!/bin/sh\ncase "$1" in\n  -s) echo Darwin ;;\n  -m) echo arm64 ;;\nesac\n');
  writeExecutable(join(bin, "curl"), curlStub("darwin-arm64", attestation));
  writeExecutable(join(bin, "sha256sum"), SHA256SUM_STUB);
  return bin;
};

// stderr is folded into stdout because the provenance branches warn there, and a
// caller asserting on a warning should not have to know which stream it took.
const runInstall = (directory, bin, environment = {}) => {
  const { PATH: extra = "", ...rest } = environment;
  return execFileSync("/bin/sh", ["-c", `/bin/sh "${resolve("install.sh")}" 2>&1`], {
    encoding: "utf8",
    env: {
      ...process.env,
      CURL_LOG: join(directory, "curl.log"),
      FAIL_URLS: "",
      HOME: directory,
      PATH: `${bin}:${extra ? `${extra}:` : ""}/usr/bin:/bin`,
      ROM_WEAVER_INSTALL_DIR: join(directory, "install"),
      ...rest,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
};

test("installs the checksummed binary for the host platform", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-"));
  try {
    const installDirectory = join(directory, "install");
    const curlLog = join(directory, "curl.log");
    const bin = setUpDarwinInstall(directory);

    const output = runInstall(directory, bin, { SHELL: "/bin/zsh" });

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
      // The provenance lookup is keyed by the hash of what was actually
      // downloaded, not by the sidecar's claim about it.
      `https://api.github.com/repos/rom-weaver/rom-weaver/attestations/sha256:${DIGEST}`,
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

// The provenance check is advisory by default, so "did it fail" is not a proxy
// for "did it verify" - each of these asserts the message the branch prints, and
// the strict-mode twin asserts that the same branch exits non-zero.
const withInstall = (options, body) => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-attest-"));
  try {
    body(directory, setUpDarwinInstall(directory, options));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const expectFailure = (run) => {
  try {
    run();
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  return assert.fail("expected install.sh to exit non-zero");
};

// `gh` is the only branch that checks the signature rather than trusting the
// API, so it has to win whenever it is available.
const GH_STUB = `#!/bin/sh
case "$1 $2" in
  "auth status") exit 0 ;;
  "attestation verify") exit $GH_VERIFY_STATUS ;;
esac
exit 1
`;

test("verifies build provenance with gh when it is available", () => {
  withInstall({}, (directory, bin) => {
    writeExecutable(join(bin, "gh"), GH_STUB);
    const output = runInstall(directory, bin, { GH_VERIFY_STATUS: "0" });
    assert.match(output, /Verified build provenance for rom-weaver-darwin-arm64/);
    // gh verified the file itself, so the weaker API lookup is not made at all.
    assert.ok(!readFileSync(join(directory, "curl.log"), "utf8").includes("attestations"));
  });
});

test("reports a failed gh verification and honors strict mode", () => {
  withInstall({}, (directory, bin) => {
    writeExecutable(join(bin, "gh"), GH_STUB);
    const output = runInstall(directory, bin, { GH_VERIFY_STATUS: "1" });
    assert.match(output, /build provenance verification FAILED/);

    const strict = expectFailure(() =>
      runInstall(directory, bin, { GH_VERIFY_STATUS: "1", ROM_WEAVER_REQUIRE_ATTESTATION: "1" }),
    );
    assert.match(strict, /build provenance verification FAILED/);
  });
});

test("falls back to the attestations API when gh is absent", () => {
  withInstall({}, (directory, bin) => {
    const output = runInstall(directory, bin);
    assert.match(output, /Found build provenance for rom-weaver-darwin-arm64/);
  });
});

test("rejects an attestation naming a different repository", () => {
  withInstall({ attestation: responseFrom("https://github.com/someone-else/rom-weaver") }, (directory, bin) => {
    assert.match(runInstall(directory, bin), /no build provenance from/);

    const strict = expectFailure(() => runInstall(directory, bin, { ROM_WEAVER_REQUIRE_ATTESTATION: "1" }));
    assert.match(strict, /no build provenance from/);
  });
});

// A repository whose name merely starts with this one's must not satisfy the
// match - the trailing quote in the pattern is what stops `rom-weaver-evil`.
test("rejects a repository that only prefixes this one", () => {
  withInstall({ attestation: responseFrom(`${REAL_RESPONSE_REPOSITORY}-evil`) }, (directory, bin) => {
    assert.match(runInstall(directory, bin), /no build provenance from/);
  });
});

test("rejects a response carrying no attestation at all", () => {
  withInstall({ attestation: '{\n  "attestations": []\n}' }, (directory, bin) => {
    assert.match(runInstall(directory, bin), /no build provenance from/);
  });
});

test("reports an asset with no published attestation", () => {
  withInstall({}, (directory, bin) => {
    assert.match(runInstall(directory, bin, { FAIL_URLS: "attestations" }), /no build provenance published/);

    const strict = expectFailure(() =>
      runInstall(directory, bin, { FAIL_URLS: "attestations", ROM_WEAVER_REQUIRE_ATTESTATION: "1" }),
    );
    assert.match(strict, /no build provenance published/);
  });
});

// The check must need nothing beyond a POSIX shell, so the whole thing runs
// again with jq, and then with every base64 flavor, taken off PATH.
test("checks provenance with no jq on PATH", () => {
  withInstall({}, (directory, bin) => {
    writeExecutable(join(bin, "jq"), "#!/bin/sh\necho 'jq must not be called' >&2\nexit 127\n");
    assert.match(runInstall(directory, bin), /Found build provenance for rom-weaver-darwin-arm64/);
  });
});

// GNU and current macOS take -d, older macOS only -D, and a box with neither
// falls through to openssl. Each is forced by making the others fail.
for (const [name, stub] of [
  ["only base64 -D", '#!/bin/sh\ncase "$1" in\n  -d) exit 1 ;;\nesac\nexec /usr/bin/base64 "$@"\n'],
  ["neither base64 flag", "#!/bin/sh\nexit 1\n"],
]) {
  test(`decodes the payload with ${name}`, () => {
    withInstall({}, (directory, bin) => {
      writeExecutable(join(bin, "base64"), stub);
      assert.match(runInstall(directory, bin), /Found build provenance for rom-weaver-darwin-arm64/);
    });
  });
}
