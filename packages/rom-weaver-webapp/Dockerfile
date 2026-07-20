# Build the threaded WASM app and static webapp inside Docker with supported
# project toolchains, so self-hosters only need Docker.
FROM node:22-bookworm AS builder

ARG TARGETARCH
ARG RUST_VERSION=1.95.0
ARG WASI_SDK_VERSION=33
ARG BINARYEN_VERSION=129

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        build-essential \
        ca-certificates \
        clang \
        cmake \
        curl \
        git \
        libclang-dev \
        ninja-build \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
        https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}" \
    && /root/.cargo/bin/rustup target add wasm32-wasip1-threads

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) \
        wasi_arch=x86_64; \
        wasi_sha=0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce; \
        binaryen_arch=x86_64; \
        binaryen_sha=50b9fa62b9abea752da92ec57e0c555fee578760cd237c40107957715d2976ba ;; \
      arm64) \
        wasi_arch=arm64; \
        wasi_sha=4f98ee738c7abb45c81a94d1461fc53cc569d1cd01498951c8184d841a027844; \
        binaryen_arch=aarch64; \
        binaryen_sha=81d46b86b10876ab615eec67e09fcc5615115a7b189cfe3d466725ee36c46ac2 ;; \
      *) echo "unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --silent --show-error \
      "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-${wasi_arch}-linux.tar.gz" \
      --output /tmp/wasi-sdk.tar.gz; \
    echo "${wasi_sha}  /tmp/wasi-sdk.tar.gz" | sha256sum --check; \
    mkdir -p /opt/wasi-sdk; \
    tar --extract --gzip --strip-components=1 --file /tmp/wasi-sdk.tar.gz --directory /opt/wasi-sdk; \
    curl --fail --location --silent --show-error \
      "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-${binaryen_arch}-linux.tar.gz" \
      --output /tmp/binaryen.tar.gz; \
    echo "${binaryen_sha}  /tmp/binaryen.tar.gz" | sha256sum --check; \
    mkdir -p /opt/binaryen; \
    tar --extract --gzip --strip-components=1 --file /tmp/binaryen.tar.gz --directory /opt/binaryen; \
    rm /tmp/wasi-sdk.tar.gz /tmp/binaryen.tar.gz

ENV PATH="/root/.cargo/bin:/opt/binaryen/bin:${PATH}" \
    MISE_PROJECT_ROOT=/app \
    WASI_SDK_PATH=/opt/wasi-sdk \
    WASI_SYSROOT=/opt/wasi-sdk/share/wasi-sysroot \
    WASI_CLANG=/opt/wasi-sdk/bin/clang \
    WASI_CLANGXX=/opt/wasi-sdk/bin/clang++ \
    WASI_AR=/opt/wasi-sdk/bin/llvm-ar \
    WASI_RANLIB=/opt/wasi-sdk/bin/llvm-ranlib \
    WASI_STRIP=/opt/wasi-sdk/bin/llvm-strip \
    CC_wasm32_wasip1="/opt/wasi-sdk/bin/clang --sysroot=/opt/wasi-sdk/share/wasi-sysroot" \
    CXX_wasm32_wasip1="/opt/wasi-sdk/bin/clang++ --sysroot=/opt/wasi-sdk/share/wasi-sysroot" \
    AR_wasm32_wasip1=/opt/wasi-sdk/bin/llvm-ar \
    RANLIB_wasm32_wasip1=/opt/wasi-sdk/bin/llvm-ranlib \
    CFLAGS_wasm32_wasip1="-msimd128 -O3 -flto" \
    CXXFLAGS_wasm32_wasip1="-msimd128 -O3 -flto" \
    CC_wasm32_wasip1_threads=/app/scripts/wasm/wasm32-wasip1-threads-cc.sh \
    CXX_wasm32_wasip1_threads=/app/scripts/wasm/wasm32-wasip1-threads-cxx.sh \
    AR_wasm32_wasip1_threads=/opt/wasi-sdk/bin/llvm-ar \
    RANLIB_wasm32_wasip1_threads=/opt/wasi-sdk/bin/llvm-ranlib \
    CFLAGS_wasm32_wasip1_threads="-matomics -mbulk-memory -msimd128 -O3 -flto" \
    CXXFLAGS_wasm32_wasip1_threads="-matomics -mbulk-memory -msimd128 -O3 -flto" \
    BINDGEN_EXTRA_CLANG_ARGS="-isystem /opt/wasi-sdk/share/wasi-sysroot/include/wasm32-wasip1-threads -isystem /opt/wasi-sdk/share/wasi-sysroot/include" \
    CARGO_INCREMENTAL=0 \
    ROM_WEAVER_COMMIT_HASH=docker

WORKDIR /app/packages/rom-weaver-webapp
COPY packages/rom-weaver-webapp/package.json packages/rom-weaver-webapp/package-lock.json ./
RUN npm ci

WORKDIR /app
COPY . .
# Cache mounts keep the cargo registry and the cmake-built C deps (libarchive)
# across local rebuilds. On ephemeral CI runners they are a no-op: BuildKit does
# not export cache mounts to `type=gha`, so CI still pays a cold compile.
#
# There is deliberately no manifest-only `cargo fetch` prefetch layer ahead of
# this COPY. Cargo refuses to parse a manifest whose targets are missing ("no
# targets specified in the manifest"), so it would need a stubbed src/lib.rs or
# src/main.rs per workspace member - 20 of them, silently wrong the moment a
# crate's target layout changes. It would only save dependency download time on
# a job that recompiles from scratch regardless.
RUN --mount=type=cache,target=/root/.cargo/registry,sharing=locked \
    --mount=type=cache,target=/app/target,sharing=locked \
    bash scripts/wasm/build-app.sh prod \
    && npm --prefix packages/rom-weaver-webapp run build -- --mode docker

# static-web-server serves the generated SPA as a non-root user. HTTPS is
# terminated by the reverse proxy described in docs/self-hosting.md.
FROM ghcr.io/static-web-server/static-web-server:2-alpine AS runtime
COPY packages/rom-weaver-webapp/sws.toml /etc/sws.toml
COPY --from=builder /app/packages/rom-weaver-webapp/dist /srv
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["--config-file", "/etc/sws.toml"]
