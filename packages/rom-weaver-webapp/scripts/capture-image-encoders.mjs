import { spawn } from "node:child_process";
import os from "node:os";
import { Worker } from "node:worker_threads";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// Runs ImageMagick without blocking the event loop, so the next page capture
// proceeds while a previous image is still being cropped or converted.
const runMagick = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    let outBytes = 0;
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        reject(new Error(`${command} produced more than ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", () => {
      // A command that exits early closes stdin; its exit status below reports the failure.
    });
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${command} exited with ${code}: ${Buffer.concat(err).toString().slice(0, 1000)}`));
    });
    child.stdin.end(input);
  });

// Encoding runs in the same wasm encoder as before, so bytes are unchanged; the
// workers only move that CPU-bound work off the thread that drives the browser.
const defaultWorkerCount = () => Math.min(3, Math.max(1, Math.floor(os.availableParallelism() / 2)));

const createAvifEncoderPool = (size = defaultWorkerCount()) => {
  const workerUrl = new URL("./capture-avif-worker.mjs", import.meta.url);
  const idle = [];
  const waiting = [];
  const workers = [];
  const release = (worker) => {
    const next = waiting.shift();
    if (next) next(worker);
    else idle.push(worker);
  };
  for (let index = 0; index < size; index++) {
    const worker = new Worker(workerUrl);
    workers.push(worker);
    idle.push(worker);
  }
  const acquire = () => (idle.length ? Promise.resolve(idle.pop()) : new Promise((resolve) => waiting.push(resolve)));
  const encode = async (png, quality) => {
    const worker = await acquire();
    try {
      return await new Promise((resolve, reject) => {
        const cleanup = () => {
          worker.off("message", onMessage);
          worker.off("error", onError);
        };
        const onMessage = (message) => {
          cleanup();
          if (message.error) reject(new Error(message.error));
          else resolve(Buffer.from(message.avif));
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        worker.on("message", onMessage);
        worker.on("error", onError);
        worker.postMessage({ png, quality });
      });
    } finally {
      release(worker);
    }
  };
  const close = () => Promise.all(workers.map((worker) => worker.terminate()));
  return { close, encode };
};

export { createAvifEncoderPool, defaultWorkerCount, runMagick };
