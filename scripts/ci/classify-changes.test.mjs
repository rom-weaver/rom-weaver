import assert from "node:assert/strict";
import test from "node:test";

import { classifyChanges } from "./classify-changes.mjs";
import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";

// Both helpers stringify, so a `deepEqual` against the whole result and a spot
// check of one key read the same way.
const classifyFor = (eventName, ...paths) =>
  Object.fromEntries(
    Object.entries(classifyChanges(paths, false, eventName)).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
const classify = (...paths) => classifyFor(undefined, ...paths);

test("documentation changes skip compiled stacks", () =>
  assert.deepEqual(classify("README.md", "docs/development/ci.md"), {
    rust: "false",
    webapp: "false",
    wasm_runtime: "false",
    security: "false",
    docker_cli: "false",
    docker_webapp: "false",
    docker_cli_arm64: "false",
    docker_webapp_arm64: "false",
    docker_prebuilt: "false",
    repo_lint: "true",
    full: "false",
  }));
test("usage guide changes build the webapp", () =>
  assert.equal(classify("docs/how-to/apply-rom-patches.md").webapp, "true"));
test("every published guide builds the webapp, whatever folder it sits in", () => {
  for (const path of [
    "docs/reference/cli.md",
    "docs/legal/privacy.md",
    "docs/development/ARCHITECTURE.md",
  ]) {
    assert.equal(classify(path).webapp, "true", `${path} is a published route`);
  }
});
test("unpublished maintainer docs do not build the webapp", () =>
  assert.equal(classify("docs/development/performance.md").webapp, "false"));
test("webapp changes reuse wasm and skip Rust", () => {
  const result = classify("packages/rom-weaver-webapp/src/index.tsx");
  assert.equal(result.webapp, "true");
  assert.equal(result.wasm_runtime, "false");
});
test("browser runtime changes select the direct WASM browser suite", () => {
  for (const path of [
    "packages/rom-weaver-webapp/src/wasm/browser-opfs-runner.ts",
    "packages/rom-weaver-webapp/src/workers/rom-weaver/rom-weaver-runner.ts",
    "packages/rom-weaver-webapp/src/storage/browser/browser-large-file-vfs.ts",
    "packages/rom-weaver-webapp/src/lib/runtime/wasm-command-runtime.ts",
    "packages/rom-weaver-webapp/src/platform/browser/workflow-runtime.ts",
    "packages/rom-weaver-webapp/src/types/workflow-runtime-adapter.ts",
    "packages/rom-weaver-webapp/tests/wasm/browser-worker-client.test.mjs",
    "packages/rom-weaver-webapp/vitest.config.base.mjs",
    "packages/rom-weaver-webapp/vitest.wasm.browser.config.mjs",
  ]) {
    const result = classify(path);
    assert.equal(result.wasm_runtime, "true", path);
    assert.equal(result.webapp, "true", path);
  }
});
test("fixtures consumed by WASM browser tests select the runtime suite", () => {
  for (const path of [
    "tests/fixtures/vcdiff/secondary-source.bin",
    "crates/rom-weaver-patches/tests/fixtures/hdiffpatch/source.bin",
    "packages/rom-weaver-webapp/tests/fixtures/archives/multi-rom.zip",
  ]) {
    const result = classify(path);
    assert.equal(result.wasm_runtime, "true", path);
    assert.equal(result.webapp, "true", path);
  }
});
test("Docker changes select only the affected images", () => {
  assert.equal(classify("Dockerfile").docker_cli, "true");
  assert.equal(classify("packages/rom-weaver-webapp/Dockerfile").docker_webapp, "true");
  assert.equal(classify(".dockerignore").docker_cli, "true");
  assert.equal(classify("packages/rom-weaver-webapp/Dockerfile").docker_cli, "false");
});

// The shared build/tag path. An edit here that breaks an image would otherwise
// only surface at the release that publishes it.
test("the shared Docker actions select both images", () => {
  for (const path of [
    ".github/actions/docker-build-arch/action.yml",
    ".github/actions/docker-manifest/action.yml",
  ]) {
    const result = classify(path);
    assert.equal(result.docker_cli, "true", path);
    assert.equal(result.docker_webapp, "true", path);
  }
  // A composite action that builds no image selects no image. (`wasm-cache` and
  // `setup-build-env` are no counter-example - they select `full`, so they
  // select everything.)
  assert.equal(classify(".github/actions/deploy-webapp-pages/action.yml").docker_cli, "false");
});
// The wasm cache key excludes these same trees, so selecting the webapp stack
// for them can only ever buy a cache hit plus browser jobs that cannot
// observe the edit. `.github/actions/wasm-cache` owns the authoritative list.
test("Rust test-only changes select nothing but Rust", () => {
  for (const path of [
    "crates/rom-weaver-cli/tests/cli_smoke/apply.rs",
    "crates/rom-weaver-core/src/test_support.rs",
    "crates/rom-weaver-patches/benches/xdelta.rs",
    "crates/rom-weaver-containers/examples/probe.rs",
  ]) {
    assert.deepEqual(
      classify(path),
      {
        rust: "true",
        webapp: "false",
        wasm_runtime: "false",
        security: "false",
        docker_cli: "false",
        docker_webapp: "false",
        docker_cli_arm64: "false",
        docker_webapp_arm64: "false",
        docker_prebuilt: "false",
        repo_lint: "false",
        full: "false",
      },
      path,
    );
  }
});

test("Rust test-only changes select Rust alone", () => {
  assert.equal(classify("crates/rom-weaver-cli/tests/cli_smoke/apply.rs").webapp, "false");
  assert.equal(classify("crates/rom-weaver-containers/src/chd/tests.rs").webapp, "false");
  // Nested test modules too: the shell globs this replaced matched across `/`.
  assert.equal(
    classify("crates/rom-weaver-containers/src/chd/decode/test_frames.rs").webapp,
    "false",
  );
  assert.equal(
    classify("crates/rom-weaver-containers/src/chd/decode/frames.rs").webapp,
    "true",
    "non-test sources still drive the release stacks",
  );
});

test("production Rust skips source Docker on pull requests and restores it on main", () => {
  const path = "crates/rom-weaver-containers/src/chd/decode/frames.rs";
  const pullRequest = classifyFor("pull_request", path);
  assert.equal(pullRequest.wasm_runtime, "true");
  assert.equal(pullRequest.docker_cli, "false");
  assert.equal(classifyFor("push", path).docker_cli, "true");
});

// `pull_request` is the only event that narrows anything, so an absent or
// unrecognized one has to cost time rather than coverage - a caller that forgets
// to pass EVENT_NAME must not silently drop the CLI image build.
// scripts/ci/cli-platform-matrix.mjs pins the same default for the same reason.
test("an absent or unknown event keeps the full selection", () => {
  const path = "crates/rom-weaver-containers/src/chd/decode/frames.rs";
  for (const eventName of [undefined, "", "push", "workflow_dispatch", "merge_group"]) {
    assert.equal(classifyFor(eventName, path).docker_cli, "true", String(eventName));
  }
});

// A second architecture is a second full release compile of the same source. It
// can only fail for a reason the first one did not when the failure is
// architecture-specific, and everything that is - the SDK pins, the exporter,
// the per-arch cache ref - lives in the image definition and the shared build
// action, not in a lock file.
test("a pull request builds arm64 only for image definition changes", () => {
  for (const [path, cliArm64, webappArm64] of [
    ["Dockerfile", "true", "false"],
    ["packages/rom-weaver-webapp/Dockerfile", "false", "true"],
    [".github/actions/docker-build-arch/action.yml", "true", "true"],
    [".dockerignore", "true", "true"],
    // A CI or toolchain change fails open all the way down - it can break one
    // architecture and not the other.
    [".github/workflows/ci.yml", "true", "true"],
    // Compile inputs and arch-neutral runtime config: amd64 proves them.
    ["Cargo.lock", "false", "false"],
    ["Cargo.toml", "false", "false"],
    ["packages/rom-weaver-webapp/sws.toml", "false", "false"],
    ["packages/rom-weaver-webapp/scripts/compress-static-assets.mjs", "false", "false"],
  ]) {
    const result = classifyFor("pull_request", path);
    assert.equal(result.docker_cli_arm64, cliArm64, path);
    assert.equal(result.docker_webapp_arm64, webappArm64, path);
  }
});

// Only a pull request narrows: main's legs feed the `nightly` manifest lists, so
// an image it selected at all owes both architectures.
test("every other event builds both architectures of whatever it selected", () => {
  for (const eventName of [undefined, "", "push", "workflow_dispatch", "merge_group"]) {
    const result = classifyFor(eventName, "Cargo.lock");
    assert.equal(result.docker_cli_arm64, "true", String(eventName));
    // Still not selected at all, so still no arm64 leg.
    assert.equal(result.docker_webapp, "false", String(eventName));
    assert.equal(result.docker_webapp_arm64, "false", String(eventName));
  }
});

test("the prebuilt smoke needs an image reason on a pull request, a bundle on main", () => {
  const webappOnly = "packages/rom-weaver-webapp/src/index.tsx";
  const rustOnly = "crates/rom-weaver-containers/src/chd/decode/frames.rs";
  for (const path of [webappOnly, rustOnly]) {
    assert.equal(classifyFor("pull_request", path).webapp, "true", path);
    assert.equal(classifyFor("pull_request", path).docker_prebuilt, "false", path);
    // Every bundle main builds owes the webapp `nightly` channel an image.
    assert.equal(classifyFor("push", path).docker_prebuilt, "true", path);
  }
  // An image-side change selects it on a pull request too.
  assert.equal(
    classifyFor("pull_request", "packages/rom-weaver-webapp/Dockerfile").docker_prebuilt,
    "true",
  );
  // No bundle, no smoke - it wraps `webapp-static`'s artifact.
  assert.equal(classifyFor("push", "Dockerfile").webapp, "false");
  assert.equal(classifyFor("push", "Dockerfile").docker_prebuilt, "false");
});

test("plumbing lint runs only for the file kinds it lints", () => {
  for (const path of [
    ".github/workflows/codeql.yml",
    // Nested `.github` YAML: the shell `case` glob this replaced matched
    // across `/`, so keep matching at any depth.
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/actions/wasm-cache/action.yml",
    "scripts/setup-worktree.sh",
    "scripts/warn-only.mjs",
    "packages/rom-weaver-webapp/Dockerfile",
    ".config/hadolint.yaml",
  ]) {
    assert.equal(classify(path).repo_lint, "true", path);
  }
  for (const path of [
    "crates/rom-weaver-core/src/lib.rs",
    "packages/rom-weaver-webapp/src/index.tsx",
    "install.ps1",
    ".github/cli-platforms.json",
  ]) {
    assert.equal(classify(path).repo_lint, "false", path);
  }
  for (const path of ["README.md", "docs/development/ci.md", ".github/ISSUE_TEMPLATE/bug.md"]) {
    assert.equal(classify(path).repo_lint, "true", path);
  }
});
test("native package changes build every CLI platform", () => {
  // The shared build action is a composite action, so it also selects the
  // plumbing lint; the target list beside it is data nothing lints.
  for (const [path, repoLint] of [
    ["packages/rom-weaver-cli-platforms/linux-arm64-musl/package.json", "false"],
    ["scripts/verify-cli-platform.mjs", "true"],
    [".github/cli-platforms.json", "false"],
    [".github/actions/build-cli-platform/action.yml", "true"],
  ]) {
    assert.deepEqual(
      classify(path),
      {
        rust: "true",
        webapp: "true",
        wasm_runtime: "false",
        security: "false",
        docker_cli: "false",
        docker_webapp: "false",
        docker_cli_arm64: "false",
        docker_webapp_arm64: "false",
        docker_prebuilt: "true",
        repo_lint: repoLint,
        full: "false",
      },
      path,
    );
  }
});

test("dependency and CI changes select their broader checks", () => {
  assert.deepEqual(classify("Cargo.lock"), {
    rust: "true",
    webapp: "true",
    wasm_runtime: "true",
    security: "true",
    docker_cli: "true",
    docker_webapp: "false",
    docker_cli_arm64: "true",
    docker_webapp_arm64: "false",
    docker_prebuilt: "true",
    repo_lint: "false",
    full: "false",
  });
  for (const path of [
    ".github/workflows/ci.yml",
    "scripts/ci/ensure-cloudflare-assets-cache-rule.mjs",
    "scripts/ci/mise-disable-tools.mjs",
    "scripts/ci/resolve-wasm-run.mjs",
  ]) {
    assert.deepEqual(
      classify(path),
      {
        rust: "true",
        webapp: "true",
        wasm_runtime: "true",
        security: "true",
        docker_cli: "true",
        docker_webapp: "true",
        docker_cli_arm64: "true",
        docker_webapp_arm64: "true",
        docker_prebuilt: "true",
        repo_lint: "true",
        full: "true",
      },
      path,
    );
  }
});

test("the dependency policy moved under .config/", () =>
  assert.equal(classify(".config/deny.toml").rust, "true"));

// The release pull request's diff is version strings and a changelog, which
// classifies as documentation - and merging it is what ships. Classifying it
// like any other pull request gave the shipping commit less coverage than the
// commit it was cut from.
const classifyForRef = (headRef, ...paths) =>
  classifyChanges(paths, false, "pull_request", headRef);

test("the release pull request selects every stack", () => {
  const result = classifyForRef(
    `${RELEASE_PR_BRANCH_PREFIX}cli`,
    "CHANGELOG.md",
    "Cargo.toml",
    "package.json",
  );
  for (const [key, value] of Object.entries(result)) {
    assert.equal(value, true, key);
  }
});

// Whatever the component is named, and whatever it happens to touch.
test("the release pull request selects every stack whatever it changed", () => {
  for (const component of ["cli", "webapp", "rom-weaver"]) {
    const result = classifyForRef(`${RELEASE_PR_BRANCH_PREFIX}${component}`, "README.md");
    assert.equal(result.rust, true, component);
    assert.equal(result.docker_webapp_arm64, true, component);
    assert.equal(result.full, true, component);
  }
});

test("an ordinary pull request branch classifies exactly as before", () => {
  for (const headRef of [
    undefined,
    "",
    "feature/release-please",
    // Near misses: a branch that merely mentions the prefix is not the release
    // pull request. Only a prefix match is.
    `wip-${RELEASE_PR_BRANCH_PREFIX}cli`,
    "release-please--branches--next--components--cli",
  ]) {
    for (const path of [
      "README.md",
      "packages/rom-weaver-webapp/src/index.tsx",
      "crates/rom-weaver-containers/src/chd/decode/frames.rs",
    ]) {
      assert.deepEqual(
        classifyChanges([path], false, "pull_request", headRef),
        classifyChanges([path], false, "pull_request"),
        `${String(headRef)} / ${path}`,
      );
    }
  }
});

// The head ref is only ever a pull request's, but nothing stops a caller from
// passing a stale one on another event, and that must not narrow anything.
test("a head ref on a non-pull-request event changes nothing", () => {
  for (const eventName of [undefined, "push", "workflow_dispatch"]) {
    assert.deepEqual(
      classifyChanges(["README.md"], false, eventName, `${RELEASE_PR_BRANCH_PREFIX}cli`),
      classifyChanges(["README.md"], false, eventName),
      String(eventName),
    );
  }
});
