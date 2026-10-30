// Reuse an already-running preview server, or start our own (and stop it again on close()).
import { spawn } from "node:child_process";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEBAPP_DIR = path.resolve(HERE, "../../..");

const probe = (url) =>
  new Promise((resolve) => {
    const request = https.get(url, { rejectUnauthorized: false, timeout: 4000 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 400);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });

export async function ensureServer(baseUrl, port) {
  if (await probe(baseUrl)) return { started: false, close: async () => undefined };
  const child = spawn("node", ["scripts/dev-server.mjs", "preview", "--port", String(port)], {
    cwd: WEBAPP_DIR,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await probe(baseUrl)) {
      console.log(`[matrix] started preview server pid ${child.pid} on :${port}`);
      return { started: true, pid: child.pid, close: async () => child.kill() };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill();
  throw new Error(`preview server did not come up at ${baseUrl} (build dist first: npm run build)`);
}
