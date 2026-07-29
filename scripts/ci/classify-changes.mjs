#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { DOC_SOURCES } from "../../packages/rom-weaver-webapp/src/webapp/docs-routing.mjs";

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
const isReleaseInput = (path) =>
  !/(?:\/tests\/|\/test\/|\/examples\/|\/benches\/|\/src\/test[^/]*\.rs$|\/src\/.*\/test[^/]*\.rs$)/.test(
    path,
  );

export function classifyChanges(paths, all = false, eventName = "pull_request") {
  const result = { ...EMPTY };
  if (all) {
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
      path.startsWith("tests/fixtures/") ||
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

    if (
      /^(?:Cargo\.toml|Cargo\.lock|package\.json|package-lock\.json)$/.test(path) ||
      /^scripts\/wasm\//.test(path) ||
      /^tests\/fixtures\//.test(path) ||
      /^crates\/rom-weaver-patches\/tests\/fixtures\/hdiffpatch\//.test(path) ||
      /^packages\/rom-weaver-webapp\/(?:package(?:-lock)?\.json|vitest(?:\.config\.base|(?:\.wasm)?\.browser\.config)\.mjs)$/.test(
        path,
      ) ||
      /^packages\/rom-weaver-webapp\/src\/(?:lib\/runtime|platform\/browser|storage|types|wasm|workers)(?:\/|$)/.test(
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

    if (
      path === "Dockerfile" ||
      /^\.cargo\//.test(path) ||
      /^(?:Cargo\.toml|Cargo\.lock)$/.test(path)
    ) {
      result.docker_cli = true;
    }
    if (
      path === "packages/rom-weaver-webapp/Dockerfile" ||
      path === "packages/rom-weaver-webapp/sws.toml" ||
      path === "packages/rom-weaver-webapp/scripts/compress-static-assets.mjs"
    )
      result.docker_webapp = true;
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
    result.repo_lint = true;
  }
  // Every runtime test consumes the production module and webapp dependencies.
  if (result.wasm_runtime) result.webapp = true;
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
