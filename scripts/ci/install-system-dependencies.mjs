#!/usr/bin/env node

// Reuses working runner tools before installing missing system dependencies.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

export function findLibclangDir(roots = ["/usr/lib", "/usr/lib64"], run = execFileSync) {
  const present = roots.filter((root) => existsSync(root));
  if (!present.length) return "";
  let paths;
  try {
    paths = run("find", [...present, "-name", "libclang.so*"], {
      encoding: "utf8",
      timeout: 30_000,
    });
  } catch (error) {
    paths = error.stdout || "";
  }
  for (const path of paths.split(/\r?\n/).filter(Boolean)) {
    try {
      run(
        "python3",
        [
          "-c",
          "import ctypes,sys; lib=ctypes.CDLL(sys.argv[1]); lib.clang_createIndex; lib.clang_disposeIndex; lib.clang_getClangVersion",
          path,
        ],
        { stdio: "ignore", timeout: 10_000 },
      );
      return dirname(path);
    } catch {
      // A library MUST load with bindgen's entry points before it replaces libclang-dev.
    }
  }
  return "";
}

const commands = {
  cmake: ["cmake", /cmake version \d/],
  "ninja-build": ["ninja", /^\d+\.\d/],
  "pkg-config": ["pkg-config", /^\d+\.\d/],
  clang: ["clang", /clang version \d/],
  ccache: ["ccache", /ccache version \d/],
  sccache: ["sccache", /sccache \d/],
  imagemagick: ["convert", /Version: ImageMagick \d/],
};

function dependencyAvailable(packageName, run, libclang) {
  if (packageName === "libclang-dev") return Boolean(libclang());
  const command = commands[packageName];
  if (!command) return areAptPackagesInstalled([packageName], run);
  try {
    const version = run(command[0], ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    if (packageName === "cmake") {
      const match = version.match(/cmake version (\d+)\.(\d+)/);
      return Boolean(
        match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 17)),
      );
    }
    return command[1].test(version);
  } catch {
    return false;
  }
}

export function areAptPackagesInstalled(packages, run = execFileSync) {
  return packages.every((packageName) => {
    try {
      const status = run("dpkg-query", ["-W", "-f=${Status}", packageName], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      });
      return status.trim() === "install ok installed";
    } catch {
      return false;
    }
  });
}

export function installAptPackages(
  packages,
  run = execFileSync,
  libclang = () => findLibclangDir(undefined, run),
) {
  const missing = [...new Set(packages)].filter(
    (name) => !dependencyAvailable(name, run, libclang),
  );
  if (!missing.length) return false;

  // CI packages MUST use Ubuntu sources so unrelated repositories cannot block setup.
  // See https://manpages.ubuntu.com/manpages/noble/man5/apt.conf.5.html for source selection.
  const sourceOptions = [
    "-o",
    "Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources",
    "-o",
    "Dir::Etc::sourceparts=-",
    "-o",
    "Acquire::Retries=2",
    "-o",
    "Acquire::http::Timeout=30",
    "-o",
    "Acquire::https::Timeout=30",
    "-o",
    "DPkg::Lock::Timeout=60",
  ];
  run("sudo", ["apt-get", ...sourceOptions, "update"], { stdio: "inherit", timeout: 300_000 });
  run("sudo", ["apt-get", ...sourceOptions, "install", "--yes", ...missing], {
    stdio: "inherit",
    timeout: 300_000,
  });
  return true;
}

export function main(env = process.env, run = execFileSync) {
  const packages = (env.APT_PACKAGES || "").split(/\s+/).filter(Boolean);
  if (env.RUNNER_OS === "Linux") {
    if (env.INSTALL_CCACHE === "true") packages.push("ccache");
    if (env.INSTALL_SCCACHE === "true") packages.push("sccache");
  }
  if (!packages.length) return;

  let libclang = "";
  const discoverLibclang = () =>
    (libclang = findLibclangDir(
      env.LIBCLANG_PATH ? [env.LIBCLANG_PATH, "/usr/lib", "/usr/lib64"] : undefined,
      run,
    ));
  try {
    const installed = !installAptPackages(packages, run, discoverLibclang);
    process.stdout.write(
      installed
        ? `system dependencies already available: ${packages.join(" ")}\n`
        : "missing system dependencies installed\n",
    );
  } catch (error) {
    process.stderr.write(`installing apt packages failed: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (!packages.includes("libclang-dev") && !packages.includes("clang")) return;
  libclang ||= discoverLibclang();
  if (libclang && env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `LIBCLANG_PATH=${libclang}\n`);
  process.stdout.write(
    libclang ? `LIBCLANG_PATH=${libclang}\n` : "no libclang found; leaving LIBCLANG_PATH unset\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
