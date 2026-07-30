#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { DOC_SOURCES } from "../../packages/rom-weaver-webapp/src/webapp/docs-routing.mjs";
import { isReleasePullRequest } from "./release-pr.mjs";

// Editing a published guide changes the built site, so it has to rebuild the
// webapp. Taking the set from the route table rather than a folder prefix keeps
// that exact: `docs/development/` holds both published pages and maintainer
// notes, and only the published ones belong in the trigger.
const PUBLISHED_DOCS = new Set(DOC_SOURCES.map((source) => `docs/${source.file}`));

const EMPTY = {
  rust: false,
  webapp: false,
  wasm_runtime: false,
  security: false,
  docker_cli: false,
  docker_webapp: false,
  // "Also build this image's arm64 leg." A pull request that changed only an
  // image's compile inputs - a lock bump, an arch-neutral runtime config - gets
  // the amd64 leg alone, because the second architecture is a second full
  // release compile and cannot fail for a reason the first one did not.
  // Whatever an architecture can break on its own lives in the image
  // definition, so editing one still builds both. Every non-pull-request event
  // builds both regardless; see the tail of `classifyChanges`.
  docker_cli_arm64: false,
  docker_webapp_arm64: false,
  // The webapp prebuilt smoke: it wraps whatever bundle `webapp-static` built,
  // so on a pull request it can only fail for an image reason. Derived at the
  // tail of `classifyChanges` rather than per path.
  docker_prebuilt: false,
  repo_lint: false,
  full: false,
};

// Test, bench, and example sources are compiled by the Rust test jobs and by
// nothing else: they never enter the production WASM module or the release CLI
// binary. `.github/actions/wasm-cache` excludes the same set from its cache key
// for that reason, so selecting the webapp stack for them only buys a guaranteed
// cache hit followed by browser jobs that cannot observe the edit. Keep the
// two lists identical - note `.*` rather than `[^/]*` under src/, because the
// shell globs this replaced matched across directory separators.
//
// One carve-out, applied by the `wasm_runtime` block below rather than here:
// the WASM browser suite reads a handful of Rust fixture trees directly, so
// those paths do select webapp work. `wasm-runtime-coverage.test.mjs` derives
// that set from the suite's own imports, so it cannot drift.
const isReleaseInput = (path) =>
  !/(?:\/tests\/|\/test\/|\/examples\/|\/benches\/|\/src\/test[^/]*\.rs$|\/src\/.*\/test[^/]*\.rs$)/.test(
    path,
  );

// `eventName` only ever narrows, and only for `pull_request`; an absent one
// selects everything a push would. `scripts/ci/cli-platform-matrix.mjs` defaults
// the same way for the same reason: a caller that forgets to pass the event has
// to lose time, not coverage.
//
// `headRef` is the one thing that can un-narrow a pull request: the release
// pull request carries main's tree plus version strings, so classifying its diff
// would hand the commit that ships less coverage than the commit it was cut
// from. Its cost is that every refresh of that pull request - and each dispatch
// pushes metadata-sync and screenshot commits - re-runs the whole matrix.
export function classifyChanges(paths, all = false, eventName = undefined, headRef = undefined) {
  const result = { ...EMPTY };
  if (all || isReleasePullRequest(eventName, headRef)) {
    return Object.fromEntries(Object.keys(result).map((key) => [key, true]));
  }

  for (const path of paths.filter(Boolean)) {
    if (
      /^\.github\/workflows\/(?:ci|coverage)\.yml$/.test(path) ||
      /^\.github\/actions\/(?:setup-build-env|wasm-cache)\//.test(path) ||
      /^\.cargo\//.test(path) ||
      path === ".config/mise.toml" ||
      /^scripts\/ci\//.test(path)
    )
      result.full = true;

    if (path.startsWith("crates/")) {
      result.rust = true;
      if (isReleaseInput(path)) {
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
      /^\.github\/actions\/build-cli-platform\//.test(path) ||
      path === ".github/cli-platforms.json" ||
      /^packages\/rom-weaver-cli-platforms\//.test(path) ||
      /^(?:bin\/rom-weaver\.mjs|install\.(?:sh|ps1))$/.test(path) ||
      /^(?:scripts\/(?:check-thread-guards|check-whitespace|gen-third-party-licenses|prepare-npm-platform-package|sync-version|vendored-pathspecs|verify-cli-platform)\.mjs|scripts\/wasm\/)/.test(
        path,
      )
    ) {
      result.rust = true;
      result.webapp = true;
    }

    if (
      path.startsWith("packages/rom-weaver-webapp/") ||
      PUBLISHED_DOCS.has(path) ||
      path === "package.json" ||
      path === "package-lock.json" ||
      /^scripts\/.*\.mjs$/.test(path) ||
      /^scripts\/wasm\//.test(path) ||
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
      /^scripts\/wasm\//.test(path) ||
      /^tests\/fixtures\//.test(path) ||
      /^crates\/rom-weaver-patches\/tests\/fixtures\/hdiffpatch\//.test(path) ||
      /^packages\/rom-weaver-webapp\/(?:package(?:-lock)?\.json|vitest(?:\.config\.base|(?:\.wasm)?\.browser\.config)\.mjs)$/.test(
        path,
      ) ||
      /^packages\/rom-weaver-webapp\/src\/(?:lib\/runtime|platform|storage|types|wasm|workers)(?:\/|$)/.test(
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
      /^\.cargo\//.test(path) ||
      /^(?:Cargo\.toml|Cargo\.lock)$/.test(path)
    ) {
      result.docker_cli = true;
      if (path === "Dockerfile") result.docker_cli_arm64 = true;
    }
    if (
      path === "packages/rom-weaver-webapp/Dockerfile" ||
      path === "packages/rom-weaver-webapp/sws.toml" ||
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
      /^\.github\/workflows\//.test(path) ||
      /^\.github\/actions\//.test(path) ||
      /^\.github\/.*\.(?:yml|yaml)$/.test(path) ||
      path === ".config/hadolint.yaml" ||
      /(?:Dockerfile(?:\.|$))/.test(path) ||
      /\.(?:md|sh|mjs)$/.test(path)
    )
      result.repo_lint = true;
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
  }
  // Every runtime test consumes the production module and webapp dependencies.
  if (result.wasm_runtime) result.webapp = true;

  // Only a pull request narrows an image to one architecture. Every other event
  // - a push to main, whose legs feed the `nightly` manifest lists, and a
  // dispatch - builds every architecture of whatever it selected at all.
  if (eventName !== "pull_request") {
    result.docker_cli_arm64 = result.docker_cli;
    result.docker_webapp_arm64 = result.docker_webapp;
  }

  // The prebuilt smoke needs a bundle, so it can never outrun the webapp stack.
  // On a pull request it additionally needs an image-side reason: it copies
  // `webapp-static`'s artifact into the image and runs no builder stage, so
  // which bundle it copied cannot change the outcome. On main it is also the
  // only publisher of the webapp `nightly` image, so the webapp stack alone
  // selects it there.
  result.docker_prebuilt =
    result.webapp && (eventName !== "pull_request" || result.docker_webapp);
  return result;
}

export function formatChanges(result) {
  return `${Object.entries(result)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

export function main(argv = process.argv.slice(2), readStdin = () => readFileSync(0, "utf8")) {
  // stdin is read lazily: as a default parameter it was consumed even for
  // --all, which blocks forever on an interactive terminal.
  const all = argv[0] === "--all";
  process.stdout.write(formatChanges(classifyChanges(all ? [] : readStdin().split(/\r?\n/), all)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
