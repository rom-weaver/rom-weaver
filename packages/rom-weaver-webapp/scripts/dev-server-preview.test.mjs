import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.dirname(SCRIPTS_DIR);
const NOT_FOUND_PAGE = "<!doctype html><title>fixture not found</title>";
const STARTUP_TIMEOUT_MS = 60_000;

let workDir;
let server;
let port;

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port: freePort } = probe.address();
      probe.close(() => resolve(freePort));
    });
  });

// The preview server serves `<its own package>/dist`, so run a copy of it from a throwaway package whose
// sibling scripts, sources and dependencies are the real ones and whose dist holds only the two pages the
// 404 paths read. The real dist stays untouched, and the test needs no build.
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
  return scriptsDir;
};

const startPreviewServer = (scriptsDir, previewPort) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(scriptsDir, "dev-server.mjs"), "preview", "--port", String(previewPort)],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const timer = setTimeout(() => reject(new Error(`preview server did not start:\n${output}`)), STARTUP_TIMEOUT_MS);
    const onOutput = (chunk) => {
      output += chunk;
      // The certificate line prints once the listeners are up.
      if (output.includes("Self-signed certificate:")) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.setEncoding("utf8").on("data", onOutput);
    child.stderr.setEncoding("utf8").on("data", onOutput);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`preview server exited with ${code} before it was ready:\n${output}`));
    });
  });

const stopPreviewServer = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.removeAllListeners("exit");
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });

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
  server = await startPreviewServer(stageFixturePackage(), port);
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
