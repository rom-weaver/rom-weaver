import assert from "node:assert/strict";
import test from "node:test";

import {
  areAptPackagesInstalled,
  findLibclangDir,
  installAptPackages,
  main,
} from "./install-system-dependencies.mjs";

test("recognizes when every requested apt package is installed", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return "install ok installed";
  };

  assert.equal(areAptPackagesInstalled(["cmake", "ninja-build"], run), true);
  assert.deepEqual(calls, [
    ["dpkg-query", ["-W", "-f=${Status}", "cmake"]],
    ["dpkg-query", ["-W", "-f=${Status}", "ninja-build"]],
  ]);
});

test("updates and installs from Ubuntu when an apt package is missing", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === "ninja") {
      throw new Error("package is not installed");
    }
    return "cmake version 3.31.0";
  };

  assert.equal(installAptPackages(["cmake", "ninja-build"], run), true);
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
  assert.deepEqual(calls.slice(-2), [
    ["sudo", ["apt-get", ...sourceOptions, "update"]],
    ["sudo", ["apt-get", ...sourceOptions, "install", "--yes", "ninja-build"]],
  ]);
});

test("does not refresh sources when every requested apt package is installed", () => {
  const run = (command) => {
    assert.equal(command, "dpkg-query");
    return "install ok installed";
  };

  assert.equal(installAptPackages(["custom-package", "another-package"], run), false);
});

test("does not install packages after an Ubuntu index failure", () => {
  const failure = new Error("Hash Sum mismatch");
  const run = (command, args) => {
    if (command === "cmake") throw new Error("missing command");
    assert.equal(args.at(-1), "update");
    throw failure;
  };

  assert.throws(
    () => installAptPackages(["cmake"], run),
    (error) => error === failure,
  );
});

test("working tools avoid apt even without unversioned Debian packages", () => {
  const calls = [];
  const run = (command) => {
    calls.push(command);
    if (command === "dpkg-query") throw new Error("not installed");
    if (command === "sudo") throw new Error("APT must not run");
    return "cmake version 3.31.0";
  };
  assert.equal(installAptPackages(["cmake"], run), false);
  assert.deepEqual(calls, ["cmake"]);
});

test("broken or incompatible tools fall back to one bounded apt pass", () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "cmake") return "unrelated executable";
    if (command === "ccache") throw new Error("broken executable");
    return "";
  };
  assert.equal(installAptPackages(["cmake", "ccache", "ccache"], run), true);
  const apt = calls.filter(({ command }) => command === "sudo");
  assert.equal(apt.length, 2);
  assert.deepEqual(apt[1].args.slice(-2), ["cmake", "ccache"]);
  assert.ok(apt.every(({ options }) => options.timeout === 300_000));
});

test("loadable libclang avoids apt; unusable libclang retains fallback", () => {
  assert.equal(
    installAptPackages(
      ["libclang-dev"],
      () => assert.fail("APT must not run"),
      () => "/usr/lib/llvm-18/lib",
    ),
    false,
  );
  const calls = [];
  assert.equal(
    installAptPackages(
      ["libclang-dev"],
      (command, args) => calls.push([command, args]),
      () => "",
    ),
    true,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].at(-1), "libclang-dev");
});

test("libclang discovery skips unloadable candidates and requires bindgen symbols", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === "find") return "/broken/libclang.so\n/working/libclang.so.18\n";
    assert.equal(command, "python3");
    assert.match(args[1], /ctypes.CDLL/);
    assert.match(args[1], /clang_createIndex/);
    if (args.at(-1).startsWith("/broken")) throw new Error("cannot load");
    return "";
  };
  assert.equal(findLibclangDir([process.cwd()], run), "/working");
  assert.equal(calls.length, 3);
});

test("Linux bootstrap combines requested dependencies and both compiler caches", () => {
  const calls = [];
  main(
    {
      RUNNER_OS: "Linux",
      APT_PACKAGES: "cmake ninja-build",
      INSTALL_CCACHE: "true",
      INSTALL_SCCACHE: "true",
    },
    (command, args) => {
      calls.push([command, args]);
      if (command === "sudo" || command === "find") return "";
      throw new Error("missing tool");
    },
  );
  const apt = calls.filter(([command]) => command === "sudo");
  assert.equal(apt.length, 2);
  assert.deepEqual(apt[1][1].slice(-4), ["cmake", "ninja-build", "ccache", "sccache"]);
});

test("working ImageMagick skips the package-manager fallback", () => {
  assert.equal(
    installAptPackages(["imagemagick"], (command, args) => {
      assert.equal(command, "convert");
      assert.deepEqual(args, ["--version"]);
      return "Version: ImageMagick 6.9.12-98";
    }),
    false,
  );
});

test("existing LIBCLANG_PATH is probed and reused without a second scan", () => {
  let scans = 0;
  main({ APT_PACKAGES: "libclang-dev", LIBCLANG_PATH: process.cwd() }, (command, args) => {
    if (command === "find") {
      scans += 1;
      assert.equal(args[0], process.cwd());
      return `${process.cwd()}/libclang.so\n`;
    }
    assert.equal(command, "python3");
    return "";
  });
  assert.equal(scans, 1);
});

test("CMake below libarchive's 3.17 minimum retains package fallback", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return command === "cmake" ? "cmake version 3.16.3" : "";
  };
  assert.equal(installAptPackages(["cmake"], run), true);
  assert.equal(calls.filter(([command]) => command === "sudo").length, 2);
});
