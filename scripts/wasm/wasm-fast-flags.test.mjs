import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// RUSTFLAGS replaces the target rustflags, so the fast build must restate every one of them except `linker-plugin-lto`.
test("build-wasm-fast restates the target rustflags without linker-plugin-lto", () => {
  const cargoConfig = read("../../.cargo/config.toml");
  const threads = cargoConfig.slice(cargoConfig.indexOf("[target.wasm32-wasip1-threads]"));
  const list = threads.slice(threads.indexOf("rustflags = ["), threads.indexOf("]", threads.indexOf("rustflags = [")));
  const wanted = [...list.matchAll(/^\s*"-([CD])", "([^"]+)",/gm)].map((match) => `-${match[1]} ${match[2]}`).filter((flag) => flag !== "-C linker-plugin-lto");
  assert.ok(wanted.length >= 5, `parsed ${wanted.length} flags from .cargo/config.toml`);

  const mise = read("../../.config/mise.toml");
  const task = mise.slice(mise.indexOf("[tasks.build-wasm-fast]"));
  const rustflags = task.match(/^env\.RUSTFLAGS = "([^"]*)"/m)?.[1];
  assert.ok(rustflags, "build-wasm-fast sets RUSTFLAGS");
  assert.deepEqual(rustflags.split(" -").map((flag, index) => (index === 0 ? flag : `-${flag}`)), wanted);
});
