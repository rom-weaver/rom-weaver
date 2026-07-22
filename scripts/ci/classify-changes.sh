#!/usr/bin/env bash
set -euo pipefail

rust=false
webapp=false
security=false
docker_cli=false
docker_webapp=false
full=false

if [[ "${1:-}" == "--all" ]]; then
  rust=true
  webapp=true
  security=true
  docker_cli=true
  docker_webapp=true
  full=true
else
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue

    case "$path" in
      .github/workflows/ci.yml | .github/workflows/coverage.yml | \
        .github/actions/setup-build-env/* | .github/actions/wasm-cache/* | \
        .cargo/* | .mise.toml | scripts/ci/classify-changes.sh | \
        scripts/ci/mise-disable-tools.sh | scripts/ci/resolve-wasm-run.sh)
        full=true
        ;;
    esac

    case "$path" in
      crates/* | Cargo.toml | Cargo.lock | deny.toml | \
        scripts/check-thread-guards.sh | scripts/gen-third-party-licenses.mjs | \
        scripts/vendored-pathspecs.sh | scripts/wasm/*)
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
      Dockerfile | .cargo/* | Cargo.toml | Cargo.lock | crates/*)
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
  done
fi

if [[ "$full" == true ]]; then
  rust=true
  webapp=true
  security=true
  docker_cli=true
  docker_webapp=true
fi

printf 'rust=%s\nwebapp=%s\nsecurity=%s\ndocker_cli=%s\ndocker_webapp=%s\nfull=%s\n' \
  "$rust" "$webapp" "$security" "$docker_cli" "$docker_webapp" "$full"
