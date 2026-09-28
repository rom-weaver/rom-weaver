import assert from "node:assert/strict";

export const platforms = {
  "linux-x64-gnu": {
    coreExtension: ".so",
    makePlatform: "unix",
    retroarchPath: "bin/retroarch",
    ffmpegPrefix: "linux/x86_64",
  },
  "darwin-x64": {
    coreExtension: ".dylib",
    makePlatform: "osx",
    retroarchPath: "bin/retroarch",
    ffmpegPrefix: "macosx/universal",
  },
  "darwin-arm64": {
    coreExtension: ".dylib",
    makePlatform: "osx",
    retroarchPath: "bin/retroarch",
    ffmpegPrefix: "macosx/universal",
  },
  "win32-x64": {
    coreExtension: ".dll",
    makePlatform: "win",
    retroarchPath: "bin/retroarch.exe",
    ffmpegPrefix: "Windows/x86_64",
  },
};

export const platformConfig = (name) => {
  assert.ok(platforms[name], `unsupported emulator runtime platform: ${name}`);
  return platforms[name];
};

export const coreRecipe = (core, platformName) => {
  const platform = platformConfig(platformName);
  const build = structuredClone(core.build ?? []);
  let output = core.output?.replace(/\.so$/, platform.coreExtension);
  for (const step of build) {
    step.command = step.command.map((argument) => {
      if (argument === "platform=unix") return `platform=${platform.makePlatform}`;
      if (argument === "CC=cc") return "CC={cc}";
      if (argument === "CXX=c++") return "CXX={cxx}";
      if (argument === "make") return "{make}";
      if (argument.includes("./linux/x86_64")) {
        return argument.replace("./linux/x86_64", `./${platform.ffmpegPrefix}`);
      }
      if (argument === "--arch=x86_64" && platformName === "darwin-arm64") {
        return "--arch=aarch64";
      }
      if (argument === "--arch=x86_64" && platformName === "win32-x64") {
        return "--arch=x86_64";
      }
      return argument;
    });
    if (step.command[0] === "./configure") step.command.unshift("sh");
  }
  if (core.id === "mgba") output = `build/mgba_libretro${platform.coreExtension}`;
  if (core.id === "mgba" && platformName !== "linux-x64-gnu") {
    build[0].command.push("-DSKIP_LIBRARY=ON", "-DDISABLE_DEPS=ON");
  }
  if (core.id === "mupen64plus_next" && platformName === "win32-x64") {
    build.at(-1).command.push("MSYSTEM=MINGW64");
  }
  const patches = [];
  if (core.id === "ppsspp" && platformName === "darwin-arm64") {
    patches.push({
      path: "libretro/Makefile",
      find: "ifneq (,$(findstring 64,$(TARGET_ARCH)))",
      replace: "ifneq (,$(filter x86_64 amd64,$(TARGET_ARCH)))",
    });
    build.at(-1).command.push("TARGET_ARCH=arm64", "ARCHFLAGS=-arch arm64");
  }
  if (core.id === "ppsspp" && platformName === "win32-x64") {
    build
      .at(-1)
      .command.push(
        "FFMPEGLDFLAGS=-L../ffmpeg/Windows/x86_64/lib -lavformat -lavcodec -lavutil -lswresample -lswscale",
      );
  }
  return { build, output, patches };
};
