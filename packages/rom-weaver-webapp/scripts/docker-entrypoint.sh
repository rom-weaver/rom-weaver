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
