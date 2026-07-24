#!/usr/bin/env bash
set -euo pipefail

rust=false
webapp=false
security=false
docker_cli=false
docker_webapp=false
repo_lint=false
full=false

# Test, bench, and example sources are compiled by the Rust test jobs and by
# nothing else: they never enter the production WASM module or the release CLI
# binary. `.github/actions/wasm-cache` excludes the same set from its cache key
# for that reason, so selecting the webapp stack for them only buys a guaranteed
# cache hit followed by four browser jobs that cannot observe the edit. Keep the
# two lists identical.
is_release_input() {
  case "$1" in
    */tests/* | */test/* | */examples/* | */benches/* | */src/test*.rs | */src/*/test*.rs)
      return 1
      ;;
  esac
  return 0
}

if [[ "${1:-}" == "--all" ]]; then
  rust=true
  webapp=true
  security=true
  docker_cli=true
  docker_webapp=true
  repo_lint=true
  full=true
else
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue

    case "$path" in
      .github/workflows/ci.yml | .github/workflows/coverage.yml | \
        .github/actions/setup-build-env/* | .github/actions/wasm-cache/* | \
        .cargo/* | .mise.toml | scripts/ci/*)
        full=true
        ;;
    esac

    # Rust sources also drive the WASM module and the CLI image - except for the
    # test-only trees above, which drive neither.
    case "$path" in
      crates/*)
        rust=true
        if is_release_input "$path"; then
          webapp=true
          docker_cli=true
        fi
        ;;
    esac

    case "$path" in
      Cargo.toml | Cargo.lock | .config/deny.toml | package.json | package-lock.json | \
        .github/workflows/npm-publish.yml | .github/workflows/release.yml | \
        .github/actions/build-cli-platform/* | .github/cli-platforms.json | \
        packages/rom-weaver-cli-platforms/* | bin/rom-weaver.mjs | install.sh | install.ps1 | \
        scripts/check-thread-guards.sh | scripts/check-whitespace.sh | \
        scripts/gen-third-party-licenses.mjs | \
        scripts/prepare-npm-platform-package.mjs | scripts/sync-version.mjs | \
        scripts/vendored-pathspecs.sh | scripts/verify-cli-platform.mjs | scripts/wasm/*)
        rust=true
        webapp=true
        ;;
    esac

    case "$path" in
      packages/rom-weaver-webapp/* | package.json | package-lock.json | \
        scripts/*.mjs | scripts/wasm/* | .dockerignore | \
        docker-compose.yml | .github/workflows/docker-publish.yml)
        webapp=true
        ;;
    esac

    case "$path" in
      Dockerfile | .cargo/* | Cargo.toml | Cargo.lock)
        docker_cli=true
        ;;
      packages/rom-weaver-webapp/Dockerfile | packages/rom-weaver-webapp/sws.toml | \
        packages/rom-weaver-webapp/scripts/compress-static-assets.mjs)
        docker_webapp=true
        ;;
      .dockerignore | docker-compose.yml | .github/workflows/docker-publish.yml)
        docker_cli=true
        docker_webapp=true
        ;;
    esac

    case "$path" in
      Cargo.toml | Cargo.lock | crates/*/Cargo.toml | package.json | package-lock.json | \
        packages/rom-weaver-webapp/package.json | packages/rom-weaver-webapp/package-lock.json)
        security=true
        ;;
    esac

    # `repo-lint` lints every tracked file of these kinds rather than the diff,
    # so this selects the whole job, not individual files: whatever actionlint
    # reads (the workflows, the composite actions, its own config), any shell
    # script, any Dockerfile, and hadolint's config.
    case "$path" in
      .github/workflows/* | .github/actions/* | .github/*.yml | .github/*.yaml | \
        .config/hadolint.yaml | *.sh | *Dockerfile | *Dockerfile.*)
        repo_lint=true
        ;;
    esac
  done
fi

if [[ "$full" == true ]]; then
  rust=true
  webapp=true
  security=true
  docker_cli=true
  docker_webapp=true
  repo_lint=true
fi

printf 'rust=%s\nwebapp=%s\nsecurity=%s\ndocker_cli=%s\ndocker_webapp=%s\nrepo_lint=%s\nfull=%s\n' \
  "$rust" "$webapp" "$security" "$docker_cli" "$docker_webapp" "$repo_lint" "$full"
