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
  if (["gambatte", "snes9x"].includes(core.id) && platformName === "win32-x64") {
    patches.push({
      path: core.id === "snes9x" ? "libretro/Makefile" : "Makefile.libretro",
      find: "SHARED := -shared -static-libgcc -static-libstdc++",
      replace: "SHARED := -shared -static -static-libgcc -static-libstdc++",
    });
  }
  if (core.id === "handy" && platformName === "win32-x64") {
    patches.push({
      path: "Makefile",
      find: "SHARED := -shared -static-libgcc -static-libstdc++ -Wl,-no-undefined",
      replace: "SHARED := -shared -static -static-libgcc -static-libstdc++ -Wl,-no-undefined",
    });
  }
  if (core.id === "melonds" && platformName === "win32-x64") {
    patches.push({
      path: "Makefile",
      find: "SHARED := -shared -static-libgcc -static-libstdc++ -s -Wl,--version-script=$(CORE_DIR)/link.T -Wl,--no-undefined",
      replace:
        "SHARED := -shared -static -static-libgcc -static-libstdc++ -s -Wl,--version-script=$(CORE_DIR)/link.T -Wl,--no-undefined",
    });
  }
  if (core.id === "ppsspp" && platformName === "darwin-arm64") {
    patches.push({
      path: "libretro/Makefile",
      find: "ifneq (,$(findstring 64,$(TARGET_ARCH)))",
      replace: "ifneq (,$(filter x86_64 amd64,$(TARGET_ARCH)))",
    });
    build.at(-1).command.push("TARGET_ARCH=arm64", "ARCHFLAGS=-arch arm64");
  }
  if (core.id === "ppsspp" && platformName === "win32-x64") {
    patches.push(
      {
        path: "ext/libzip/zip_source_file_win32_ansi.c",
        find: `zip_win32_file_operations_t ops_ansi = {
    ansi_allocate_tempname,
    CreateFileA,
    DeleteFileA,
    GetFileAttributesA,
    GetFileAttributesExA,
    ansi_make_tempname,
    MoveFileExA,
    SetFileAttributesA,
    strdup
};`,
        replace: `static HANDLE __stdcall
ansi_create_file_callback(const void *name, DWORD access, DWORD share_mode, PSECURITY_ATTRIBUTES security_attributes, DWORD creation_disposition, DWORD file_attributes, HANDLE template_file) {
    return CreateFileA((const char *)name, access, share_mode, security_attributes, creation_disposition, file_attributes, template_file);
}

static BOOL __stdcall
ansi_delete_file_callback(const void *name) {
    return DeleteFileA((const char *)name);
}

static DWORD __stdcall
ansi_get_file_attributes_callback(const void *name) {
    return GetFileAttributesA((const char *)name);
}

static BOOL __stdcall
ansi_get_file_attributes_ex_callback(const void *name, GET_FILEEX_INFO_LEVELS info_level, void *information) {
    return GetFileAttributesExA((const char *)name, info_level, information);
}

static BOOL __stdcall
ansi_move_file_callback(const void *from, const void *to, DWORD flags) {
    return MoveFileExA((const char *)from, (const char *)to, flags);
}

static BOOL __stdcall
ansi_set_file_attributes_callback(const void *name, DWORD attributes) {
    return SetFileAttributesA((const char *)name, attributes);
}

zip_win32_file_operations_t ops_ansi = {
    ansi_allocate_tempname,
    ansi_create_file_callback,
    ansi_delete_file_callback,
    ansi_get_file_attributes_callback,
    ansi_get_file_attributes_ex_callback,
    ansi_make_tempname,
    ansi_move_file_callback,
    ansi_set_file_attributes_callback,
    strdup
};`,
      },
      {
        path: "ext/libzip/zip_source_file_win32_utf16.c",
        find: "static char *utf16_strdup(const char *string);",
        replace: `static char *utf16_strdup(const char *string);

static HANDLE __stdcall
utf16_create_file_callback(const void *name, DWORD access, DWORD share_mode, PSECURITY_ATTRIBUTES security_attributes, DWORD creation_disposition, DWORD file_attributes, HANDLE template_file) {
    return utf16_create_file((const char *)name, access, share_mode, security_attributes, creation_disposition, file_attributes, template_file);
}

static BOOL __stdcall
utf16_delete_file_callback(const void *name) {
    return DeleteFileW((const wchar_t *)name);
}

static DWORD __stdcall
utf16_get_file_attributes_callback(const void *name) {
    return GetFileAttributesW((const wchar_t *)name);
}

static BOOL __stdcall
utf16_get_file_attributes_ex_callback(const void *name, GET_FILEEX_INFO_LEVELS info_level, void *information) {
    return GetFileAttributesExW((const wchar_t *)name, info_level, information);
}

static BOOL __stdcall
utf16_move_file_callback(const void *from, const void *to, DWORD flags) {
    return MoveFileExW((const wchar_t *)from, (const wchar_t *)to, flags);
}

static BOOL __stdcall
utf16_set_file_attributes_callback(const void *name, DWORD attributes) {
    return SetFileAttributesW((const wchar_t *)name, attributes);
}`,
      },
      {
        path: "ext/libzip/zip_source_file_win32_utf16.c",
        find: `	utf16_create_file,
	DelFile,
	GetFileAttributesW,
	GetFileAttr,
	utf16_make_tempname,
	MoveFileExW,
	SetFileAttributesW,`,
        replace: `	utf16_create_file_callback,
	DelFile,
	utf16_get_file_attributes_callback,
	GetFileAttr,
	utf16_make_tempname,
	utf16_move_file_callback,
	utf16_set_file_attributes_callback,`,
      },
      {
        path: "ext/libzip/zip_source_file_win32_utf16.c",
        find: `    utf16_create_file,
    DeleteFileW,
    GetFileAttributesW,
    GetFileAttributesExW,
    utf16_make_tempname,
    MoveFileExW,
    SetFileAttributesW,`,
        replace: `    utf16_create_file_callback,
    utf16_delete_file_callback,
    utf16_get_file_attributes_callback,
    utf16_get_file_attributes_ex_callback,
    utf16_make_tempname,
    utf16_move_file_callback,
    utf16_set_file_attributes_callback,`,
      },
      {
        path: "libretro/Makefile",
        find: "LDFLAGS += -shared -Wl,--no-undefined -static-libgcc -static-libstdc++ -Wl,--version-script=link.T -lwinmm -lgdi32 -lwsock32 -lws2_32",
        replace:
          "LDFLAGS += -shared -Wl,--no-undefined -static-libgcc -static-libstdc++ -Wl,--version-script=link.T -lwinmm -lgdi32 -lwsock32 -lws2_32 -lversion -liphlpapi",
      },
      {
        path: "libretro/Makefile.common",
        find: "# zstd only uses asm for Linux/macOS and GNUC.\nifneq ($(PLATFORM_EXT), win32)",
        replace:
          "# zstd only uses asm for Linux/macOS and GNUC.\nifeq ($(PLATFORM_EXT), win32)\nCFLAGS += -DZSTD_DISABLE_ASM\nendif\n\nifneq ($(PLATFORM_EXT), win32)",
      },
    );
    build
      .at(-1)
      .command.push(
        "FFMPEGLDFLAGS=-L../ffmpeg/Windows/x86_64/lib -lavformat -lavcodec -lavutil -lswresample -lswscale -Wl,-Bstatic -liconv -Wl,-Bdynamic",
      );
  }
  return { build, output, patches };
};
