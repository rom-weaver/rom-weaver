import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Serves the release download, its sidecar, and the attestations API. The
// attestations call reads its status from ATTESTATION_STATUS and writes it to
// stdout, because install.sh asks for it with \`--write-out\` rather than leaning
// on \`--fail\`. ATTESTATION_CURL_FAILS models a network-level failure, where curl
// exits non-zero having received no status at all.
const curlStub = (platform, attestationJson) => `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --write-out) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
echo "$url" >> "$CURL_LOG"
case "$url" in
  *attestations*)
    cat > "$output" <<'JSON'
${attestationJson}
JSON
    if [ "\${ATTESTATION_CURL_FAILS:-0}" = 1 ]; then
      exit 6
    fi
    printf '%s' "\${ATTESTATION_STATUS:-200}"
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
      ATTESTATION_STATUS: "200",
      ATTESTATION_CURL_FAILS: "0",
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
          // This test is about asset selection; the provenance branches have
          // their own coverage and would only add noise to its output.
          ROM_WEAVER_SKIP_ATTESTATION: "1",
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

// The split these tests exist to pin down: a definite negative refuses to
// install, an unanswered question warns and continues. Getting either backwards
// is the whole risk in this feature, so every branch asserts which of the two it
// took - and a refusal additionally asserts that the way out is printed, since a
// refusal nobody can bypass is its own outage.
const withInstall = (options, body) => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-attest-"));
  try {
    body(directory, setUpDarwinInstall(directory, options));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

// A refusal must exit non-zero, leave nothing installed, and say how to get past
// it. Asserting all three together is deliberate: an exit code alone would pass
// even if the binary had already been written, or if the message left the user
// with no way forward.
const expectRefusal = (directory, run) => {
  let output;
  try {
    run();
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.ok(output !== undefined, "expected install.sh to exit non-zero");
  assert.match(output, /refusing to install/);
  assert.match(output, /ROM_WEAVER_SKIP_ATTESTATION=1/);
  assert.ok(!existsSync(join(directory, "install", "rom-weaver")), "refused install must leave no binary");
  return output;
};

// The mirror image: the check could not run, so it warns and installs anyway.
const expectWarning = (directory, output) => {
  assert.match(output, /origin is unverified/);
  assert.ok(existsSync(join(directory, "install", "rom-weaver")), "a warning must not block the install");
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

// gh reports a bad signature and a missing attestation with the same exit
// status, and both are answers rather than an inability to ask - so a failure
// here refuses outright, with no dependence on REQUIRE.
test("refuses when gh verification fails", () => {
  withInstall({}, (directory, bin) => {
    writeExecutable(join(bin, "gh"), GH_STUB);
    const output = expectRefusal(directory, () => runInstall(directory, bin, { GH_VERIFY_STATUS: "1" }));
    assert.match(output, /build provenance verification FAILED/);
  });
});

test("falls back to the attestations API when gh is absent", () => {
  withInstall({}, (directory, bin) => {
    const output = runInstall(directory, bin);
    assert.match(output, /Found build provenance for rom-weaver-darwin-arm64/);
  });
});

test("refuses an attestation naming a different repository", () => {
  withInstall({ attestation: responseFrom("https://github.com/someone-else/rom-weaver") }, (directory, bin) => {
    const output = expectRefusal(directory, () => runInstall(directory, bin));
    assert.match(output, /did not produce it/);
  });
});

// A repository whose name merely starts with this one's must not satisfy the
// match - the trailing quote in the pattern is what stops `rom-weaver-evil`.
test("refuses a repository that only prefixes this one", () => {
  withInstall({ attestation: responseFrom(`${REAL_RESPONSE_REPOSITORY}-evil`) }, (directory, bin) => {
    expectRefusal(directory, () => runInstall(directory, bin));
  });
});

test("refuses a response carrying no attestation at all", () => {
  withInstall({ attestation: '{\n  "attestations": []\n}' }, (directory, bin) => {
    expectRefusal(directory, () => runInstall(directory, bin));
  });
});

// 404 is GitHub answering the question - nothing attested these bytes - so it is
// a refusal, not an inability to check.
test("refuses an asset with no published attestation", () => {
  withInstall({}, (directory, bin) => {
    const output = expectRefusal(directory, () => runInstall(directory, bin, { ATTESTATION_STATUS: "404" }));
    assert.match(output, /no build provenance published/);
  });
});

// A rate limit or an outage left the question unanswered, which must not stop an
// install: the unauthenticated API allows 60 requests an hour per address, so
// this is reachable by ordinary use rather than only by attack.
test("warns but installs when the API cannot answer", () => {
  for (const environment of [{ ATTESTATION_STATUS: "403" }, { ATTESTATION_STATUS: "503" }, { ATTESTATION_CURL_FAILS: "1" }]) {
    withInstall({}, (directory, bin) => {
      const output = runInstall(directory, bin, environment);
      assert.match(output, /could not reach the attestations API/);
      expectWarning(directory, output);
    });
  }
});

// ...unless the caller says an unverifiable download is unacceptable.
test("refuses an unanswerable check under ROM_WEAVER_REQUIRE_ATTESTATION", () => {
  withInstall({}, (directory, bin) => {
    expectRefusal(directory, () =>
      runInstall(directory, bin, { ATTESTATION_STATUS: "403", ROM_WEAVER_REQUIRE_ATTESTATION: "1" }),
    );
  });
});

// The escape hatch every refusal advertises. It has to work even for the case
// that would otherwise be fatal, or the advice printed is wrong.
test("ROM_WEAVER_SKIP_ATTESTATION installs past a refusal without asking the API", () => {
  withInstall({ attestation: '{\n  "attestations": []\n}' }, (directory, bin) => {
    const output = runInstall(directory, bin, { ROM_WEAVER_SKIP_ATTESTATION: "1", ATTESTATION_STATUS: "404" });
    assert.match(output, /skipping the build provenance check/);
    assert.ok(existsSync(join(directory, "install", "rom-weaver")));
    assert.ok(!readFileSync(join(directory, "curl.log"), "utf8").includes("attestations"));
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
