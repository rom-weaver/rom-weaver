# Self-hosting the webapp

RomWeaver is a static webapp. Host it on its own HTTPS subdomain or under a
dedicated path such as `https://example.com/rom-weaver/`. A subdomain is the
safest choice; a subpath is also supported because the build uses relative
asset URLs and registers its service worker with a relative scope.

Do not mount RomWeaver at the root of an origin that also serves other apps.
At the root, its service worker can control every path on that origin. Under
`/rom-weaver/`, it controls only that path.

## Docker

Docker Compose builds the WASM module, bundles the webapp, and starts the
included static server:

```bash
docker compose up --build --detach
```

This path only requires Docker with Compose; the image installs the required
Rust, WASI SDK, Binaryen, and Node.js toolchains. The first build compiles the
full WASM application and can take several minutes. Later builds reuse Docker's
layer cache when their inputs have not changed.

Open `http://localhost:8080` to verify the container. To use another host port:

```bash
PORT=3000 docker compose up --build --detach
```

The container listens on port 8080 over plain HTTP. In production, put it
behind the HTTPS reverse proxy that serves the rest of the site. For an Nginx
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

Useful lifecycle commands:

```bash
docker compose logs --follow webapp
docker compose down
```

## Static files

Build a portable static directory:

```bash
mise run build-wasm-prod
npm ci --prefix packages/rom-weaver-webapp
npm --prefix packages/rom-weaver-webapp run build
```

Upload the contents of `packages/rom-weaver-webapp/dist/`, preserving its
directory structure. The normal build does not include precompressed `.br`
siblings because generic static hosts do not automatically serve them. Enable
dynamic Brotli or gzip compression in the host when available, especially for
the WASM file.

The server should fall back to `index.html` for navigation requests within the
RomWeaver path. Redirect `/rom-weaver` to `/rom-weaver/` when using a subpath so
relative assets and the service-worker scope resolve consistently.

## Cross-origin isolation

The threaded WASM runtime requires `SharedArrayBuffer` and
`crossOriginIsolated`. HTTPS is required outside localhost.

Prefer adding these response headers to every RomWeaver response, scoped only
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

When a static host cannot set these headers, RomWeaver's service worker can add
them for responses within its scope. The first visit may reload once after the
worker takes control. This fallback still requires HTTPS and service-worker
support.

After deployment, open the browser console and confirm:

```js
crossOriginIsolated === true
```

If it is false, check the document's COOP/COEP response headers, HTTPS trust,
and whether `cache-service-worker.js` controls the page.

## Ingesting existing OPFS files

A host on the same origin can place inputs under the OPFS
`rom-weaver-imports/` directory and send their mounted paths through the same
pipeline as files dropped onto the Apply page. Include a bundle in the list
when using one; it does not need a separate option.

Applications importing the package can call `ingest`:

```js
import { ingest } from "rom-weaver-webapp";

ingest([
  "/work/rom-weaver-imports/rom-weaver-bundle.json",
  "/work/rom-weaver-imports/game.bin",
  "/work/rom-weaver-imports/change.ips",
]);
```

Hosts serving the prebuilt webapp can dispatch the equivalent event after its
module script has loaded:

```js
document.dispatchEvent(
  new CustomEvent("rom-weaver:ingest", {
    detail: [
      "/work/rom-weaver-imports/rom-weaver-bundle.json",
      "/work/rom-weaver-imports/game.bin",
      "/work/rom-weaver-imports/change.ips",
    ],
  }),
);
```

The mounted `/work/rom-weaver-imports/example.bin` path refers to
`rom-weaver-imports/example.bin` below the origin's OPFS root. RomWeaver
preserves that directory during startup cleanup and does not delete supplied
files. OPFS is origin-private, so another origin cannot populate or ingest
these paths.
