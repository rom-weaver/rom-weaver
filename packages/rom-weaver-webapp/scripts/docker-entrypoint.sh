#!/bin/sh
set -eu

generated_cert=/tmp/rom-weaver-tls/cert.pem
generated_key=/tmp/rom-weaver-tls/key.pem

require_tls_files() {
  if [ ! -s "$1" ] || [ ! -r "$1" ] || [ ! -s "$2" ] || [ ! -r "$2" ]; then
    echo "HTTPS_CERT and HTTPS_KEY must point to readable certificate files" >&2
    exit 66
  fi
}

# The build stamps 404.html with `<base href="/">` and root-relative links, so under a
# reverse-proxy sub-path (which the proxy strips before this server sees it) the page's
# assets and links would leave the prefix. BASE_PATH names that prefix; a copy of the page
# re-rooted on it goes to a writable directory and replaces sws's default 404 page, because
# the image runs as non-root and /srv stays read-only.
base_path=${BASE_PATH:-/}
rerooted_404_dir=/tmp/rom-weaver-404

case $base_path in
  /) ;;
  /*/) ;;
  *)
    echo "BASE_PATH must start and end with /, for example /rom-weaver/" >&2
    exit 64
    ;;
esac
case $base_path in
  *[!A-Za-z0-9._~/-]* | *//* | */./* | */../*)
    echo "BASE_PATH may only contain letters, digits, . _ ~ - and single / separators" >&2
    exit 64
    ;;
esac

if [ "$base_path" != "/" ]; then
  mkdir -p "$rerooted_404_dir"
  sed -e "s#href=\"/\([^/\"]\)#href=\"${base_path}\1#g" -e "s#href=\"/\"#href=\"${base_path}\"#g" \
    /srv/404.html >"$rerooted_404_dir/404.html"
  if ! grep -qF "<base href=\"$base_path\" />" "$rerooted_404_dir/404.html"; then
    echo "BASE_PATH could not be applied: /srv/404.html has no <base href=\"/\" /> to re-root" >&2
    exit 70
  fi
  set -- "$@" --page404 "$rerooted_404_dir/404.html"
fi

if [ -n "${HTTPS_PORT:-}" ]; then
  cert_path=${HTTPS_CERT:-}
  key_path=${HTTPS_KEY:-}

  if [ -n "$cert_path$key_path" ]; then
    if [ -z "$cert_path" ] || [ -z "$key_path" ]; then
      echo "Set both HTTPS_CERT and HTTPS_KEY, or set neither to generate a test certificate" >&2
      exit 64
    fi
    require_tls_files "$cert_path" "$key_path"
  elif [ -s /certs/fullchain.pem ] || [ -s /certs/privkey.pem ]; then
    cert_path=/certs/fullchain.pem
    key_path=/certs/privkey.pem
    require_tls_files "$cert_path" "$key_path"
  else
    umask 077
    mkdir -p /tmp/rom-weaver-tls
    if [ ! -s "$generated_cert" ] || [ ! -s "$generated_key" ]; then
      openssl req -x509 -newkey rsa:2048 -nodes -days 7 \
        -keyout "$generated_key" \
        -out "$generated_cert" \
        -subj "/CN=localhost" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"
    fi
    cert_path=$generated_cert
    key_path=$generated_key
  fi

  exec static-web-server "$@" \
    --port 8080 \
    --http2=true \
    --http2-tls-cert "$cert_path" \
    --http2-tls-key "$key_path"
fi

exec static-web-server "$@"
