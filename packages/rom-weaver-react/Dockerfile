# Minimal two-stage image for the RomWeaver webapp.
#
# The wasm module (src/wasm/rom-weaver-app.wasm[.br]) is gitignored and built
# out-of-band — run `mise run build-wasm` from the repo root BEFORE building
# this image. The build below only bundles the existing wasm and serves the
# static SPA; it does not compile Rust.

# ---- build stage -----------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

# Don't pull Playwright browsers during `npm ci` — they aren't needed to build.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Fail fast with a clear message if the prebuilt wasm is missing.
RUN test -f src/wasm/rom-weaver-app.wasm || ( \
      echo "ERROR: src/wasm/rom-weaver-app.wasm is missing." >&2; \
      echo "Build it first from the repo root: mise run build-wasm" >&2; \
      exit 1 )

RUN npm run build

# ---- runtime stage ---------------------------------------------------------
# static-web-server: a ~5 MB single static binary. Serves the prebuilt *.br
# assets, emits the cross-origin-isolation headers, and runs as non-root (sws).
# HTTPS is terminated by your reverse proxy (see docker-compose.yml).
FROM ghcr.io/static-web-server/static-web-server:2-alpine AS runtime
COPY sws.toml /etc/sws.toml
COPY --from=builder /app/dist /srv
EXPOSE 8080
# 127.0.0.1 (not localhost): SWS binds IPv4, but localhost resolves to ::1 first.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["--config-file", "/etc/sws.toml"]
