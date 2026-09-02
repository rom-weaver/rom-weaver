import assert from "node:assert/strict";
import test from "node:test";

import { areAptPackagesInstalled, installAptPackages } from "./install-system-dependencies.mjs";

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

test("updates and installs when an apt package is missing", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === "dpkg-query" && args.at(-1) === "ninja-build") {
      throw new Error("package is not installed");
    }
    return "install ok installed";
  };

  assert.equal(installAptPackages(["cmake", "ninja-build"], run), true);
  assert.deepEqual(calls.slice(-2), [
    ["sudo", ["apt-get", "update"]],
    ["sudo", ["apt-get", "install", "--yes", "cmake", "ninja-build"]],
  ]);
});
