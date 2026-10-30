// Oracle for BSP vectors: the upstream bsppatch.js runtime vendored in crates/rom-weaver-patches
// (https://github.com/aaaaaa123456789/bsp), run under node:vm in a child process (the runtime is
// timer-driven, so it cannot finish synchronously in-process).
import { spawnSync } from "node:child_process";
import path from "node:path";

const CHILD = `
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(process.env.BSP_RUNTIME, "utf8");
const context = { setTimeout };
vm.createContext(context);
vm.runInContext(source, context);
const slice = (hex) => { const b = Buffer.from(hex, "hex"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const patcher = new context.BSPPatcher(slice(process.env.PATCH_HEX), slice(process.env.INPUT_HEX));
patcher.print = () => patcher.run();
patcher.menu = () => patcher.run(0);
patcher.success = (out) => process.stdout.write(JSON.stringify({ state: "ok", out: Buffer.from(new Uint8Array(out)).toString("hex") }));
patcher.failure = (code) => process.stdout.write(JSON.stringify({ state: "failure", code: Number(code) }));
patcher.error = (error) => process.stdout.write(JSON.stringify({ state: "error", error: String(error) }));
patcher.run();
`;

export const runBspReference = (root, patch, input) => {
  const result = spawnSync(process.execPath, ["-e", CHILD], {
    encoding: "utf8",
    env: {
      ...process.env,
      BSP_RUNTIME: path.join(root, "crates/rom-weaver-patches/src/bsp_vm_runtime.js"),
      PATCH_HEX: Buffer.from(patch).toString("hex"),
      INPUT_HEX: Buffer.from(input).toString("hex"),
    },
  });
  if (result.status !== 0 || !result.stdout) return { state: "error", error: result.stderr || "oracle produced no output" };
  const parsed = JSON.parse(result.stdout);
  return parsed.state === "ok" ? { state: "ok", out: Buffer.from(parsed.out, "hex") } : parsed;
};
