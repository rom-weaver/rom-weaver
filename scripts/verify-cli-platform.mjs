import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.statSync(cli, { throwIfNoEntry: false })?.isFile()) {
  throw new Error("usage: node scripts/verify-cli-platform.mjs <rom-weaver binary>");
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-platform-"));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const run = (args) => {
  const result = childProcess.spawnSync(cli, ["--no-progress", ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(cli)} ${args.join(" ")} exited with ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
};

const write = (name, bytes) => {
  const file = path.join(temp, name);
  fs.writeFileSync(file, bytes);
  return file;
};

const apsOriginal = Buffer.from(
  { length: 0x10000 },
  (_, index) => (index * 17 + (index >> 5)) & 0xff,
);
const apsModified = Buffer.from(apsOriginal);
apsModified[0x1234] ^= 0xff;
apsModified[0x8000] = 0x5a;

const patchCases = [
  ["ips", "ips", Buffer.from("abcdefgh"), Buffer.from("a1XYZf!!!"), true],
  ["ebp", "ebp", Buffer.from("abcdefgh"), Buffer.from("a1XYZf!!")],
  ["solid", "solid", Buffer.from("1234567890abcdef"), Buffer.from("1234XY7890abc!")],
  ["vcdiff", "xdelta", Buffer.from("hello old world"), Buffer.from("hello new world")],
  ["bps", "bps", Buffer.from("hello old world"), Buffer.from("hello new world")],
  [
    "bdf",
    "bdf",
    Buffer.from("The quick brown fox jumps over the lazy dog."),
    Buffer.from("The quick brown cat jumps over two lazy dogs!"),
  ],
  ["ups", "ups", Buffer.from("hello old world"), Buffer.from("hello new world")],
  ["ppf", "ppf", Buffer.from("hello old world"), Buffer.from("hello new world\0\0")],
  ["mod", "mod", Buffer.from([1, 2]), Buffer.from([1, 2, 0, 0]), true],
  ["dps", "dps", Buffer.from("hello old world"), Buffer.from("hello new world + dps")],
  ["pat", "pat", Buffer.from("hello old world"), Buffer.from("HELlo old worlD")],
  ["rup", "rup", Buffer.from("hello old world"), Buffer.from("hello new world + tail")],
  ["gdiff", "gdiff", Buffer.from("hello old world"), Buffer.alloc(700, 0x42)],
  ["aps", "aps", apsOriginal, apsModified],
];

const extractionCases = [
  [
    "packages/rom-weaver-webapp/tests/fixtures/browser-generated/raw32.chd",
    [["raw32.bin", "ca10691a5b32f91d055ce86a01cec92b077f6a43da079a61cb7ae7d026d7fcbb"]],
  ],
  [
    "packages/rom-weaver-webapp/tests/fixtures/browser-generated/game-cd.chd",
    [
      ["game-cd.bin", "7f8d01ef7507d6e567732910f46c022ec0eb1886d0fff4f001308cc6c016a4fa"],
      ["game-cd.cue", "a4a61db7f0ccd3e9ca2afa88d13d9c4cb1069eb047e069464380f0de99264e04"],
    ],
  ],
  [
    "packages/rom-weaver-webapp/tests/fixtures/browser-generated/game.rvz",
    [["game.iso", "38379851b7c0b8ab085f8b46593ca4f9d8fecc060529d9211e892a57f6af3421"]],
  ],
  [
    "packages/rom-weaver-webapp/tests/fixtures/browser-generated/one-rom.tar",
    [["game.bin", "6a28d704f1664ccf3174c488795340bdb14598766c7e4c39d9967ed4b0e6e0c8"]],
  ],
  [
    "packages/rom-weaver-webapp/tests/fixtures/archives/one-rom.rar",
    [["game.bin", "6a28d704f1664ccf3174c488795340bdb14598766c7e4c39d9967ed4b0e6e0c8"]],
  ],
  [
    "tests/fixtures/rar/rar5-unicode.rar",
    [["\u{1F44B}\u{1F30E}.txt", "315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3"]],
  ],
];

try {
  const payload = Buffer.from("rom-weaver native platform baseline\n");
  const input = write("payload.bin", payload);
  const checksumOutput = run(["checksum", "--input", input, "--algo", "sha256", "--json"]);
  const checksum = JSON.parse(checksumOutput.trim()).details.checksums.sha256;
  assert.equal(checksum, sha256(payload));

  for (const format of ["zip", "7z"]) {
    const archive = path.join(temp, `archive.${format}`);
    const output = path.join(temp, `extract-${format}`);
    run(["compress", "--input", input, "--format", format, "--output", archive]);
    run(["extract", "--input", archive, "--output", output]);
    assert.deepEqual(
      fs.readFileSync(path.join(output, path.basename(input))),
      payload,
      `${format} round trip`,
    );
  }

  const z3dsInput = write(
    "disc.3ds",
    Buffer.from({ length: 65_536 }, (_, index) => index % 239),
  );
  const z3dsArchive = path.join(temp, "disc.z3ds");
  const z3dsOutput = path.join(temp, "extract-z3ds");
  run([
    "compress",
    "--input",
    z3dsInput,
    "--format",
    "z3ds",
    "--codec",
    "zstd",
    "--output",
    z3dsArchive,
  ]);
  run(["extract", "--input", z3dsArchive, "--output", z3dsOutput]);
  assert.deepEqual(
    fs.readFileSync(path.join(z3dsOutput, path.basename(z3dsInput))),
    fs.readFileSync(z3dsInput),
    "Z3DS round trip",
  );

  for (const [fixture, outputs] of extractionCases) {
    const fixturePath = path.join(repo, fixture);
    const output = path.join(temp, `extract-${path.basename(fixture)}`);
    run(["extract", "--input", fixturePath, "--output", output, "--no-ignore"]);
    for (const [name, expectedHash] of outputs) {
      assert.equal(sha256(fs.readFileSync(path.join(output, name))), expectedHash, fixture);
    }
  }

  for (const [format, extension, original, modified, ignoreChecksums = false] of patchCases) {
    const originalPath = write(`${format}-original.bin`, original);
    const modifiedPath = write(`${format}-modified.bin`, modified);
    const patch = path.join(temp, `${format}.${extension}`);
    const output = path.join(temp, `${format}-output.bin`);
    run([
      "patch",
      "create",
      "--original",
      originalPath,
      "--modified",
      modifiedPath,
      "--format",
      format,
      "--output",
      patch,
    ]);
    run([
      "patch",
      "apply",
      "--input",
      originalPath,
      "--patch",
      patch,
      "--output",
      output,
      "--no-compress",
      ...(ignoreChecksums ? ["--ignore-checksum-validation"] : []),
    ]);
    assert.deepEqual(fs.readFileSync(output), modified, `${format} patch round trip`);
  }

  process.stdout.write(
    `Verified SHA-256, 7 container formats, and ${patchCases.length} patch formats with ${path.basename(cli)}\n`,
  );
} finally {
  fs.rmSync(temp, { force: true, recursive: true });
}
