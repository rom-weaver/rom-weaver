# Native Linux CLI image. Mount input/output directories and pass normal
# rom-weaver arguments after the image name.
#
# Bind-mounted files keep their host ownership, so anything the container writes
# must run as an id the host directory accepts. Pass `--user "$(id -u):$(id -g)"`
# for that; the image needs no passwd entry for it because rom-weaver reads no
# home directory or user config. See docs/cli.md ("Run in Docker").
FROM rust:1.95-bookworm AS builder
WORKDIR /src

RUN apt-get update \
    && apt-get install --yes --no-install-recommends clang cmake libclang-dev ninja-build pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY . .
RUN cargo build --locked --release --package rom-weaver-cli

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 rom-weaver

COPY --from=builder /src/target/release/rom-weaver /usr/local/bin/rom-weaver

# Left to `WORKDIR`, /work is created 0755 owned by the image's own user, so an
# overridden `--user` cannot write there when nothing is mounted over it.
# Sticky-and-writable (the /tmp convention) keeps it usable for any uid without
# letting one delete another's files.
RUN install --directory --mode 1777 /work

USER rom-weaver
WORKDIR /work
ENTRYPOINT ["rom-weaver"]
