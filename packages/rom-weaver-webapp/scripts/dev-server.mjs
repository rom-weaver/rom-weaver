#!/usr/bin/env node

import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { createServer as createViteServer } from "vite";

const WILDCARD_HOST_REGEX = /^0\.0\.0\.0(?::\d+)?$/;
const PARENT_DIRECTORY_PREFIX_REGEX = /^(\.\.[/\\])+/;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIND_HOST = "0.0.0.0";
const DEFAULT_DEV_PORT = 5173;
const DEFAULT_PREVIEW_PORT = 4173;
const E2E_CORPUS_PREFIX = "/__rom_weaver_corpus__/";
const CERT_VALID_DAYS = parseInt(process.env.DEV_CERT_DAYS || "30", 10);
const DYNAMIC_BROTLI_MAX_BYTES = 256 * 1024;
const DYNAMIC_BROTLI_TYPES = new Set([".css", ".html", ".js", ".json", ".mjs", ".svg"]);
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
};

const BASE_SECURITY_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Expires: "0",
  Pragma: "no-cache",
};
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const parseArguments = (argv) => {
  const args = argv.slice();
  const options = {
    invalid: false,
    mode: "dev",
    noCoopCoep: false,
    open: false,
    port: null,
  };

  if (args[0] && !args[0].startsWith("-")) options.mode = args.shift();

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--") continue;
    if (arg === "--host") {
      if (args[0] && !args[0].startsWith("-")) args.shift();
      options.help = true;
      options.invalid = true;
      continue;
    }
    if (arg.startsWith("--host=") || arg === "-H") {
      options.help = true;
      options.invalid = true;
      continue;
    }
    if (arg === "--port" || arg === "-p") {
      options.port = parseInt(args.shift() || "", 10);
      continue;
    }
    if (arg.startsWith("--port=")) {
      options.port = parseInt(arg.slice("--port=".length), 10);
      continue;
    }
    if (arg === "--open" || arg === "-o") {
      options.open = true;
      continue;
    }
    if (arg === "--no-coop-coep") {
      options.noCoopCoep = true;
      continue;
    }
    // Explicit positive form (default already on): force server-set COOP/COEP/CORP headers so cross-origin
    // isolation does not depend on the service worker. Useful for verifying the production bundle in
    // `preview` - the SW can fail to register behind the self-signed cert, but server headers still isolate.
    if (arg === "--coop-coep") {
      options.noCoopCoep = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    options.help = true;
    options.invalid = true;
  }

  if (options.mode !== "dev" && options.mode !== "preview") {
    options.help = true;
    options.invalid = true;
  }
  if (!Number.isFinite(options.port)) options.port = parseInt(process.env.PORT || "", 10);
  if (!Number.isFinite(options.port))
    options.port = options.mode === "preview" ? DEFAULT_PREVIEW_PORT : DEFAULT_DEV_PORT;

  return options;
};

const printUsage = () => {
  console.log(
    "Usage: node scripts/dev-server.mjs [dev|preview] [--port 5173] [--open] [--coop-coep] [--no-coop-coep]\nCOOP/COEP/CORP headers are on by default (--coop-coep forces them; --no-coop-coep disables them so the\nservice worker must provide isolation). The server always listens on all available network interfaces.",
  );
};

const getSecurityHeaders = ({ crossOriginIsolation = true } = {}) => ({
  ...BASE_SECURITY_HEADERS,
  ...(crossOriginIsolation ? CROSS_ORIGIN_ISOLATION_HEADERS : {}),
});

const setSecurityHeaders = (res, options) => {
  const headers = getSecurityHeaders(options);
  for (const name of Object.keys(headers)) {
    res.setHeader(name, headers[name]);
  }
};

const send = (res, status, headers, body, securityOptions) => {
  setSecurityHeaders(res, securityOptions);
  res.writeHead(status, headers || {});
  res.end(body);
};

const handleE2eCorpusRequest = (req, res, securityOptions) => {
  const corpusDir = process.env.ROM_WEAVER_E2E_CORPUS_DIR;
  const requestPath = String(req.url || "/").split("?")[0];
  if (!(corpusDir && requestPath.startsWith(E2E_CORPUS_PREFIX))) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, { Allow: "GET, HEAD" }, "Method Not Allowed", securityOptions);
    return true;
  }
  let relativePath;
  try {
    relativePath = decodeURIComponent(requestPath.slice(E2E_CORPUS_PREFIX.length));
  } catch {
    send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad Request", securityOptions);
    return true;
  }
  if (relativePath !== "manifest.json" && !relativePath.startsWith("files/")) {
    send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not Found", securityOptions);
    return true;
  }
  const root = path.resolve(corpusDir);
  const filePath = path.resolve(root, relativePath);
  const allowedRoot = relativePath === "manifest.json" ? root : path.join(root, "files");
  const allowedFile =
    relativePath === "manifest.json"
      ? filePath === path.join(root, "manifest.json")
      : filePath.startsWith(`${allowedRoot}${path.sep}`);
  if (!allowedFile) {
    send(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "Forbidden", securityOptions);
    return true;
  }
  if (relativePath.startsWith("files/")) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
      const listedPaths = new Set(
        (Array.isArray(manifest.cases) ? manifest.cases : []).map((entry) =>
          decodeURIComponent(String(entry?.url || "").replace(E2E_CORPUS_PREFIX, "")),
        ),
      );
      if (!listedPaths.has(relativePath)) {
        send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not Found", securityOptions);
        return true;
      }
    } catch {
      send(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, "Invalid corpus manifest", securityOptions);
      return true;
    }
  }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not Found", securityOptions);
      return;
    }
    setSecurityHeaders(res, securityOptions);
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": relativePath.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
  return true;
};

const getLanAddresses = () => {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const address of interfaces[name] || []) {
      if (address && address.family === "IPv4" && !address.internal && addresses.indexOf(address.address) === -1)
        addresses.push(address.address);
    }
  }
  return addresses;
};

const getCertificatePaths = () => {
  const certId = crypto.createHash("sha1").update(ROOT_DIR).digest("hex").slice(0, 12);
  const certDirectory = path.join(os.tmpdir(), `rom-weaver-react-dev-cert-${certId}`);
  return {
    cert: path.join(certDirectory, "localhost.crt"),
    config: path.join(certDirectory, "openssl.cnf"),
    directory: certDirectory,
    key: path.join(certDirectory, "localhost.key"),
  };
};

const writeOpenSslConfig = (configPath, lanAddresses) => {
  const altNames = ["DNS.1 = localhost", "IP.1 = 127.0.0.1", "IP.2 = ::1"];
  lanAddresses.forEach((address, index) => {
    altNames.push(`IP.${index + 3} = ${address}`);
  });
  fs.writeFileSync(
    configPath,
    `${[
      "[req]",
      "default_bits = 2048",
      "prompt = no",
      "default_md = sha256",
      "distinguished_name = dn",
      "x509_extensions = v3_req",
      "",
      "[dn]",
      "CN = localhost",
      "",
      "[v3_req]",
      "basicConstraints = CA:FALSE",
      "keyUsage = digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      "subjectAltName = @alt_names",
      "",
      "[alt_names]",
    ]
      .concat(altNames)
      .join("\n")}\n`,
  );
};

const ensureCertificate = (lanAddresses) => {
  const paths = getCertificatePaths();
  fs.mkdirSync(paths.directory, { recursive: true });
  writeOpenSslConfig(paths.config, lanAddresses);

  if (!(fs.existsSync(paths.key) && fs.existsSync(paths.cert))) {
    const result = childProcess.spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        String(Number.isFinite(CERT_VALID_DAYS) && CERT_VALID_DAYS > 0 ? CERT_VALID_DAYS : 30),
        "-keyout",
        paths.key,
        "-out",
        paths.cert,
        "-config",
        paths.config,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.status !== 0)
      throw new Error(
        `Unable to create a self-signed certificate with openssl.\n${result.stderr || result.stdout || ""}`,
      );
  }

  return {
    cert: fs.readFileSync(paths.cert),
    key: fs.readFileSync(paths.key),
    paths,
  };
};

const getRedirectHost = (req, port) => {
  const hostHeader = req.headers.host || `localhost:${port}`;
  if (WILDCARD_HOST_REGEX.test(hostHeader)) return `localhost:${port}`;
  return hostHeader;
};

const handleRedirect = (req, res, port, securityOptions) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, { Allow: "GET, HEAD" }, "Method Not Allowed", securityOptions);
    return;
  }
  const location = `https://${getRedirectHost(req, port)}${req.url || "/"}`;
  send(
    res,
    308,
    {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      Location: location,
    },
    req.method === "HEAD" ? null : `Redirecting to ${location}\n`,
    securityOptions,
  );
};

const createPortMuxServer = (httpsServer, httpRedirectServer) =>
  net.createServer((socket) => {
    const routeSocket = () => {
      const chunk = socket.read(1);
      if (!chunk) {
        socket.once("readable", routeSocket);
        return;
      }
      socket.unshift(chunk);
      if (chunk[0] === 22) httpsServer.emit("connection", socket);
      else httpRedirectServer.emit("connection", socket);
      socket.resume();
    };
    socket.pause();
    socket.once("readable", routeSocket);
  });

const listen = (server, port, host) =>
  new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

const closeNodeServer = (server) =>
  new Promise((resolve) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close(() => {
      resolve();
    });
  });

const formatStartupError = (error, options) => {
  if (!error || error.code !== "EADDRINUSE") return error?.stack ? error.stack : String(error || "Unknown error");

  const port = Number.isFinite(options?.port) ? options.port : "unknown";
  const nextPort = Number.isFinite(options?.port) ? options.port + 1 : "YOUR_PORT";
  const mode = options?.mode === "preview" ? "preview" : "dev";
  const suggestion =
    process.platform === "win32" ? `  netstat -ano | findstr :${port}` : `  lsof -nP -iTCP:${port} -sTCP:LISTEN`;

  return [
    `Port ${port} on ${BIND_HOST} is already in use.`,
    "Use one of these fixes:",
    `  1) Stop the process holding the port (${suggestion.trim()}).`,
    `  2) Start on another port: npm run ${mode} -- --port ${nextPort}`,
    "",
    `Original error: ${error.message || "EADDRINUSE"}`,
  ].join("\n");
};

const installShutdown = (servers, viteServer) => {
  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    try {
      if (viteServer) await viteServer.close();
      await Promise.all(servers.map(closeNodeServer));
    } finally {
      process.exit(signal ? 0 : process.exitCode || 0);
    }
  };

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
};

const getLocalUrl = (port) => `https://localhost:${port}/`;

const openBrowser = (targetUrl) => {
  const command =
    process.platform === "darwin"
      ? "open"
      : (() => {
          if (process.platform === "win32") return "cmd";
          return "xdg-open";
        })();
  const args = process.platform === "win32" ? ["/c", "start", "", targetUrl] : [targetUrl];
  const child = childProcess.spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (err) => {
    console.warn(`Unable to open browser: ${err?.message ? err.message : err}`);
  });
  child.unref();
};

const printUrls = (title, port, lanAddresses, certificatePath, { crossOriginIsolation = true } = {}) => {
  console.log(title);
  console.log(`  https://localhost:${port}/`);
  for (const address of lanAddresses) {
    console.log(`  https://${address}:${port}/`);
  }
  console.log(`Plain HTTP on port ${port} redirects to HTTPS on the same port.`);
  if (!crossOriginIsolation) console.log("COOP/COEP/CORP headers disabled; service worker must provide them.");
  console.log(`Self-signed certificate: ${certificatePath}`);
};

const startDevServer = async (options) => {
  const lanAddresses = getLanAddresses();
  const certificate = ensureCertificate(lanAddresses);
  const securityOptions = { crossOriginIsolation: !options.noCoopCoep };
  let viteServer = null;
  const httpsServer = https.createServer(
    {
      cert: certificate.cert,
      key: certificate.key,
    },
    (req, res) => {
      setSecurityHeaders(res, securityOptions);
      if (handleE2eCorpusRequest(req, res, securityOptions)) return;
      if (!viteServer) {
        send(res, 503, { "Content-Type": "text/plain; charset=utf-8" }, "Vite dev server is starting", securityOptions);
        return;
      }
      viteServer.middlewares(req, res);
    },
  );
  const httpRedirectServer = http.createServer((req, res) => {
    handleRedirect(req, res, options.port, securityOptions);
  });
  const portMuxServer = createPortMuxServer(httpsServer, httpRedirectServer);

  await listen(portMuxServer, options.port, BIND_HOST);
  try {
    viteServer = await createViteServer({
      configFile: path.join(ROOT_DIR, "vite.config.mjs"),
      root: ROOT_DIR,
      server: {
        headers: getSecurityHeaders(securityOptions),
        host: BIND_HOST,
        https: false,
        middlewareMode: { server: httpsServer },
        open: false,
        port: options.port,
        strictPort: true,
        ws: {
          protocol: "wss",
          server: httpsServer,
        },
      },
    });
  } catch (err) {
    await closeNodeServer(portMuxServer);
    throw err;
  }
  installShutdown([portMuxServer, httpsServer, httpRedirectServer], viteServer);
  printUrls("RomWeaver React Vite dev server:", options.port, lanAddresses, certificate.paths.cert, securityOptions);
  if (process.env.ROM_WEAVER_E2E_CORPUS_DIR) {
    for (const address of lanAddresses) {
      console.log(`  iOS stress: https://${address}:${options.port}/mobile-safari-matrix.html?profile=stress`);
    }
  }
  if (options.open) openBrowser(getLocalUrl(options.port));
};

const getContentType = (filePath) => MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";

const acceptsBrotli = (req) => /\bbr\b/i.test(String(req.headers["accept-encoding"] || ""));

const canCompressBrotliOnTheFly = (filePath, data) =>
  data.byteLength <= DYNAMIC_BROTLI_MAX_BYTES && DYNAMIC_BROTLI_TYPES.has(path.extname(filePath).toLowerCase());

const resolveDistRequestPath = (distDir, requestUrl) => {
  const parsed = new URL(requestUrl || "/", "https://localhost");
  const decodedPath = decodeURIComponent(parsed.pathname || "/");
  const normalizedPath = path.normalize(decodedPath).replace(PARENT_DIRECTORY_PREFIX_REGEX, "");
  const filePath = path.join(distDir, normalizedPath);
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath !== distDir && !resolvedPath.startsWith(distDir + path.sep)) return null;
  return resolvedPath;
};

const readPreviewFile = (filePath, fallbackPath, allowFallback, callback) => {
  fs.stat(filePath, (statError, stats) => {
    let resolvedPath = filePath;
    if (!statError && stats.isDirectory()) resolvedPath = path.join(filePath, "index.html");

    fs.readFile(resolvedPath, (readError, data) => {
      if (!readError) {
        callback(null, resolvedPath, data);
        return;
      }
      if (!allowFallback) {
        callback(readError);
        return;
      }
      fs.readFile(fallbackPath, (fallbackError, fallbackData) => {
        if (fallbackError) {
          callback(readError);
          return;
        }
        callback(null, fallbackPath, fallbackData);
      });
    });
  });
};

const readPreviewBrotliFile = (resolvedPath, sourceData, req, callback) => {
  if (!acceptsBrotli(req) || resolvedPath.endsWith(".br")) {
    callback(null, null);
    return;
  }
  const brotliPath = `${resolvedPath}.br`;
  fs.readFile(brotliPath, (readError, brotliData) => {
    if (readError) {
      if (!canCompressBrotliOnTheFly(resolvedPath, sourceData)) {
        callback(null, null);
        return;
      }
      zlib.brotliCompress(
        sourceData,
        { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } },
        (compressError, compressed) => {
          if (compressError || compressed.byteLength >= sourceData.byteLength) {
            callback(null, null);
            return;
          }
          callback(null, { data: compressed, path: brotliPath });
        },
      );
      return;
    }
    callback(null, { data: brotliData, path: brotliPath });
  });
};

const handlePreviewRequest = (distDir, req, res, securityOptions) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, { Allow: "GET, HEAD" }, "Method Not Allowed", securityOptions);
    return;
  }

  let filePath;
  try {
    filePath = resolveDistRequestPath(distDir, req.url);
  } catch {
    send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad Request", securityOptions);
    return;
  }

  if (!filePath) {
    send(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "Forbidden", securityOptions);
    return;
  }

  const fallbackPath = path.join(distDir, "index.html");
  const acceptHeader = req.headers.accept || "";
  const allowFallback = acceptHeader.includes("text/html") || !path.extname(filePath);
  readPreviewFile(filePath, fallbackPath, allowFallback, (readError, resolvedPath, data) => {
    if (readError) {
      send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not Found", securityOptions);
      return;
    }
    readPreviewBrotliFile(resolvedPath, data, req, (_brotliError, brotliFile) => {
      const encoded = Boolean(brotliFile);
      send(
        res,
        200,
        {
          "Cache-Control":
            path.basename(resolvedPath) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
          "Content-Type": getContentType(resolvedPath),
          ...(encoded ? { "Content-Encoding": "br", Vary: "Accept-Encoding" } : {}),
        },
        req.method === "HEAD" ? null : encoded ? brotliFile.data : data,
        securityOptions,
      );
    });
  });
};

const startPreviewServer = async (options) => {
  const distDir = path.join(ROOT_DIR, "dist");
  if (!fs.existsSync(path.join(distDir, "index.html")))
    throw new Error("The dist directory does not exist. Run npm run build before npm run preview.");

  const lanAddresses = getLanAddresses();
  const certificate = ensureCertificate(lanAddresses);
  const securityOptions = { crossOriginIsolation: !options.noCoopCoep };
  const httpsServer = https.createServer(
    {
      cert: certificate.cert,
      key: certificate.key,
    },
    (req, res) => {
      handlePreviewRequest(distDir, req, res, securityOptions);
    },
  );
  const httpRedirectServer = http.createServer((req, res) => {
    handleRedirect(req, res, options.port, securityOptions);
  });
  const portMuxServer = createPortMuxServer(httpsServer, httpRedirectServer);

  await listen(portMuxServer, options.port, BIND_HOST);
  installShutdown([portMuxServer, httpsServer, httpRedirectServer], null);
  printUrls(
    "RomWeaver React Vite preview server:",
    options.port,
    lanAddresses,
    certificate.paths.cert,
    securityOptions,
  );
  if (options.open) openBrowser(getLocalUrl(options.port));
};

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  printUsage();
  process.exit(options.invalid ? 1 : 0);
}

try {
  if (options.mode === "preview") await startPreviewServer(options);
  else await startDevServer(options);
} catch (err) {
  console.error(formatStartupError(err, options));
  process.exitCode = 1;
}
