# Self-hosting the webapp

rom-weaver is a static webapp. Host it on its own HTTPS subdomain or under a
dedicated path such as `https://example.com/rom-weaver/`. A subdomain is the
safest choice; a subpath is also supported because the build uses relative
asset URLs and registers its service worker with a relative scope.

Do not mount rom-weaver at the root of an origin that also serves other apps.
At the root, its service worker can control every path on that origin. Under
`/rom-weaver/`, it controls only that path.

<!-- START doctoc -->
## Table of contents

- [Docker](#docker)
  - [Build from source with Compose](#build-from-source-with-compose)
- [Static files](#static-files)
- [Cross-origin isolation](#cross-origin-isolation)
- [Host integration](#host-integration)

<!-- END doctoc -->

## Docker

### Build from source with Compose

Docker Compose builds the WASM module, bundles the webapp, and starts the
included static server from a checkout:

```bash
git clone https://github.com/brandonocasey/rom-weaver.git
cd rom-weaver
docker compose up --build --detach
curl --fail --silent --show-error http://localhost:8080/health
```

This path only requires Docker with Compose; the image installs the required
Rust, WASI SDK, Binaryen, and Node.js toolchains. The first build compiles the
full WASM application and can take several minutes. Later builds reuse Docker's
layer cache when their inputs have not changed.

To use another host port:

```bash
PORT=3000 docker compose up --build --detach
```

The container listens on port 8080 over plain HTTP. For an Nginx subpath route:

```nginx
location = /rom-weaver {
    return 308 /rom-weaver/;
}

location /rom-weaver/ {
    proxy_pass http://127.0.0.1:8080/;
}
```

The trailing slashes on both `location` and `proxy_pass` are significant: the
proxy removes `/rom-weaver/` before forwarding the request. The container adds
the required COOP/COEP headers, serves SPA fallbacks, and serves the build's
precompressed Brotli files.

For a dedicated subdomain, route its `/` location to the same container.

Useful lifecycle commands:

```bash
docker compose logs --follow webapp
docker compose down
```

## Static files

Install the system tools from the [development guide](development.md#prerequisites),
then build the static files from a checkout:

```bash
git clone https://github.com/brandonocasey/rom-weaver.git
cd rom-weaver
mise trust
mise install
npm ci
npm ci --prefix packages/rom-weaver-webapp
mise run build-wasm-prod
npm --prefix packages/rom-weaver-webapp run build -- --mode selfhost
```

Upload everything under `packages/rom-weaver-webapp/dist/` to your HTTPS host.
Preserve the directory structure. `--mode selfhost` is what writes the
precompressed `.br` and `.gz` siblings; a plain `run build` targets the CDN-served
channel deploys, which compress on the fly, and emits none. Generic hosts do not
serve the siblings automatically either - enable Brotli or gzip compression when
available, especially for the WASM file.

The `rom-weaver-webapp.tar.gz` asset on each GitHub release is this same build,
so unpacking it is an alternative to building from a checkout.

The server should fall back to `index.html` for navigation requests within the
rom-weaver path. Redirect `/rom-weaver` to `/rom-weaver/` when using a subpath so
relative assets and the service-worker scope resolve consistently.

## Cross-origin isolation

The threaded WASM runtime requires `SharedArrayBuffer` and
`crossOriginIsolated`. HTTPS is required outside localhost.

Prefer adding these response headers to every rom-weaver response, scoped only
to its subdomain or path:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

Do not apply them site-wide unless every application on the origin is expected
to use those policies. Under `Cross-Origin-Embedder-Policy: require-corp`, any
cross-origin resource loaded by the app must opt in through CORS or a compatible
`Cross-Origin-Resource-Policy` header.

When a static host cannot set these headers, rom-weaver's service worker can add
them for responses within its scope. The first visit may reload once after the
worker takes control. This fallback still requires HTTPS and service-worker
support.

After deployment, open the browser console and confirm:

```js
crossOriginIsolated === true
```

If it is false, check the document's COOP/COEP response headers, HTTPS trust,
and whether `cache-service-worker.js` controls the page.

## Host integration

To preload remote sources or files already stored in same-origin OPFS, use the
[webapp integration APIs](webapp-integration.md).
