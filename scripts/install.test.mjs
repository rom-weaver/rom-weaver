import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const writeExecutable = (path, source) => {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
};

const createDocsArchive = (directory) => {
  const source = join(directory, "docs-source");
  mkdirSync(join(source, "man"), { recursive: true });
  mkdirSync(join(source, "completions"), { recursive: true });
  writeFileSync(join(source, "man", "rom-weaver.1"), "man page\n");
  writeFileSync(join(source, "completions", "rom-weaver.bash"), "bash completion\n");
  writeFileSync(join(source, "completions", "_rom-weaver"), "zsh completion\n");
  writeFileSync(join(source, "completions", "rom-weaver.fish"), "fish completion\n");
  writeFileSync(join(source, "completions", "rom-weaver.elv"), "elvish completion\n");
  const archive = join(directory, "cli-assets.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", source, "man", "completions"]);
  return archive;
};

const createBinaryArchive = (directory) => {
  const source = join(directory, "binary-source");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "rom-weaver"), "binary\n");
  const archive = join(directory, "binary-asset.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", source, "rom-weaver"]);
  return archive;
};

const createIdentifyArchive = (directory) => {
  const source = join(directory, "identify-source");
  const data = join(source, "share", "rom-weaver", "identify", "v1");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "index.json"), "{}\n");
  const tarPath = join(directory, "identify-data.tar");
  const archive = join(directory, "identify-data.tar.zst");
  execFileSync("tar", ["-cf", tarPath, "-C", source, "share"]);
  execFileSync("zstd", ["-q", "-f", tarPath, "-o", archive]);
  return archive;
};

const DIGEST = "b".repeat(64);

// install.sh hashes the download to build the attestation URL. There is no
// sidecar to check against any more, so this only has to answer the plain form.
const SHA256SUM_STUB = `#!/bin/sh
echo "${DIGEST}  $1"
`;

// Serves the release download and the attestations API. The attestations call
// reads its status from ATTESTATION_STATUS and writes it to stdout, because
// install.sh asks for it with \`--write-out\` rather than leaning on \`--fail\`.
// ATTESTATION_CURL_FAILS models a network-level failure, where curl exits
// non-zero having received no status at all.
const curlStub = (attestationJson) => `#!/bin/sh
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
  *identify-data.tar.zst) cp "$IDENTIFY_DATA_ARCHIVE" "$output" ;;
  *cli-assets.tar.gz) cp "$CLI_ASSET_ARCHIVE" "$output" ;;
  *.tar.gz) cp "$BINARY_ASSET_ARCHIVE" "$output"; printf '200' ;;
  *) echo binary > "$output" ;;
esac
`;

// A verbatim response from `GET /repos/{owner}/{repo}/attestations/{digest}`,
// captured from a real published image, unmodified except for its `bundle_url` -
// a time-limited signed blob URL install.sh never reads. Testing against the
// real bytes is the point: install.sh looks for a fixed string rather than
// parsing, so a hand-written response could agree with the code while
// disagreeing with GitHub.
const REAL_RESPONSE = readFileSync(resolve("tests/fixtures/attestations-response.json"), "utf8");

// What the same endpoint returns for a repository that has attestations but none
// for these bytes - also captured verbatim, from `cli/cli`. The blank line
// inside the array is real, and is why "is this empty" cannot be answered by
// looking at length or whitespace.
const EMPTY_RESPONSE = '{\n  "attestations": [\n\n  ]\n}\n';

// Everything the provenance tests share: a Darwin host and a stubbed download.
// `bin` is returned so a test can shadow a tool inside it.
const setUpDarwinInstall = (directory, options = {}) => {
  const { attestation = REAL_RESPONSE } = options;
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeExecutable(
    join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in\n  -s) echo Darwin ;;\n  -m) echo arm64 ;;\nesac\n',
  );
  writeExecutable(join(bin, "curl"), curlStub(attestation));
  writeExecutable(join(bin, "sha256sum"), SHA256SUM_STUB);
  createDocsArchive(directory);
  createBinaryArchive(directory);
  createIdentifyArchive(directory);
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
      CLI_ASSET_ARCHIVE: join(directory, "cli-assets.tar.gz"),
      BINARY_ASSET_ARCHIVE: join(directory, "binary-asset.tar.gz"),
      IDENTIFY_DATA_ARCHIVE: join(directory, "identify-data.tar.zst"),
      ...rest,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
};

test("installs the binary for the host platform", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-"));
  try {
    const installDirectory = join(directory, "install");
    const curlLog = join(directory, "curl.log");
    const bin = setUpDarwinInstall(directory);

    const output = runInstall(directory, bin, { SHELL: "/bin/zsh" });

    assert.equal(readFileSync(join(installDirectory, "rom-weaver"), "utf8"), "binary\n");
    assert.equal(
      readFileSync(join(installDirectory, "share/rom-weaver/identify/v1/index.json"), "utf8"),
      "{}\n",
    );
    assert.equal(
      readFileSync(join(directory, ".local/share/man/man1/rom-weaver.1"), "utf8"),
      "man page\n",
    );
    assert.equal(
      readFileSync(join(directory, ".local/share/bash-completion/completions/rom-weaver"), "utf8"),
      "bash completion\n",
    );
    assert.equal(readFileSync(join(directory, ".zfunc/_rom-weaver"), "utf8"), "zsh completion\n");
    assert.equal(
      readFileSync(join(directory, ".config/fish/completions/rom-weaver.fish"), "utf8"),
      "fish completion\n",
    );
    assert.equal(
      readFileSync(join(directory, ".config/elvish/lib/rom-weaver.elv"), "utf8"),
      "elvish completion\n",
    );
    assert.ok(output.includes(`Installed rom-weaver to ${installDirectory}/rom-weaver`));
    assert.ok(
      output.includes(`echo 'export PATH="${installDirectory}:$PATH"' >> "${directory}/.zshrc"`),
    );
    assert.ok(output.includes(`source "${directory}/.zshrc"`));
    assert.ok(output.includes("Then run: rom-weaver --help"));
    assert.deepEqual(readFileSync(curlLog, "utf8").trim().split("\n"), [
      "https://github.com/rom-weaver/rom-weaver/releases/latest/download/rom-weaver-darwin-arm64.tar.gz",
      // No `.sha256` fetch: the provenance lookup is keyed by the hash of what
      // actually arrived, so it subsumes the checksum it used to download.
      // `predicate_type` is asserted here because dropping it silently weakens
      // the check: GitHub's automatic release attestation would answer instead.
      `https://api.github.com/repos/rom-weaver/rom-weaver/attestations/sha256:${DIGEST}?predicate_type=https://slsa.dev/provenance/v1`,
      "https://github.com/rom-weaver/rom-weaver/releases/latest/download/rom-weaver-identify-data.tar.zst",
      `https://api.github.com/repos/rom-weaver/rom-weaver/attestations/sha256:${DIGEST}?predicate_type=https://slsa.dev/provenance/v1`,
      "https://github.com/rom-weaver/rom-weaver/releases/latest/download/rom-weaver-cli-assets.tar.gz",
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
      createDocsArchive(directory);
      createBinaryArchive(directory);
      createIdentifyArchive(directory);
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
  *cli-assets.tar.gz) cp "$CLI_ASSET_ARCHIVE" "$output" ;;
  *identify-data.tar.zst) cp "$IDENTIFY_DATA_ARCHIVE" "$output" ;;
  *.tar.gz) cp "$BINARY_ASSET_ARCHIVE" "$output"; printf '200' ;;
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
          CLI_ASSET_ARCHIVE: join(directory, "cli-assets.tar.gz"),
          BINARY_ASSET_ARCHIVE: join(directory, "binary-asset.tar.gz"),
          IDENTIFY_DATA_ARCHIVE: join(directory, "identify-data.tar.zst"),
          // This test is about asset selection; the provenance branches have
          // their own coverage and would only add noise to its output.
          ROM_WEAVER_SKIP_ATTESTATION: "1",
        },
      });

      assert.equal(
        readFileSync(curlLog, "utf8").trim().split("\n")[0],
        `https://github.com/rom-weaver/rom-weaver/releases/latest/download/rom-weaver-${platform}.tar.gz`,
      );
      assert.equal(
        readFileSync(
          join(directory, "install", "share", "rom-weaver", "identify", "v1", "index.json"),
          "utf8",
        ),
        "{}\n",
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
  assert.ok(
    !existsSync(join(directory, "install", "rom-weaver")),
    "refused install must leave no binary",
  );
  return output;
};

// The mirror image: the check could not run, so it warns and installs anyway.
const expectWarning = (directory, output) => {
  assert.match(output, /this download is unverified/);
  assert.ok(
    existsSync(join(directory, "install", "rom-weaver")),
    "a warning must not block the install",
  );
};

test("accepts a response carrying an attestation for these bytes", () => {
  withInstall({}, (directory, bin) => {
    const output = runInstall(directory, bin);
    assert.match(output, /Verified build provenance for rom-weaver-darwin-arm64\.tar\.gz/);
  });
});

// The endpoint is scoped to this repository, so an empty array is GitHub saying
// this repository attested nothing for these bytes. A repository with no
// attestations at all answers 404 instead; the two mean the same thing and both
// have to refuse.
test("refuses a response carrying no attestation for these bytes", () => {
  withInstall({ attestation: EMPTY_RESPONSE }, (directory, bin) => {
    const output = expectRefusal(directory, () => runInstall(directory, bin));
    assert.match(output, /no build provenance from/);
  });
});

test("refuses a 404 from the attestations API", () => {
  withInstall({ attestation: EMPTY_RESPONSE }, (directory, bin) => {
    const output = expectRefusal(directory, () =>
      runInstall(directory, bin, { ATTESTATION_STATUS: "404" }),
    );
    assert.match(output, /no build provenance from/);
  });
});

// A rate limit or an outage left the question unanswered, which must not stop an
// install: the unauthenticated API allows 60 requests an hour per address, so
// this is reachable by ordinary use rather than only by attack.
test("warns but installs when the API cannot answer", () => {
  for (const environment of [
    { ATTESTATION_STATUS: "403" },
    { ATTESTATION_STATUS: "503" },
    { ATTESTATION_CURL_FAILS: "1" },
  ]) {
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
      runInstall(directory, bin, {
        ATTESTATION_STATUS: "403",
        ROM_WEAVER_REQUIRE_ATTESTATION: "1",
      }),
    );
  });
});

// The escape hatch every refusal advertises. It has to work even for the case
// that would otherwise be fatal, or the advice printed is wrong.
test("ROM_WEAVER_SKIP_ATTESTATION installs past a refusal without asking the API", () => {
  withInstall({ attestation: '{\n  "attestations": []\n}' }, (directory, bin) => {
    const output = runInstall(directory, bin, {
      ROM_WEAVER_SKIP_ATTESTATION: "1",
      ATTESTATION_STATUS: "404",
    });
    assert.match(output, /skipping the build provenance check/);
    assert.ok(existsSync(join(directory, "install", "rom-weaver")));
    assert.ok(!readFileSync(join(directory, "curl.log"), "utf8").includes("attestations"));
  });
});

// The whole check is now curl plus grep, so a box with neither jq nor a base64
// decoder still gets it. Both are shadowed with stubs that fail loudly if
// called.
test("needs no jq and no base64 decoder", () => {
  withInstall({}, (directory, bin) => {
    for (const tool of ["jq", "base64", "openssl"]) {
      writeExecutable(
        join(bin, tool),
        `#!/bin/sh\necho '${tool} must not be called' >&2\nexit 127\n`,
      );
    }
    assert.match(
      runInstall(directory, bin),
      /Verified build provenance for rom-weaver-darwin-arm64\.tar\.gz/,
    );
  });
});

// Releases up to v0.10.2 shipped a loose executable instead of a tar.gz. The
// installer must fall back to that name so a pinned old version stays
// installable.
test("falls back to the loose binary asset for pre-archive releases", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-legacy-"));
  try {
    const bin = setUpDarwinInstall(directory);
    writeExecutable(
      join(bin, "curl"),
      `#!/bin/sh
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
  *cli-assets.tar.gz) cp "$CLI_ASSET_ARCHIVE" "$output" ;;
  *identify-data.tar.zst) exit 22 ;;
  *.tar.gz) printf '404' ;;
  *) echo binary > "$output" ;;
esac
`,
    );

    const output = runInstall(directory, bin, { ROM_WEAVER_SKIP_ATTESTATION: "1" });

    assert.equal(readFileSync(join(directory, "install", "rom-weaver"), "utf8"), "binary\n");
    const log = readFileSync(join(directory, "curl.log"), "utf8").trim().split("\n");
    assert.equal(
      log[0],
      "https://github.com/rom-weaver/rom-weaver/releases/latest/download/rom-weaver-darwin-arm64.tar.gz",
    );
    assert.equal(
      log[1],
      "https://github.com/rom-weaver/rom-weaver/releases/latest/download/rom-weaver-darwin-arm64",
    );
    assert.ok(output.includes("Installed rom-weaver to"));
    assert.match(output, /ROM identify data unavailable/);
    assert.ok(!existsSync(join(directory, "install", "share")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The mirror image of the fallback: only a definite 404 may reroute to the
// legacy name. A transient failure must surface as itself, not as the legacy
// asset's error.
test("does not fall back on a transient download failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-transient-"));
  try {
    const bin = setUpDarwinInstall(directory);
    writeExecutable(
      join(bin, "curl"),
      `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --write-out) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
echo "$url" >> "$CURL_LOG"
printf '500'
`,
    );

    let output;
    try {
      runInstall(directory, bin, { ROM_WEAVER_SKIP_ATTESTATION: "1" });
    } catch (error) {
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    assert.ok(output !== undefined, "expected install.sh to exit non-zero");
    assert.match(output, /HTTP 500/);
    const log = readFileSync(join(directory, "curl.log"), "utf8");
    assert.ok(
      !log.includes("download/rom-weaver-darwin-arm64\n"),
      "must not retry the legacy asset",
    );
    assert.ok(!existsSync(join(directory, "install", "rom-weaver")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
