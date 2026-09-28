import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { coreRecipe, platformConfig, platforms } from "./emulator-runtime/platform.mjs";
import {
  parseDarwinDependencies,
  parseWindowsDependencies,
  unexpectedDarwinDependencies,
  unexpectedWindowsDependencies,
} from "./emulator-runtime/verify-dependencies.mjs";

const sources = JSON.parse(
  fs.readFileSync(new URL("./emulator-runtime/sources.json", import.meta.url), "utf8"),
);

test("the source lock retains all emulator cores and platforms", () => {
  assert.equal(sources.cores.length, 21);
  assert.equal(new Set(sources.cores.map(({ id }) => id)).size, 21);
  assert.deepEqual(sources.platforms, Object.keys(platforms));
});

for (const [name, platform] of Object.entries(platforms)) {
  test(`${name} has complete native recipes`, () => {
    assert.equal(platformConfig(name), platform);
    assert.match(platform.retroarchPath, name === "win32-x64" ? /\.exe$/ : /retroarch$/);
    for (const core of sources.cores.filter(({ id }) => id !== "fceumm")) {
      const recipe = coreRecipe(core, name);
      assert.ok(recipe.build.length > 0, `${core.id} has no build steps`);
      assert.ok(recipe.output.endsWith(platform.coreExtension), core.id);
      const argumentsText = recipe.build.flatMap(({ command }) => command).join("\n");
      assert.ok(
        argumentsText.includes(`platform=${platform.makePlatform}`) || core.id === "mgba",
        `${core.id} lacks the target platform`,
      );
      if (name !== "linux-x64-gnu") {
        assert.ok(!argumentsText.includes("./linux/x86_64"), `${core.id} retains Linux prefix`);
      }
      for (const step of recipe.build) {
        if (step.command.includes("./configure")) assert.equal(step.command[0], "sh");
      }
    }
  });
}

test("unsupported platforms fail closed", () => {
  assert.throws(() => platformConfig("freebsd-x64"), /unsupported/);
});

test("PPSSPP uses each upstream platform directory and native architecture", () => {
  const ppsspp = sources.cores.find(({ id }) => id === "ppsspp");
  for (const [name, expected] of [
    ["linux-x64-gnu", "--prefix=./linux/x86_64"],
    ["darwin-x64", "--prefix=./macosx/universal"],
    ["darwin-arm64", "--prefix=./macosx/universal"],
    ["win32-x64", "--prefix=./Windows/x86_64"],
  ]) {
    const recipe = coreRecipe(ppsspp, name);
    assert.ok(recipe.build[0].command.includes(expected), name);
  }
  const windows = coreRecipe(ppsspp, "win32-x64");
  assert.ok(
    windows.build
      .at(-1)
      .command.includes(
        "FFMPEGLDFLAGS=-L../ffmpeg/Windows/x86_64/lib -lavformat -lavcodec -lavutil -lswresample -lswscale",
      ),
  );
  const arm = coreRecipe(ppsspp, "darwin-arm64");
  assert.ok(arm.build[0].command.includes("--arch=aarch64"));
  assert.ok(arm.build.at(-1).command.includes("TARGET_ARCH=arm64"));
  assert.ok(arm.build.at(-1).command.includes("ARCHFLAGS=-arch arm64"));
  assert.equal(arm.patches.length, 1);
});

test("mGBA avoids untracked native dependencies outside Linux", () => {
  const mgba = sources.cores.find(({ id }) => id === "mgba");
  for (const platform of ["darwin-x64", "darwin-arm64", "win32-x64"]) {
    const configure = coreRecipe(mgba, platform).build[0].command;
    assert.ok(configure.includes("-DSKIP_LIBRARY=ON"), platform);
    assert.ok(configure.includes("-DDISABLE_DEPS=ON"), platform);
  }
  const linux = coreRecipe(mgba, "linux-x64-gnu").build[0].command;
  assert.ok(!linux.includes("-DSKIP_LIBRARY=ON"));
  assert.ok(!linux.includes("-DDISABLE_DEPS=ON"));
});

test("Mupen selects its 64-bit MinGW recipe under UCRT64", () => {
  const mupen = sources.cores.find(({ id }) => id === "mupen64plus_next");
  const recipe = coreRecipe(mupen, "win32-x64");
  assert.ok(recipe.build[0].command.includes("MSYSTEM=MINGW64"));
});

test("Windows dependency inspection rejects toolchain libraries", () => {
  const imports = parseWindowsDependencies(`
    DLL Name: KERNEL32.dll
    DLL Name: api-ms-win-crt-runtime-l1-1-0.dll
    DLL Name: libwinpthread-1.dll
    DLL Name: libstdc++-6.dll
  `);
  assert.deepEqual(unexpectedWindowsDependencies(imports), [
    "libwinpthread-1.dll",
    "libstdc++-6.dll",
  ]);
});

test("macOS dependency inspection rejects build-machine libraries", () => {
  const imports = parseDarwinDependencies(`binary:
Load command 0
          cmd LC_ID_DYLIB
      cmdsize 64
         name fceumm_libretro.dylib (offset 24)
Load command 1
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name /usr/lib/libSystem.B.dylib (offset 24)
Load command 2
          cmd LC_LOAD_WEAK_DYLIB
         name /System/Library/Frameworks/OpenGL.framework/Versions/A/OpenGL (offset 24)
Load command 3
          cmd LC_LOAD_DYLIB
         name /opt/homebrew/opt/zlib/lib/libz.1.dylib (offset 24)
Load command 4
          cmd LC_REEXPORT_DYLIB
         name @rpath/libavcodec.dylib (offset 24)
`);
  assert.deepEqual(unexpectedDarwinDependencies(imports), [
    "/opt/homebrew/opt/zlib/lib/libz.1.dylib",
    "@rpath/libavcodec.dylib",
  ]);
});
