# Self-hosting the webapp

rom-weaver is a static webapp. The browser-facing URL must use HTTPS (except
for localhost). Host it on its own HTTPS subdomain or under a dedicated path
such as `https://example.com/rom-weaver/`. A subdomain is the
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
- [Service worker and subpaths](#service-worker-and-subpaths)
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

The container listens on port 8080 over plain HTTP. This is suitable when an
HTTPS reverse proxy terminates TLS. The proxy must present a certificate that
the browser trusts and forward the request to the container. For an Nginx
subpath route:

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

If you do not have a reverse proxy, Compose can terminate HTTPS in the
container. If you do not provide a certificate pair, it generates a temporary
self-signed certificate for `localhost` that expires after seven days:

```bash
HTTPS_PORT=8443 docker compose up --build --detach
```

Open `https://localhost:8443/`. A browser may allow you to proceed through the
warning for local testing, but an expired or untrusted certificate can still
prevent service-worker registration. For reliable service-worker and WASM
thread support, install/trust the certificate or use a trusted certificate.

For a trusted certificate, put `fullchain.pem` and `privkey.pem` in a host
directory and mount it with `HTTPS_CERT_DIR`. The container uses those default
filenames when both are present:

```bash
HTTPS_PORT=8443 HTTPS_CERT_DIR=/path/to/certs \
  docker compose up --build --detach
```

To use different filenames or mounted paths, set both `HTTPS_CERT` and
`HTTPS_KEY` to paths inside `/certs`. `HTTPS_PORT` is the host port and enables
the container's TLS listener; it is not used together with `PORT`. The
generated certificate is never suitable for production or public/LAN use.

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
npm --prefix packages/rom-weaver-webapp run build
```

Upload everything under `packages/rom-weaver-webapp/dist/` to your HTTPS host.
Preserve the directory structure. The build emits raw assets; generic hosts
should enable Brotli or gzip compression when available, especially for the
WASM file. The Docker image is the only distribution that adds static `.br`
siblings, because its bundled server is configured to consume them; it gzips
on demand for clients that cannot take brotli.

The `rom-weaver-webapp.tar.gz` asset on each GitHub release contains this raw
build, so unpacking it is an alternative to building from a checkout.

The build includes directory-index pages for `/weave`, `/create`, `/trim`, and
`/tools`, so ordinary static servers can resolve direct visits and refreshes
without rewrite configuration. A server that disables directory indexes must
instead fall back to `index.html` for those navigation requests. Redirect
`/rom-weaver` to `/rom-weaver/` when using a subpath so relative assets, History
API routes, and the service-worker scope resolve consistently. Explicit
directory-document URLs such as `/weave/index.html` are normalized in the
browser to the clean `/weave` route without another request.

Cloudflare-compatible hosts read the generated `_headers` file. On other hosts,
the equivalent cache policy is:

```text
/assets/*                 Cache-Control: public, max-age=31536000, immutable
/cache-service-worker.js  Cache-Control: no-cache
```

Only `/assets/*` uses immutable caching because those filenames contain content
hashes. Do not apply that policy to HTML, the manifest, `robots.txt`,
`sitemap.xml`, or other stable filenames.

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

These headers can be scoped to the rom-weaver subpath. They do not need to be
applied to unrelated applications on the same origin. The Docker image sends
them on every response from its container; a reverse proxy or static host must
preserve them, or add the same headers to responses under `/rom-weaver/`.

When a static host cannot set these headers, rom-weaver's service worker can add
them for responses within its scope. See [Service worker and subpaths](#service-worker-and-subpaths)
for the bounded reload and fallback behavior.

After deployment, open the browser console and confirm:

```js
crossOriginIsolated === true
```

If it is false, check the document's COOP/COEP response headers, HTTPS trust,
and whether `cache-service-worker.js` controls the page.

## Service worker and subpaths

Production builds register `cache-service-worker.js` using the app's relative
asset base. When the app is served at `/rom-weaver/`, the service worker's
default scope is `/rom-weaver/`; it does not control the origin root or sibling
applications. Redirect `/rom-weaver` to `/rom-weaver/` so relative assets,
registration, and scope resolve to the same directory.

The service worker precaches the build, checks for updates, and can serve
same-origin navigation and manifest requests from its cache. It can also add
the cross-origin isolation headers to responses inside its scope when the host
cannot configure them. It cannot alter the very first document response before
it controls the page, so server or proxy headers remain the preferred setup.

On first install, the worker claims the app and the client may reload once to
gain control and establish isolation. The boot gate retries a stalled
controlled-but-unisolated page only within a bounded budget, then releases the
page instead of reloading forever. If `crossOriginIsolated` is still false,
the threaded WASM runtime will not be available; fix the response headers,
HTTPS trust, service-worker scope, or browser support rather than treating the
fallback as equivalent to a correctly configured deployment.

## Host integration

To preload remote sources or files already stored in same-origin OPFS, use the
[webapp integration APIs](webapp-integration.md).
