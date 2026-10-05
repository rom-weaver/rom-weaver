import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
for (const compiler of ["clang-18", "gcc"]) {
  // quality-reason: ASan/UBSan compiler runtime tests are supported by the Linux native lane; other hosts retain the structural checks below.
  test(
    `${compiler} SDK compatibility accessors preserve bytes at unaligned offsets`,
    { skip: process.platform !== "linux" },
    () => {
      const directory = path.resolve(".agent/quality-native-unaligned");
      fs.mkdirSync(directory, { recursive: true });
      const scratch = fs.mkdtempSync(path.join(directory, "test-"));
      try {
        const binary = path.join(scratch, "native-test");
        const source = "crates/rom-weaver-containers/lzma-sdk/glue/rom_weaver_unaligned_test.c";
        const header = path.resolve(
          "crates/rom-weaver-containers/lzma-sdk/glue/rom_weaver_unaligned.h",
        );
        const compiled = spawnSync(
          compiler,
          [
            "-O3",
            "-D_GNU_SOURCE",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-fsanitize=address,undefined",
            "-fno-omit-frame-pointer",
            "-Icrates/rom-weaver-containers/lzma-sdk/vendor/C",
            "-include",
            header,
            source,
            "-o",
            binary,
          ],
          { encoding: "utf8" },
        );
        assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
        const result = spawnSync(binary, [], {
          encoding: "utf8",
          env: {
            ...process.env,
            UBSAN_OPTIONS: "halt_on_error=1",
            ASAN_OPTIONS: "halt_on_error=1",
          },
        });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
}

test("native integration retains portable compiler-specific forced inclusion", () => {
  const build = fs.readFileSync("crates/rom-weaver-containers/libarchive/build.rs", "utf8");
  assert.match(build, /is_like_msvc\(\)/);
  assert.match(build, /\/FI/);
  assert.match(build, /flag\("-include"\)/);
  assert.match(build, /build.define\("_GNU_SOURCE", None\)/);
  const header = fs.readFileSync(
    "crates/rom-weaver-containers/lzma-sdk/glue/rom_weaver_unaligned.h",
    "utf8",
  );
  assert.ok(header.indexOf('#include "Precomp.h"') < header.indexOf('#include "CpuArch.h"'));
  for (const suffix of ["16", "32", "64"]) {
    for (const prefix of ["GetUi", "SetUi", "GetBe", "SetBe"])
      assert.ok(header.includes(`#undef ${prefix}${suffix}`));
  }
});
