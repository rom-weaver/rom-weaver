#!/usr/bin/env node

// Hands a CLI platform package from the release pull request's CI run to the release's platform
// build, so the release ships the bytes CI built and tested instead of compiling them again.
//
//   pack     CI, release pull request runs only: copy the staged package (everything but the
//            identify tree, which every run rebuilds from the shared packs) and a build.json that
//            records what was built, from which tree, and the sha256 of every copied file.
//   verify   release: refuse the artifact unless it is for this package, target and tree, every
//            file matches its recorded sha256, and the binary's header is for the target.
//   install  release: lay the verified files into the package directory and add the identify tree
//            the way scripts/prepare-npm-platform-package.mjs does.
//
// Any thrown error means "do not reuse"; the caller then builds from source as before.

import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertBinaryTarget } from "./binary-target.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SCHEMA = 1;
const PACKAGE_DIR = "package";
/** Name of the artifact ci.yml uploads for a platform package on a release pull request run. */
export const artifactName = (name) => `release-cli-${name}`;
const MANIFEST = "build.json";

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function listFiles(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(path, base);
    if (!entry.isFile()) throw new Error(`${path} is not a regular file`);
    return [relative(base, path).split(sep).join("/")];
  });
}

const packageRoot = (root, name) => resolve(root, "packages/rom-weaver-cli-platforms", name);

export function pack({ root = repoRoot, name, target, binary, tree, sourceSha, repository, runId, runAttempt, out }) {
  const source = packageRoot(root, name);
  const destination = join(out, PACKAGE_DIR);
  rmSync(out, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true, filter: (path) => relative(source, path).split(sep)[0] !== "share" });
  const files = Object.fromEntries(listFiles(destination).map((path) => [path, sha256(join(destination, path))]));
  const binaryPath = `bin/${binary}`;
  if (!files[binaryPath]) throw new Error(`${source} has no staged ${binaryPath}`);
  const manifest = { schema: SCHEMA, package: name, target, binary: binaryPath, tree, sourceSha, repository, runId, runAttempt, files };
  writeFileSync(join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function verify({ dir, name, target, binary, tree, repository }) {
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  const expect = { schema: SCHEMA, package: name, target, binary: `bin/${binary}`, tree, repository };
  for (const [key, value] of Object.entries(expect)) {
    if (manifest[key] !== value) throw new Error(`build.json ${key} is ${JSON.stringify(manifest[key])}, expected ${JSON.stringify(value)}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(manifest.sourceSha ?? "")) throw new Error("build.json has no source commit");
  const directory = join(dir, PACKAGE_DIR);
  const actual = listFiles(directory);
  const recorded = Object.keys(manifest.files ?? {});
  if (actual.length !== recorded.length || actual.some((path) => !(path in manifest.files)))
    throw new Error("the artifact's files differ from build.json");
  for (const path of actual) {
    if (sha256(join(directory, path)) !== manifest.files[path]) throw new Error(`${path} does not match its recorded sha256`);
  }
  assertBinaryTarget(join(directory, manifest.binary), target);
  return manifest;
}

export function install({ root = repoRoot, dir, name }) {
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  const destination = packageRoot(root, name);
  cpSync(join(dir, PACKAGE_DIR), destination, { recursive: true });
  const tree = resolve(root, "target", "identify-release", "share");
  if (!existsSync(tree)) throw new Error(`${tree} is missing; build the identify release tree first`);
  const share = resolve(destination, "share");
  rmSync(share, { recursive: true, force: true });
  mkdirSync(dirname(share), { recursive: true });
  cpSync(tree, share, { recursive: true });
  const binary = resolve(destination, manifest.binary);
  if (!binary.endsWith(".exe")) chmodSync(binary, 0o755);
  return { binary, sha256: manifest.files[manifest.binary] };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      package: { type: "string" },
      target: { type: "string" },
      binary: { type: "string" },
      tree: { type: "string" },
      "source-sha": { type: "string" },
      repository: { type: "string", default: env.GITHUB_REPOSITORY },
      "run-id": { type: "string", default: env.GITHUB_RUN_ID },
      "run-attempt": { type: "string", default: env.GITHUB_RUN_ATTEMPT },
      out: { type: "string" },
      dir: { type: "string" },
      root: { type: "string", default: repoRoot },
    },
  });
  const common = { name: values.package, target: values.target, binary: values.binary, tree: values.tree, repository: values.repository };
  if (command === "pack")
    return pack({ ...common, root: values.root, sourceSha: values["source-sha"], runId: values["run-id"], runAttempt: values["run-attempt"], out: values.out });
  if (command === "verify") return verify({ ...common, dir: values.dir });
  if (command === "install") return install({ root: values.root, dir: values.dir, name: values.package });
  throw new Error("usage: cli-release-binary.mjs pack|verify|install [options]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { package: name, tree, sourceSha, runId, binary, sha256: digest } = main();
    process.stdout.write(`${process.argv[2]} ok: ${JSON.stringify({ name, tree, sourceSha, runId, binary, sha256: digest })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
