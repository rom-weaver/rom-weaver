import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { findFreePort, startPreviewServer, stopPreviewServer } from "./preview-process.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.dirname(SCRIPTS_DIR);
const NOT_FOUND_PAGE = "<!doctype html><title>fixture not found</title>";
const ROUTE_PAGE = "<!doctype html><title>fixture route</title>";

let workDir;
let server;
let port;

// The preview server serves `<its own package>/dist`, so run a copy of it from a throwaway package whose
// sibling scripts, sources and dependencies are the real ones and whose dist holds only the fixture files below.
// The real dist stays untouched, and the test needs no build.
const stageFixturePackage = () => {
  const packageDir = path.join(workDir, "package");
  const scriptsDir = path.join(packageDir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const entry of fs.readdirSync(SCRIPTS_DIR)) {
    if (entry === "dev-server.mjs") continue;
    fs.symlinkSync(path.join(SCRIPTS_DIR, entry), path.join(scriptsDir, entry));
  }
  fs.copyFileSync(path.join(SCRIPTS_DIR, "dev-server.mjs"), path.join(scriptsDir, "dev-server.mjs"));
  for (const entry of ["node_modules", "src"]) {
    fs.symlinkSync(path.join(PACKAGE_DIR, entry), path.join(packageDir, entry));
  }
  fs.mkdirSync(path.join(packageDir, "dist"));
  fs.writeFileSync(path.join(packageDir, "dist", "index.html"), "<!doctype html><title>fixture</title>");
  fs.writeFileSync(path.join(packageDir, "dist", "404.html"), NOT_FOUND_PAGE);
  fs.mkdirSync(path.join(packageDir, "dist", "route"));
  fs.writeFileSync(path.join(packageDir, "dist", "route", "index.html"), ROUTE_PAGE);
  return packageDir;
};

const get = (pathname, accept) =>
  new Promise((resolve, reject) => {
    const request = https.get(
      { headers: { Accept: accept }, host: "127.0.0.1", path: pathname, port, rejectUnauthorized: false },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode,
          }),
        );
      },
    );
    request.once("error", reject);
  });

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-preview-404-"));
  port = await findFreePort();
  server = await startPreviewServer(stageFixturePackage(), port, `https://127.0.0.1:${port}`);
});

after(async () => {
  if (server) await stopPreviewServer(server);
  if (workDir) fs.rmSync(workDir, { force: true, recursive: true });
});

test("preview answers a missed asset request that accepts anything with an uncacheable plain-text 404", async () => {
  const response = await get("/assets/missing.js", "*/*");
  assert.equal(response.status, 404);
  assert.match(response.headers["content-type"], /^text\/plain\b/);
  assert.match(response.headers["cache-control"], /\bno-store\b/);
  assert.doesNotMatch(response.headers["cache-control"], /immutable|max-age=[1-9]/);
  assert.equal(response.body, "Not Found");
  assert.notEqual(response.body, NOT_FOUND_PAGE);
});

test("preview answers a missed navigation with the 404 page and no-store", async () => {
  const response = await get("/assets/missing.js", "text/html");
  assert.equal(response.status, 404);
  assert.match(response.headers["content-type"], /^text\/html\b/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body, NOT_FOUND_PAGE);
});

test("preview redirects a bare directory to its trailing-slash form with a relative target", async () => {
  const response = await get("/route?a=1", "text/html");
  assert.equal(response.status, 308);
  assert.equal(response.headers.location, "route/?a=1");
  assert.equal(response.headers["cache-control"], "no-store");
});

test("preview serves a directory index at its trailing-slash URL", async () => {
  const response = await get("/route/", "text/html");
  assert.equal(response.status, 200);
  assert.equal(response.body, ROUTE_PAGE);
});

test("preview answers a path segment longer than the file system allows without ending the process", async () => {
  const response = await get(`/${"a".repeat(300)}`, "text/html");
  assert.equal(response.status, 404);
  assert.equal((await get("/route/", "text/html")).status, 200);
});

test("preview refuses a path with a NUL byte without ending the process", async () => {
  const response = await get("/%00", "text/html");
  assert.equal(response.status, 403);
  assert.equal((await get("/route/", "text/html")).status, 200);
});
