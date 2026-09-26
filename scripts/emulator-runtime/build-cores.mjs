import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const buildDirectory = path.resolve(process.argv[2]);
const runtimeDirectory = path.join(buildDirectory, "runtime");
const sourcePackage = path.join(buildDirectory, "source-package");
const sources = JSON.parse(fs.readFileSync(path.join(scriptDirectory, "sources.json"), "utf8"));
const jobs = process.env.JOBS ?? "2";
assert.match(jobs, /^[1-9][0-9]*$/);
const environment = {
  ...process.env,
  CC: "cc",
  CXX: "c++",
  TMPDIR: path.join(buildDirectory, "tmp"),
};
const run = (command, cwd = buildDirectory, capture = false) =>
  execFileSync(command[0], command.slice(1), {
    cwd,
    env: environment,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
const digest = (filename) => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
const inside = (root, relative) => {
  assert.ok(relative && !path.isAbsolute(relative), `expected relative path: ${relative}`);
  const resolved = path.resolve(root, relative);
  assert.ok(
    resolved.startsWith(`${root}${path.sep}`),
    `path escapes source directory: ${relative}`,
  );
  return resolved;
};
const copyFile = (source, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
};
const unpack = (source, destination) => {
  assert.match(source.revision, /^[a-f0-9]{40}$/);
  assert.match(source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(path.basename(source.archive), source.archive);
  const archive = path.join(buildDirectory, "downloads", source.archive);
  const distributed = path.join(scriptDirectory, "archives", source.archive);
  if (fs.existsSync(distributed)) copyFile(distributed, archive);
  else run(["curl", "--fail", "--location", "--retry", "3", "--output", archive, source.url]);
  assert.equal(digest(archive), source.sha256, `source checksum mismatch: ${source.archive}`);
  copyFile(archive, path.join(sourcePackage, "archives", source.archive));
  fs.mkdirSync(destination, { recursive: true });
  run(["tar", "-xzf", archive, "-C", destination, "--strip-components=1"]);
};

for (const core of sources.cores.filter((core) => core.id !== "fceumm")) {
  assert.match(core.id, /^[a-z0-9_-]+$/);
  const sourceDirectory = path.join(buildDirectory, "src", core.id);
  unpack(core, sourceDirectory);
  for (const dependency of core.dependencies ?? [])
    unpack(dependency, inside(sourceDirectory, dependency.path));
  for (const patch of core.patches ?? []) {
    const filename = inside(sourceDirectory, patch.path);
    const contents = fs.readFileSync(filename, "utf8");
    assert.ok(
      contents.includes(patch.find),
      `source patch no longer applies: ${core.id}/${patch.path}`,
    );
    fs.writeFileSync(filename, contents.replace(patch.find, patch.replace));
  }
  for (const step of core.build) {
    const cwd = step.cwd === "." ? sourceDirectory : inside(sourceDirectory, step.cwd);
    run(
      step.command.map((argument) => argument.replaceAll("{jobs}", jobs)),
      cwd,
    );
  }
  copyFile(
    inside(sourceDirectory, core.output),
    path.join(runtimeDirectory, "cores", `${core.id}_libretro.so`),
  );
  for (const license of core.licenses) {
    copyFile(
      inside(sourceDirectory, license),
      path.join(runtimeDirectory, "licenses", core.id, license),
    );
  }
  for (const asset of core.assets ?? []) {
    const destination = inside(path.join(runtimeDirectory, "system"), asset.destination);
    fs.cpSync(inside(sourceDirectory, asset.source), destination, {
      recursive: true,
      dereference: false,
    });
  }
}

const fileList = (directory) => {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), `runtime assets must not be symlinks: ${filename}`);
      if (entry.isDirectory()) return fileList(filename);
      assert.ok(entry.isFile(), `runtime asset must be a regular file: ${filename}`);
      return [filename];
    })
    .sort();
};
const cores = sources.cores.map((core) => {
  const filename = path.join(runtimeDirectory, "cores", `${core.id}_libretro.so`);
  const info = JSON.parse(
    run(["python3", path.join(scriptDirectory, "inspect-core.py"), filename], buildDirectory, true),
  );
  for (const extension of core.extensions) {
    assert.ok(info.extensions.includes(extension), `${core.id} does not advertise .${extension}`);
  }
  console.log(`Loaded ${core.id}: ${info.name} ${info.version}`);
  return {
    id: core.id,
    platform: core.platform,
    path: `cores/${core.id}_libretro.so`,
    revision: core.revision,
    sha256: digest(filename),
    extensions: core.extensions,
    options: core.options ?? {},
    firmware: core.firmware ?? [],
  };
});
const systemFiles = fileList(path.join(runtimeDirectory, "system")).map((filename) => ({
  path: path.relative(runtimeDirectory, filename).split(path.sep).join("/"),
  sha256: digest(filename),
}));
fs.writeFileSync(
  path.join(runtimeDirectory, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 2,
      platform: sources.platform,
      retroarch: {
        path: "bin/retroarch",
        revision: sources.retroarch.revision,
        sha256: digest(path.join(runtimeDirectory, "bin", "retroarch")),
      },
      cores,
      systemFiles,
    },
    null,
    2,
  )}\n`,
);
fs.cpSync(path.join(runtimeDirectory, "licenses"), path.join(sourcePackage, "licenses"), {
  recursive: true,
});
