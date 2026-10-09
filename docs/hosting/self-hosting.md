# Self-hosting the webapp

rom-weaver is a static webapp. The browser-facing URL must use HTTPS (except for localhost). Host it on its own HTTPS subdomain or under a dedicated path such as `https://example.com/rom-weaver/`. A subdomain is the safest choice; a subpath is also supported because the build uses relative asset URLs and registers its service worker with a relative scope.

Do not mount rom-weaver at the root of an origin that also serves other apps. At the root, its service worker can control every path on that origin. Under `/rom-weaver/`, it controls only that path.

<!-- START doctoc -->
## Table of contents

- [Docker](#docker)
  - [Run the published image](#run-the-published-image)
  - [Run with Compose](#run-with-compose)
- [Static files](#static-files)
  - [Download a release tarball](#download-a-release-tarball)
  - [Build static files from source](#build-static-files-from-source)
- [Cross-origin isolation](#cross-origin-isolation)
- [Service worker and subpaths](#service-worker-and-subpaths)
- [Host integration](#host-integration)

<!-- END doctoc -->

## Docker

### Run the published image

Run the published image behind an HTTPS reverse proxy, or locally on port 8080:

```bash
docker run --detach --name rom-weaver-webapp \
  --publish 8080:8080 \
  ghcr.io/rom-weaver/rom-weaver-webapp:latest
```

Check it with `curl http://localhost:8080/health`. Stop and remove it with:

```bash
docker rm --force rom-weaver-webapp
```

For standalone HTTPS, mount a certificate pair and set `HTTPS_PORT`:

```bash
docker run --detach --name rom-weaver-webapp \
  --publish 8443:8080 \
  --env HTTPS_PORT=8443 \
  --volume "$PWD/certs:/certs:ro" \
  ghcr.io/rom-weaver/rom-weaver-webapp:latest
```

Place `fullchain.pem` and `privkey.pem` in `./certs`, then open `https://localhost:8443/`. Without both files, the image generates a self-signed certificate for local testing only.

### Run with Compose

Download the [Docker Compose template](https://github.com/rom-weaver/rom-weaver/blob/main/docker-compose.yml) into a new directory, then start the published image:

```bash
mkdir -p rom-weaver-compose
cd rom-weaver-compose
curl --fail --location --proto '=https' --tlsv1.2 \
  --output docker-compose.yml \
  https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docker-compose.yml
docker compose pull
docker compose up --detach
curl --fail --silent --show-error http://localhost:8080/health
```

Only Docker with Compose is required. For a source build, clone the repository and run `docker compose up --build --detach` there. Docker installs Rust, WASI SDK, Binaryen, and Node.js; the first WASM build takes several minutes.

To use another host port:

```bash
PORT=3000 docker compose up --detach
```

The container serves HTTP on port 8080. Configure your HTTPS proxy with a browser-trusted certificate. For an Nginx subpath route:

```nginx
location = /rom-weaver {
    return 308 /rom-weaver/$is_args$args;
}

location /rom-weaver/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_redirect default;
    proxy_redirect / /rom-weaver/;
}
```

Keep both trailing slashes: they remove `/rom-weaver/` from forwarded requests. The `proxy_redirect` rules preserve that prefix on redirects, including legacy URLs. The container supplies COOP/COEP headers, SPA fallbacks, and precompressed Brotli files.

For a dedicated subdomain, route its `/` location to the same container.

Without a proxy, enable container HTTPS. Without a certificate pair, it generates a seven-day self-signed certificate for `localhost`:

```bash
HTTPS_PORT=8443 docker compose up --detach
```

Open `https://localhost:8443/`. Bypassing the browser warning may still block service-worker registration. Install/trust the certificate for local testing; use a trusted certificate elsewhere.

Mount a trusted `fullchain.pem` and `privkey.pem` pair using `HTTPS_CERT_DIR`:

```bash
HTTPS_PORT=8443 HTTPS_CERT_DIR=/path/to/certs \
  docker compose up --detach
```

For other filenames, set both `HTTPS_CERT` and `HTTPS_KEY` to paths inside `/certs`. Use `HTTPS_PORT` instead of `PORT` to select the host port and enable TLS. Generated certificates are unsuitable for production or public/LAN use.

Useful lifecycle commands:

```bash
docker compose logs --follow webapp
docker compose down
```

## Static files

### Download a release tarball

Each GitHub release includes the same static build without the Docker image. Download and extract the latest one into the directory your static host serves:

```bash
mkdir -p rom-weaver-webapp
curl --fail --location --proto '=https' --tlsv1.2 \
  --output rom-weaver-webapp.tar.gz \
  https://github.com/rom-weaver/rom-weaver/releases/latest/download/rom-weaver-webapp.tar.gz
tar --extract --gzip \
  --file rom-weaver-webapp.tar.gz \
  --directory rom-weaver-webapp
```

Serve the extracted `rom-weaver-webapp` directory from an HTTPS static host, preserve its directory structure, and configure the [host requirements](#cross-origin-isolation) below. A subdomain is simplest; for a subpath, redirect its bare path to a trailing slash, such as `/rom-weaver` to `/rom-weaver/`.

To pin a release, use its tag in the release-download URL:

```text
https://github.com/rom-weaver/rom-weaver/releases/download/vX.Y.Z/rom-weaver-webapp.tar.gz
```

### Build static files from source

Install the system tools from the [development guide](../development/development.md#prerequisites), then build the static files from a checkout:

```bash
git clone https://github.com/rom-weaver/rom-weaver.git
cd rom-weaver
mise trust
mise install
npm ci
npm ci --prefix packages/rom-weaver-webapp
mise run build-wasm-prod
npm --prefix packages/rom-weaver-webapp run build
```

Upload everything under `packages/rom-weaver-webapp/dist/` to your HTTPS host. Preserve the directory structure. The build includes raw assets and `.br` sidecars for compressible immutable assets. Configure your host to serve a sidecar with `Content-Encoding: br` when the client accepts Brotli, and the raw asset otherwise. Docker and the Cloudflare Pages integration handle this negotiation. A generic host can instead compress the raw assets itself.

The build includes directory-index pages for its workflow and documentation routes, so ordinary static servers can resolve direct visits and refreshes without rewrite configuration. A server that disables directory indexes must instead fall back to `index.html` for those navigation requests. Redirect `/rom-weaver` to `/rom-weaver/` when using a subpath so relative assets, History API routes, and the service-worker scope resolve consistently. Explicit directory-document URLs such as `/apply-patches/index.html` are normalized in the browser to the clean `/apply-patches` route without another request. The Docker image and Cloudflare Pages permanently redirect old `/weave`, `/bundle`, and `/bundle-patches` forms to `/weave-patches`, preserving query strings. Configure equivalent redirects on other static hosts.

Cloudflare-compatible hosts read the generated `_headers` file. On other hosts, the equivalent cache policy is:

```text
/assets/*                     Cache-Control: public, max-age=31536000, immutable
/rom-weaver-service-worker.js Cache-Control: no-cache
```

Earlier releases served the service worker as `cache-service-worker.js`. If your host config still names that path, change it to `rom-weaver-service-worker.js`.

Only `/assets/*` uses immutable caching, because those URLs are content-addressed: build output, including the two identify manifests, carries a hash in the filename, and the identify packs, cheat shards, checksum router, and title index are requested with a `?sha256=` query that changes whenever their bytes do. Do not apply the immutable policy to HTML, the manifest, `robots.txt`, `sitemap.xml`, or other stable filenames.

## Cross-origin isolation

The threaded WASM runtime requires `SharedArrayBuffer` and `crossOriginIsolated`. HTTPS is required outside localhost.

Prefer adding these response headers to every rom-weaver response, scoped only to its subdomain or path:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

Do not apply them site-wide unless every application on the origin is expected to use those policies. Under `Cross-Origin-Embedder-Policy: require-corp`, any cross-origin resource loaded by the app must opt in through CORS or a compatible `Cross-Origin-Resource-Policy` header.

These headers can be scoped to the rom-weaver subpath. They do not need to be applied to unrelated applications on the same origin. The Docker image sends them on every response from its container; a reverse proxy or static host must preserve them, or add the same headers to responses under `/rom-weaver/`.

When a static host cannot set these headers, rom-weaver's service worker can add them for responses within its scope. See [Service worker and subpaths](#service-worker-and-subpaths) for the bounded reload and fallback behavior.

After deployment, open the browser console and check:

```js
crossOriginIsolated === true
```

If it is false, check the document's COOP/COEP response headers, HTTPS trust, and whether `rom-weaver-service-worker.js` controls the page.

## Service worker and subpaths

Production builds register `rom-weaver-service-worker.js` using the app's relative asset base. When the app is served at `/rom-weaver/`, the service worker's default scope is `/rom-weaver/`; it does not control the origin root or sibling applications. Redirect `/rom-weaver` to `/rom-weaver/` so relative assets, registration, and scope resolve to the same directory.

The service worker precaches the build, checks for updates, and can serve same-origin navigation and manifest requests from its cache. It can also add the cross-origin isolation headers to responses inside its scope when the host cannot configure them. It cannot alter the first document response before it controls the page, so server or proxy headers remain the preferred setup.

On first install, the worker claims the app and the client may reload once to gain control and establish isolation. The boot gate retries a stalled controlled-but-unisolated page only within a bounded budget, then releases the page instead of reloading forever. If `crossOriginIsolated` is still false, the threaded WASM runtime will not be available; fix the response headers, HTTPS trust, service-worker scope, or browser support rather than treating the fallback as equivalent to a correctly configured deployment.

## Host integration

To preload remote sources or files already stored in same-origin OPFS, use the [webapp integration APIs](webapp-integration.md).
