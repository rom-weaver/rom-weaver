#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { DOC_SOURCES } from "../../packages/rom-weaver-webapp/src/webapp/docs-routing.mjs";
import { isWasmCompilerInput } from "../wasm/wasm-compiler-inputs.mjs";
import { isReleasePullRequest } from "./release-pr.mjs";

// Published documentation MUST select the webapp build.
// The route table distinguishes published pages from unpublished maintainer notes in the same folder.
const PUBLISHED_DOCS = new Set(DOC_SOURCES.map((source) => `docs/${source.file}`));

// These files decide which parts of CI run or set up its shared toolchains. A
// missed dependency here can skip or break any consumer, so their changes MUST
// keep the full matrix.
const FULL_CI_PLUMBING = new Set([
  "scripts/ci/classify-changes.mjs",
  "scripts/ci/classify-workflow.mjs",
  "scripts/ci/install-system-dependencies.mjs",
  "scripts/ci/mise-disable-tools.mjs",
  "scripts/ci/release-pr.mjs",
  "scripts/ci/select-mise-tools.mjs",
]);

// These deployment and cleanup helpers have repo-lint coverage and do not
// affect an application build. New CI helpers stay fail-open below until their
// consumers have the same proof.
const REPO_LINT_CI_HELPERS = new Set([
  "scripts/ci/cache-cleanup.mjs",
  "scripts/ci/cla-gate.mjs",
  "scripts/ci/cleanup-preview-deployments.sh",
  "scripts/ci/deploy-pages.mjs",
  "scripts/ci/deployment-status.mjs",
  "scripts/ci/docker-tag-policy.mjs",
  "scripts/ci/ensure-cloudflare-assets-cache-rule.mjs",
  "scripts/ci/ensure-cloudflare-pages-project.mjs",
  "scripts/ci/github-api.mjs",
  "scripts/ci/npm-publish-package.mjs",
  "scripts/ci/publication-freshness.mjs",
  "scripts/ci/publish-apply-video.mjs",
  "scripts/ci/purge-cloudflare-pages-cache.mjs",
]);

// Root scripts that no build, image, or CI job imports or runs on a pull
// request. Their tests MUST run in `repo-lint` without webapp dependencies;
// `classify-changes.test.mjs` checks that its test step lists every one.
export const ROOT_LEAF_SCRIPTS = [
  "bench-disc-tools",
  "generate-compressed-disc-sample",
  "markdownlint-no-soft-line-breaks",
  "quality-diff-coverage",
  "quality-fuzz",
  "quality-kani",
  "quality-miri",
  "quality-mutation",
  "quality-native-unaligned",
  "quality-plan",
  "quality-reference",
  "quality-reference-encoder",
  "quality-regression-proof",
  "quality-sanitizer",
  "quality-summary",
  "quality-test-selection",
  "quality-trusted-guardrails",
  "quality-workflows",
  "release-metadata",
  "remove-worktree",
  "setup-worktree",
  "strip-ai-attribution",
  "update-markdown-toc",
];
const ROOT_LEAF_SCRIPT = new RegExp(
  `^scripts/(?:${ROOT_LEAF_SCRIPTS.join("|")})(?:\\.test)?\\.mjs$`,
);

// Webapp static assets that live under docs/ but are not guide Markdown.
const DOCS_WEBAPP_ASSET = /^docs\/(?:screenshots\/|samples\/|rom-weaver-[\w-]+\.schema\.json$)/;

const WEBAPP_PACKAGE = "packages/rom-weaver-webapp/";

// Inputs that can change the bundle the Lighthouse gates audit. Webapp tests,
// guide Markdown, and Rust-only targets cannot; build scripts fail open.
const isLighthouseInput = (path) =>
  (path.startsWith(WEBAPP_PACKAGE) &&
    !/(?:^|\/)tests?\/|\.test\.[cm]?[jt]sx?$/.test(path.slice(WEBAPP_PACKAGE.length))) ||
  isWasmCompilerInput(path) ||
  (path.startsWith("scripts/wasm/") &&
    !path.endsWith(".test.mjs") &&
    path !== "scripts/wasm/README.md") ||
  (/^scripts\/[^/]+\.mjs$/.test(path) &&
    !path.endsWith(".test.mjs") &&
    !ROOT_LEAF_SCRIPT.test(path)) ||
  path.startsWith("design/") ||
  /^(?:Cargo\.(?:toml|lock)|package(?:-lock)?\.json)$/.test(path);

// The real runtime lifecycle suite imports these host helpers outside the worker layers.
// The import-graph test MUST reject newly reachable helpers missing from this list.
const WASM_RUNTIME_SUPPORT = new Set([
  "packages/rom-weaver-webapp/src/lib/cheats/model.ts",
  "packages/rom-weaver-webapp/src/lib/checksum-algorithms.ts",
  "packages/rom-weaver-webapp/src/lib/compression/codec-parser.ts",
  "packages/rom-weaver-webapp/src/lib/compression/compression-metadata.ts",
  "packages/rom-weaver-webapp/src/lib/compression/container-format-registry.ts",
  "packages/rom-weaver-webapp/src/lib/compression/disc-image-policy.ts",
  "packages/rom-weaver-webapp/src/lib/compression/rom-specific-format-support.ts",
  "packages/rom-weaver-webapp/src/lib/compression/z3ds-subtypes.ts",
  "packages/rom-weaver-webapp/src/lib/errors.ts",
  "packages/rom-weaver-webapp/src/lib/identify/checksum-router.mjs",
  "packages/rom-weaver-webapp/src/lib/identify/identify-catalog.ts",
  "packages/rom-weaver-webapp/src/lib/identify/sha256-hex.ts",
  "packages/rom-weaver-webapp/src/lib/identify/title-index.mjs",
  "packages/rom-weaver-webapp/src/lib/input/input-assets.ts",
  "packages/rom-weaver-webapp/src/lib/input/input-classification.ts",
  "packages/rom-weaver-webapp/src/lib/input/path-utils.ts",
  "packages/rom-weaver-webapp/src/lib/input/patch-archive-replacement.ts",
  "packages/rom-weaver-webapp/src/lib/input/path-utils.ts",
  "packages/rom-weaver-webapp/src/lib/input/rom-specific-file-utils.ts",
  "packages/rom-weaver-webapp/src/lib/patch-format-classification.ts",
  "packages/rom-weaver-webapp/src/lib/path-utils.ts",
  "packages/rom-weaver-webapp/src/lib/perf/op-perf-marks.ts",
  "packages/rom-weaver-webapp/src/lib/workflow/source-preparation.ts",
  "packages/rom-weaver-webapp/src/presentation/formatting/index.ts",
  "packages/rom-weaver-webapp/src/presentation/localization/catalog.ts",
  "packages/rom-weaver-webapp/src/presentation/localization/locales/de.ts",
  "packages/rom-weaver-webapp/src/presentation/localization/locales/en.ts",
  "packages/rom-weaver-webapp/src/presentation/localization/locales/es.ts",
  "packages/rom-weaver-webapp/src/webapp/offline-warmup.ts",
  "packages/rom-weaver-webapp/src/webapp/pwa/docs-image-format.ts",
  "packages/rom-weaver-webapp/src/webapp/pwa/offline-copy-policy.ts",
  "packages/rom-weaver-webapp/src/webapp/pwa/offline-download-log.ts",
  "packages/rom-weaver-webapp/src/webapp/pwa/offline-progress-reporter.ts",
  "packages/rom-weaver-webapp/src/webapp/pwa/offline-warmup-client.ts",
  "packages/rom-weaver-webapp/src/webapp/pwa/response-encoded-size.ts",
]);

const EMPTY = {
  rust: false,
  // `rust-lint` alone: a fuzz-target change needs its build check but no
  // test or platform build.
  rust_lint: false,
  // The fuzz workspace build check inside `rust-lint`.
  fuzz: false,
  webapp: false,
  // `webapp-browser` and `webapp-webkit-e2e`. A pull request that changes only
  // published guide Markdown keeps the static checks and Chromium E2E.
  webapp_browser: false,
  // The Lighthouse steps of `webapp-static`. Every event but a pull request
  // audits; a pull request audits when a bundle input changed.
  lighthouse: false,
  wasm_runtime: false,
  security: false,
  docker_cli: false,
  docker_webapp: false,
  // Ordinary pull requests limit arm64 builds to image-definition changes to reduce
  // compile cost; full runs also check architecture-specific source and dependency failures.
  docker_cli_arm64: false,
  docker_webapp_arm64: false,
  // The prebuilt image uses the wasm job's webapp bundle and skips the builder stage.
  docker_prebuilt: false,
  repo_lint: false,
  full: false,
};

// Docker-only compiler inputs are outside the module fingerprint. ARM MUST
// compile them before merge, including when the diff base is unavailable.
export function canReuseArmDockerWasm(paths) {
  return (
    paths !== null &&
    !paths.some(
      (path) =>
        path === "packages/rom-weaver-webapp/Dockerfile" ||
        path === ".dockerignore" ||
        path.startsWith(".github/"),
    )
  );
}

// Only ordinary pull requests narrow checks; missing event names and release pull requests preserve the full selected matrix.
// The event default MUST agree with scripts/ci/cli-platform-matrix.mjs.
export function classifyChanges(paths, all = false, eventName = undefined, headRef = undefined) {
  const result = { ...EMPTY };
  if (all || isReleasePullRequest(eventName, headRef)) {
    return Object.fromEntries(Object.keys(result).map((key) => [key, true]));
  }

  // Whether any path other than published guide Markdown selected the webapp.
  // `webapp` is cleared per path so each path's own selection is visible.
  let browserInput = false;
  for (const path of paths.filter(Boolean)) {
    const webappBefore = result.webapp;
    result.webapp = false;
    if (
      /^\.github\/workflows\/(?:ci|coverage)\.yml$/.test(path) ||
      /^\.github\/actions\/(?:setup-build-env|wasm-cache)\//.test(path) ||
      path.startsWith(".cargo/") ||
      path === ".config/lefthook.yml" ||
      path === ".config/mise.toml" ||
      FULL_CI_PLUMBING.has(path) ||
      (path.startsWith("scripts/ci/") &&
        !path.endsWith(".test.mjs") &&
        !REPO_LINT_CI_HELPERS.has(path) &&
        path !== "scripts/ci/cli-platform-matrix.mjs" &&
        path !== "scripts/ci/docker-matrix.mjs" &&
        path !== "scripts/ci/docker-smoke.mjs")
    )
      result.full = true;

    if (path.startsWith("crates/")) {
      result.rust = true;
      if (isWasmCompilerInput(path)) {
        result.webapp = true;
        result.wasm_runtime = true;
        // Pull requests already compile the release CLI directly. Rebuild its
        // source Docker image after merge for nightly, or when image/toolchain
        // inputs below changed and the Docker path itself needs proving.
        if (eventName !== "pull_request") result.docker_cli = true;
      }
    }

    if (
      /^(?:Cargo\.toml|Cargo\.lock|\.config\/deny\.toml|package\.json|package-lock\.json)$/.test(
        path,
      ) ||
      /^\.github\/workflows\/(?:npm-publish|release)\.yml$/.test(path) ||
      path.startsWith(".github/actions/build-cli-platform/") ||
      path === ".github/cli-platforms.json" ||
      path.startsWith("packages/rom-weaver-cli-platforms/") ||
      /^(?:bin\/rom-weaver\.mjs|install\.(?:sh|ps1))$/.test(path) ||
      /^(?:scripts\/(?:build-identify-index|check-thread-guards|check-whitespace|ensure-identify-data|gen-third-party-licenses|prepare-npm-platform-package|sync-version|vendored-pathspecs|verify-cli-platform)\.mjs|scripts\/wasm\/)/.test(
        path,
      )
    ) {
      result.rust = true;
      result.webapp = true;
    }

    if (
      path === "scripts/ci/cli-platform-matrix.mjs" ||
      path === "packages/rom-weaver-alias/package.json" ||
      // Rust tests read these: patches vcdiff and cli_smoke trim fixtures, and
      // the CLI reference paragraph cli_smoke compares with `extract --help`.
      path.startsWith("tests/fixtures/") ||
      path === "docs/reference/cli.md"
    )
      result.rust = true;
    if (path.startsWith("fuzz/")) {
      result.rust_lint = true;
      result.fuzz = true;
    }
    if (path === "scripts/ci/docker-matrix.mjs" || path === "scripts/ci/docker-smoke.mjs") {
      result.webapp = true;
      result.docker_cli = true;
      result.docker_webapp = true;
      result.docker_cli_arm64 = true;
      result.docker_webapp_arm64 = true;
    }

    if (
      path.startsWith("packages/rom-weaver-webapp/") ||
      PUBLISHED_DOCS.has(path) ||
      DOCS_WEBAPP_ASSET.test(path) ||
      // Icon-master notes; the masters `brand:check` renders are under the
      // webapp package, and the hygiene test in `webapp-static` guards this tree.
      path.startsWith("design/") ||
      path === "package.json" ||
      path === "package-lock.json" ||
      // CI helper tests run in repo-lint. Their implementation does not enter
      // the webapp bundle, and the classifier keeps selection plumbing above
      // fail-open. Leaf scripts run their tests in repo-lint too.
      (/^scripts\/(?!ci\/).*\.mjs$/.test(path) && !ROOT_LEAF_SCRIPT.test(path)) ||
      path.startsWith("scripts/wasm/") ||
      path === ".dockerignore" ||
      path === "docker-compose.yml" ||
      path === ".github/workflows/docker-publish.yml"
    )
      result.webapp = true;

    // Every path the `webapp-wasm-browser` suite can observe. The source and
    // fixture entries are not a judgement call: `wasm-runtime-coverage.test.mjs`
    // walks the suite's own import and `new URL(..., import.meta.url)` graph and
    // fails if anything reachable from it is not selected here.
    if (
      /^(?:Cargo\.toml|Cargo\.lock|package\.json|package-lock\.json)$/.test(path) ||
      path.startsWith("scripts/wasm/") ||
      path.startsWith("tests/fixtures/") ||
      WASM_RUNTIME_SUPPORT.has(path) ||
      path.startsWith("crates/rom-weaver-patches/tests/fixtures/hdiffpatch/") ||
      /^packages\/rom-weaver-webapp\/(?:package(?:-lock)?\.json|vitest(?:\.config\.base|(?:\.wasm)?\.browser\.config)\.mjs)$/.test(
        path,
      ) ||
      /^packages\/rom-weaver-webapp\/src\/(?:lib\/(?:logging\.ts|runtime)|platform|storage|types|wasm|workers)(?:\/|$)/.test(
        path,
      ) ||
      /^packages\/rom-weaver-webapp\/tests\/(?:fixtures|wasm)(?:\/|$)/.test(path)
    )
      result.wasm_runtime = true;

    if (
      /^(?:Cargo\.toml|Cargo\.lock)$/.test(path) ||
      /^crates\/[^/]+\/Cargo\.toml$/.test(path) ||
      path === "package.json" ||
      path === "package-lock.json" ||
      path === "packages/rom-weaver-webapp/package.json" ||
      path === "packages/rom-weaver-webapp/package-lock.json"
    )
      result.security = true;

    // The CLI image pins its own `rust:` builder tag, independent of the
    // toolchain `cli-platforms` compiles with, so a manifest or lock change can
    // break this image and nothing else. It is still only worth one
    // architecture on a pull request - see `docker_cli_arm64` above.
    if (
      path === "Dockerfile" ||
      path.startsWith(".cargo/") ||
      /^(?:Cargo\.toml|Cargo\.lock)$/.test(path)
    ) {
      result.docker_cli = true;
      if (path === "Dockerfile") result.docker_cli_arm64 = true;
    }
    if (
      path === "packages/rom-weaver-webapp/Dockerfile" ||
      path === "packages/rom-weaver-webapp/sws.toml" ||
      path === "docs/hosting/self-hosting.md" ||
      path === "packages/rom-weaver-webapp/scripts/compress-static-assets.mjs"
    ) {
      result.docker_webapp = true;
      // The webapp image pins an arm64 WASI SDK and binaryen by sha256 that no
      // amd64 build ever resolves, so its Dockerfile is exactly the file whose
      // arm64 leg has to run.
      if (path === "packages/rom-weaver-webapp/Dockerfile") result.docker_webapp_arm64 = true;
    }
    if (
      path === ".dockerignore" ||
      path === "docker-compose.yml" ||
      path === ".github/workflows/docker-publish.yml" ||
      // Both images are built and tagged through these, so an edit to either
      // has to be exercised on an image before it reaches a release.
      /^\.github\/actions\/docker-(?:build-arch|manifest)\//.test(path)
    ) {
      result.docker_cli = true;
      result.docker_webapp = true;
      // These decide the build context, the exporter, and the per-arch cache
      // ref, all of which are architecture-specific.
      result.docker_cli_arm64 = true;
      result.docker_webapp_arm64 = true;
    }

    // `repo-lint` lints every tracked file of these kinds rather than the diff,
    // so this selects the whole job, not individual files: whatever actionlint
    // reads (the workflows, the composite actions, `.github` YAML at any depth
    // - the shell `case` globs this replaced matched across `/`), any shell
    // script, any Node.js script, any Markdown file, any Dockerfile, and
    // hadolint's config.
    if (
      path.startsWith(".github/workflows/") ||
      path.startsWith(".github/actions/") ||
      /^\.github\/.*\.(?:yml|yaml)$/.test(path) ||
      path === ".config/hadolint.yaml" ||
      path === ".oxlintrc.json" ||
      path === "package.json" ||
      path === "package-lock.json" ||
      /(?:Dockerfile(?:\.|$))/.test(path) ||
      /\.(?:cjs|js|md|mjs|sh)$/.test(path)
    )
      result.repo_lint = true;

    if (result.webapp && !PUBLISHED_DOCS.has(path)) browserInput = true;
    if (isLighthouseInput(path)) result.lighthouse = true;
    result.webapp ||= webappBefore;
  }

  if (result.full) {
    result.rust = true;
    result.webapp = true;
    result.wasm_runtime = true;
    result.security = true;
    result.docker_cli = true;
    result.docker_webapp = true;
    // Fail open all the way down: a change to CI or the toolchain can break one
    // architecture and not the other, so this narrows nothing either.
    result.docker_cli_arm64 = true;
    result.docker_webapp_arm64 = true;
    result.repo_lint = true;
    result.fuzz = true;
  }
  // Every runtime test consumes the production module and webapp dependencies.
  if (result.wasm_runtime) result.webapp = true;
  if (result.rust) result.rust_lint = true;
  if (result.full || eventName !== "pull_request") result.lighthouse = true;
  result.webapp_browser =
    result.webapp &&
    (eventName !== "pull_request" || browserInput || result.wasm_runtime || result.full);

  // Only a pull request narrows an image to one architecture. Every other event
  // - a push to main, whose legs feed the `nightly` manifest lists, and a
  // dispatch - builds every architecture of whatever it selected at all.
  if (eventName !== "pull_request") {
    result.docker_cli_arm64 = result.docker_cli;
    result.docker_webapp_arm64 = result.docker_webapp;
  }

  // The prebuilt smoke requires a webapp bundle and an image change on ordinary
  // pull requests; other events also select it for webapp changes to publish nightly.
  result.docker_prebuilt = result.webapp && (eventName !== "pull_request" || result.docker_webapp);
  return result;
}

// Which run-wide coverage tiers this event gets.
// `fullMatrix` (macOS/arm64 Docker legs, prebuilt images) stays on for every
// event but an ordinary pull request, because main's legs feed the nightly
// manifest lists. `fullNative` - the eight non-Linux CLI targets, macOS Rust,
// and the arm64 CLI runtime - also leaves main pushes: the nightly schedule
// and the release pull request cover it before anything ships, which keeps
// four 15-19 minute Windows builds per merge out of the shared runner pool.
// An absent event keeps both, the same fail-open default as the classifier.
export function coverageTiers(eventName, headRef = undefined) {
  const releasePullRequest = isReleasePullRequest(eventName, headRef);
  return {
    fullMatrix: eventName !== "pull_request" || releasePullRequest,
    fullNative: (eventName !== "pull_request" && eventName !== "push") || releasePullRequest,
  };
}

// The nightly schedule exists only to build the native targets main pushes
// skip. It keeps the Rust selection of whatever changed since the last green
// nightly and drops everything else: those stacks already ran on each push.
export function scheduledSelection(result) {
  return { ...EMPTY, rust: result.rust, rust_lint: result.rust };
}

export function formatChanges(result) {
  return `${Object.entries(result)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

export function main(argv = process.argv.slice(2), readStdin = () => readFileSync(0, "utf8")) {
  // --all MUST avoid reading stdin so it cannot block on an interactive terminal.
  const all = argv[0] === "--all";
  process.stdout.write(formatChanges(classifyChanges(all ? [] : readStdin().split(/\r?\n/), all)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
