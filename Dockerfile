# Run as a UID accepted by bind-mounted directories; see docs/how-to/install-cli.md.
# BINARY=prebuilt reuses release binaries from prebuilt/<arch>/rom-weaver.
ARG BINARY=source
ARG IDENTIFY_DATA=source
ARG DOCS=source

FROM node:24-bookworm AS identify-data-source
WORKDIR /src
RUN apt-get update \
    && apt-get install --yes --no-install-recommends curl unzip zstd \
    && rm -rf /var/lib/apt/lists/*
# node-tar reads the identify source archives, so the root dependencies are
# installed before the build runs.
COPY package.json package-lock.json /src/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY scripts /src/scripts
RUN node scripts/ensure-identify-data.mjs \
    && node scripts/build-identify-release-data.mjs \
    && cp -a target/identify-release/share /share

FROM scratch AS identify-data-prebuilt
COPY target/identify-release/share /share

# hadolint ignore=DL3006
FROM identify-data-${IDENTIFY_DATA} AS identify-data

FROM rust:1.97.1-bookworm AS builder
ARG TARGETARCH
WORKDIR /src

RUN apt-get update \
    && apt-get install --yes --no-install-recommends clang cmake libclang-dev ninja-build pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# JWasm enables the x86-64 SDK decode loop; arm64 uses clang's assembler.
RUN if [ "${TARGETARCH}" = "amd64" ]; then scripts/install-jwasm.sh; fi
# Cache mounts carry the registry and compiled dependencies across local
# rebuilds; `COPY . .` above still invalidates this layer on any source change,
# but cargo then rebuilds only the workspace crates (measured 1m55s -> 1m08s).
# As in the webapp image they are local-only - BuildKit exports a cache mount to
# no cache backend, so CI still pays a cold compile.
#
# `CARGO_HOME` is /usr/local/cargo in the official rust image, not /root/.cargo.
# A cache mount is absent from the resulting layer, so the binary has to leave
# /src/target inside this same RUN or the runtime stage finds nothing to copy.
# The registry is arch-neutral; the target dir is not, so it is keyed by arch to
# keep a future multi-arch build from sharing one locked directory.
RUN --mount=type=cache,id=cli-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=cli-cargo-target-${TARGETARCH},target=/src/target,sharing=locked \
    cargo build --locked --release --package rom-weaver-cli \
    && cargo run --locked --release -p rom-weaver-cli --example generate_manpages -- --write \
    && install -D --mode 0755 target/release/rom-weaver /out/rom-weaver

FROM scratch AS docs-source
COPY --from=builder /src/docs/man /share/man/man1
COPY --from=builder /src/docs/completions /share/completions

FROM scratch AS docs-prebuilt
COPY docs/man /share/man/man1
COPY docs/completions /share/completions

FROM debian:trixie-slim AS docs-none
RUN install --directory /share/man/man1 /share/completions

# hadolint ignore=DL3006
FROM docs-${DOCS} AS docs

FROM scratch AS binary-source
COPY --from=builder /out/rom-weaver /rom-weaver

FROM scratch AS binary-prebuilt
ARG TARGETARCH
COPY prebuilt/${TARGETARCH}/rom-weaver /rom-weaver

# DL3006 reads this as an untagged base image. `binary-source` and
# `binary-prebuilt` are both defined right above, and BINARY has a default, so
# it can only ever resolve to a local stage - `docker build --check` agrees.
# hadolint ignore=DL3006
FROM binary-${BINARY} AS binary

# Left to `WORKDIR`, /work is created 0755 owned by the image's own user, so an
# overridden `--user` cannot write there when nothing is mounted over it.
# Sticky-and-writable (the /tmp convention) keeps it usable for any uid without
# letting one delete another's files.
#
# The runtime below has no shell to mkdir with, and neither `COPY /work /work`
# nor `COPY --chmod=1777` reproduces the mode: a directory named as the COPY
# source contributes only its contents, so the destination is recreated 0755,
# and `--chmod` takes the low nine bits only, silently dropping the sticky bit.
# Copying the *parent* preserves the mode of everything inside it.
FROM debian:trixie-slim AS workdir
RUN install --directory --mode 1777 /rootfs/work

# distroless over debian:trixie-slim: same trixie glibc 2.41 (see below), but
# ~20 MB smaller compressed because it carries no shell, package manager or
# base userland. ca-certificates and a nonroot user (uid 65532) are built in,
# so the apt/useradd layer this replaced is gone too. The trade is that
# `docker run --entrypoint sh` no longer works for poking around inside.
#
# -cc, not -base: it adds libgcc/libstdc++, which the cmake-built C deps
# (libarchive) linked into the binary expect.
#
# debian13/trixie, not bookworm: the prebuilt binary is linked against the glibc
# of the ubuntu-24.04 runner npm-publish builds on (2.39), which bookworm's 2.36
# cannot load. trixie ships 2.41, so one runtime accepts both halves of the
# switch above and the image stays a single moving target.
FROM gcr.io/distroless/cc-debian13:nonroot AS runtime

# `--chmod` is not redundant: GitHub Actions artifacts do not round-trip the
# executable bit, so the prebuilt half arrives 0644. Setting it here rather than
# in a later `RUN chmod` keeps the 5 MB binary out of a second layer.
COPY --from=binary --chmod=0755 /rom-weaver /usr/local/bin/rom-weaver
COPY --from=identify-data /share /usr/local/share
COPY --from=docs /share /usr/local/share
COPY --from=workdir /rootfs /

WORKDIR /work
ENTRYPOINT ["rom-weaver"]
