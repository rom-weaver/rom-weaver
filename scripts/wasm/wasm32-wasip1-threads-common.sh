# Sourced fragment, not an executable script - no shebang to infer the dialect
# from. The cc/cxx wrappers that source it are bash, and it uses [[ ]] and
# arrays, so tell shellcheck which shell to check it against.
# shellcheck shell=bash

base=()
if [[ -n "$SYSROOT" ]]; then
  base+=(--sysroot="$SYSROOT")
fi

normalized=()
has_target=0
expect_target_value=0
for arg in "$@"; do
  if [[ "$expect_target_value" -eq 1 ]]; then
    case "$arg" in
      wasm32-wasi|wasm32-wasi-threads)
        arg="wasm32-wasip1-threads"
        ;;
    esac
    normalized+=("$arg")
    has_target=1
    expect_target_value=0
    continue
  fi

  case "$arg" in
    --target|-target)
      normalized+=("$arg")
      expect_target_value=1
      continue
      ;;
    --target=wasm32-wasi|--target=wasm32-wasi-threads|-target=wasm32-wasi|-target=wasm32-wasi-threads)
      normalized+=("${arg%%=*}=wasm32-wasip1-threads")
      has_target=1
      continue
      ;;
    --target=*|-target=*)
      has_target=1
      normalized+=("$arg")
      continue
      ;;
  esac
  normalized+=("$arg")
done

if [[ "$has_target" -eq 0 ]]; then
  base+=(--target=wasm32-wasip1-threads)
fi
