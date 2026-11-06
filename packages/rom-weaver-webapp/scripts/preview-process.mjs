import { spawn } from "node:child_process";
import https from "node:https";
import net from "node:net";
import process from "node:process";

// A fixed port collides with a preview server the developer already has up and
// with a second worktree running the same script in parallel.
export const findFreePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const waitForServer = (origin) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const attempt = () => {
      const request = https.get(origin, { rejectUnauthorized: false }, (response) => {
        response.resume();
        if ((response.statusCode || 500) < 500) resolve();
        else retry();
      });
      request.on("error", retry);
      request.setTimeout(1000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() >= deadline) reject(new Error("preview server did not become ready within 15 seconds"));
      else setTimeout(attempt, 100);
    };
    attempt();
  });

export const stopPreviewServer = (server) =>
  new Promise((resolve) => {
    if (server.exitCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    server.kill("SIGTERM");
  });

// Runs `<packageDir>/scripts/dev-server.mjs preview`, which serves `<packageDir>/dist`.
export const startPreviewServer = async (packageDir, port, origin) => {
  const server = spawn(process.execPath, ["scripts/dev-server.mjs", "preview", "--port", String(port)], {
    cwd: packageDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk;
  });
  server.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((_, reject) => {
    server.once("exit", (code) => reject(new Error(`preview server exited with ${code}\n${output}`)));
  });
  try {
    await Promise.race([waitForServer(origin), exited]);
  } catch (error) {
    // A readiness timeout leaves a spawned server nobody owns, holding the port
    // against the next attempt.
    await stopPreviewServer(server);
    throw error;
  }
  return server;
};
