import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

// The shape install.sh reads: a base64 DSSE payload whose statement names the
// repository that built the asset.
const attestationFor = (repository) => {
  const statement = {
    predicate: { buildDefinition: { externalParameters: { workflow: { repository } } } },
  };
  const payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  return JSON.stringify({ attestations: [{ bundle: { dsseEnvelope: { payload } } }] }, null, 2);
};

// The fallback branch shells out to jq. Where the jq expression itself is what
// is under test the real binary is used, so the tests cannot drift from it;
// jq is not a documented prerequisite for this repository, so those tests skip
// rather than fail when it is missing.
const jqDirectory = () => {
  try {
    const path = execFileSync("sh", ["-c", "command -v jq"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return dirname(path.trim());
  } catch {
    return null;
  }
};

// A stand-in for jq that returns whatever the test wants the query to yield, so
// a test that is not about the expression takes the same branch on every host.
// The expression itself is covered against the real jq below.
const JQ_STUB = `#!/bin/sh
printf '%s\\n' "$JQ_REPOSITORY"
`;

// Everything the provenance tests share: a Darwin host and a stubbed download.
// `bin` is returned so a test can add its own `gh`, or shadow the jq stub.
const setUpDarwinInstall = (directory, options = {}) => {
  const { attestation = attestationFor("https://github.com/rom-weaver/rom-weaver"), jq = "stub" } = options;
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeExecutable(join(bin, "uname"), '#!/bin/sh\ncase "$1" in\n  -s) echo Darwin ;;\n  -m) echo arm64 ;;\nesac\n');
  writeExecutable(join(bin, "curl"), curlStub("darwin-arm64", attestation));
  writeExecutable(join(bin, "sha256sum"), SHA256SUM_STUB);
  if (jq === "stub") writeExecutable(join(bin, "jq"), JQ_STUB);
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
      JQ_REPOSITORY: "https://github.com/rom-weaver/rom-weaver",
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
  withInstall({}, (directory, bin) => {
    const environment = { JQ_REPOSITORY: "https://github.com/someone-else/rom-weaver" };
    assert.match(runInstall(directory, bin, environment), /no build provenance from/);

    const strict = expectFailure(() =>
      runInstall(directory, bin, { ...environment, ROM_WEAVER_REQUIRE_ATTESTATION: "1" }),
    );
    assert.match(strict, /no build provenance from/);
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

// The stub above fixes jq's answer, which would let the real expression rot
// unnoticed. This runs the expression install.sh actually ships against the
// response shape the API actually returns.
test("reads the repository out of a real attestation response", { skip: jqDirectory() === null && "jq is not installed" }, () => {
  withInstall({ jq: "none" }, (directory, bin) => {
    const output = runInstall(directory, bin, { PATH: jqDirectory() });
    assert.match(output, /Found build provenance for rom-weaver-darwin-arm64/);
  });
});

test("rejects a real attestation response naming a different repository", { skip: jqDirectory() === null && "jq is not installed" }, () => {
  withInstall({ jq: "none", attestation: attestationFor("https://github.com/someone-else/rom-weaver") }, (directory, bin) => {
    const output = runInstall(directory, bin, { PATH: jqDirectory() });
    assert.match(output, /no build provenance from/);
  });
});
