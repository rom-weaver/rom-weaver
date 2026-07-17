# Native Linux CLI image. Mount input/output directories and pass normal
# rom-weaver arguments after the image name.
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

USER rom-weaver
WORKDIR /work
ENTRYPOINT ["rom-weaver"]
