import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import { copy, inside } from "./tree.mjs";

function validatePaths(text) {
  if (!text.startsWith("diff --git ")) throw new Error("patch MUST begin with a diff --git header");
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const path = line.slice(4).split("\t")[0];
      if (path === "/dev/null") continue;
      if (!/^[ab]\//.test(path)) throw new Error(`Patch path must start with a/ or b/: ${path}`);
      inside("/patch-root", path.slice(2));
      count++;
    }
    if (
      /^(GIT binary patch|Binary files |rename (from|to) |copy (from|to) |(?:new|old) mode |new file mode 120000)/.test(
        line,
      )
    ) {
      throw new Error(`Unsupported patch record: ${line}`);
    }
  }
  if (!count) throw new Error("Patch has no file headers");
}

export function applyPatches(manifest, tree, stages) {
  for (const patch of manifest.patches.filter((entry) => stages.includes(entry.stage))) {
    const path = inside(manifest.directory, patch.file);
    const text = readFileSync(path, "utf8");
    const env = {
      ...process.env,
      GIT_CEILING_DIRECTORIES: dirname(tree),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_COUNT: "0",
    };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_CONFIG",
      "GIT_CONFIG_PARAMETERS",
    ])
      delete env[key];
    const options = {
      cwd: tree,
      input: text,
      encoding: "utf8",
      env,
      stdio: ["pipe", "pipe", "pipe"],
    };
    try {
      validatePaths(text);
      execFileSync("git", ["apply", "--check", "--whitespace=nowarn", "-"], options);
      execFileSync("git", ["apply", "--whitespace=nowarn", "-"], options);
    } catch (error) {
      throw new Error(
        `${manifest.name}: patch ${patch.file} conflicts; ${error.stderr?.toString().trim() || error.message}`,
        { cause: error },
      );
    }
  }
}

function applyAdapters(root, manifest, tree) {
  for (const adapter of manifest.adapters ?? []) {
    const source = inside(root, `crates/rom-weaver-containers/${adapter.file}`);
    const target = inside(tree, adapter.target);
    mkdirSync(dirname(target), { recursive: true });
    if (adapter.mode === "append")
      appendFileSync(target, Buffer.concat([Buffer.from("\n"), readFileSync(source)]));
    else copy(source, target);
  }
}

export function replay(root, manifest, pristine, work) {
  const common = join(work, "patched");
  copy(pristine, common);
  applyPatches(manifest, common, ["source", "integration", "build"]);
  applyAdapters(root, manifest, common);
  if (manifest.materialized) return common;
  for (const stage of ["wasm", "arm64"]) {
    if (!manifest.patches.some((patch) => patch.stage === stage)) continue;
    const variant = join(work, stage);
    copy(common, variant);
    applyPatches(manifest, variant, [stage]);
  }
  return pristine;
}
