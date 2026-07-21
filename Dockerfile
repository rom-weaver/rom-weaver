# Native Linux CLI image. Mount input/output directories and pass normal
# rom-weaver arguments after the image name.
#
# Bind-mounted files keep their host ownership, so anything the container writes
# must run as an id the host directory accepts. Pass `--user "$(id -u):$(id -g)"`
# for that; the image needs no passwd entry for it because rom-weaver reads no
# home directory or user config. See docs/cli.md ("Run in Docker").
FROM rust:1.95-bookworm AS builder
ARG TARGETARCH
WORKDIR /src

RUN apt-get update \
    && apt-get install --yes --no-install-recommends clang cmake libclang-dev ninja-build pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY . .
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
    && install -D --mode 0755 target/release/rom-weaver /out/rom-weaver

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 rom-weaver

COPY --from=builder /out/rom-weaver /usr/local/bin/rom-weaver

# Left to `WORKDIR`, /work is created 0755 owned by the image's own user, so an
# overridden `--user` cannot write there when nothing is mounted over it.
# Sticky-and-writable (the /tmp convention) keeps it usable for any uid without
# letting one delete another's files.
RUN install --directory --mode 1777 /work

USER rom-weaver
WORKDIR /work
ENTRYPOINT ["rom-weaver"]
