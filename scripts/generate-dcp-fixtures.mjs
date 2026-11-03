// Regenerate the Dreamcast `.dcp` browser fixtures and the CLI results the browser must match.
//
// Usage: node scripts/generate-dcp-fixtures.mjs [path/to/rom-weaver]
//
// Writes a three-track GD-ROM disc (as GDI, as a Redump-style CUE, as a CHD, and zipped), a `.dcp` that
// adds one file and delta-patches another, and `expected.json`: the SHA-1 of every track the CLI writes
// with `--no-compress` and of the CHD it writes by default, for both sheets.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.resolve(process.argv[2] ?? path.join(root, "target/debug/rom-weaver"));
const fixtures = path.join(root, "packages/rom-weaver-webapp/tests/fixtures/dcp");
const scratch = mkdtempSync(path.join(tmpdir(), "rom-weaver-dcp-fixtures-"));
const run = (...args) => execFileSync(cli, ["--log-level", "warn", ...args], { cwd: root, stdio: "inherit" });
const sha1 = (file) => createHash("sha1").update(readFileSync(file)).digest("hex");
const TRACKS = ["track01.bin", "track02.bin", "track03.bin"];

const GDI = "3\n1 0 4 2352 track01.bin 0\n2 8 0 2352 track02.bin 0\n3 45000 4 2352 track03.bin 0\n";
const CUE = [
  "REM SINGLE-DENSITY AREA",
  'FILE "track01.bin" BINARY',
  "  TRACK 01 MODE1/2352",
  "    INDEX 01 00:00:00",
  'FILE "track02.bin" BINARY',
  "  TRACK 02 AUDIO",
  "    INDEX 01 00:00:00",
  "REM HIGH-DENSITY AREA",
  'FILE "track03.bin" BINARY',
  "  TRACK 03 MODE1/2352",
  "    INDEX 01 00:00:00",
  "",
].join("\n");

try {
  rmSync(fixtures, { force: true, recursive: true });
  const disc = (name) => path.join(fixtures, name);
  const work = (name) => path.join(scratch, name);
  const source = "KEEP.DAT holds the original text of a GD-ROM fixture file.\n".repeat(64);
  writeFileSync(work("KEEP.DAT"), source);
  writeFileSync(work("README.TXT"), "Unchanged by the DCP.\n");
  execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "-p",
      "rom-weaver-cli",
      "--example",
      "build_gdrom_fixture",
      "--",
      fixtures,
      `KEEP.DAT=${work("KEEP.DAT")}`,
      `README.TXT=${work("README.TXT")}`,
    ],
    { cwd: root, stdio: "inherit" },
  );
  writeFileSync(disc("disc.gdi"), GDI);
  writeFileSync(disc("disc.cue"), CUE);

  // The .dcp: KEEP.DAT as a VCDIFF delta and NEW.DAT as a new file.
  writeFileSync(work("KEEP.modified"), source.replace(/original/g, "patched!"));
  writeFileSync(work("NEW.DAT"), "Added by the DCP.\n");
  run(
    "patch",
    "create",
    "--original",
    work("KEEP.DAT"),
    "--modified",
    work("KEEP.modified"),
    "--format",
    "xdelta",
    "--output",
    work("KEEP.DAT.xdelta"),
  );
  run(
    "compress",
    "--input",
    work("KEEP.DAT.xdelta"),
    "--input",
    work("NEW.DAT"),
    "--format",
    "zip",
    "--output",
    disc("game.dcp"),
  );
  run("compress", "--input", disc("disc.gdi"), "--format", "chd", "--output", disc("disc.chd"));
  run(
    "compress",
    "--input",
    disc("disc.gdi"),
    ...TRACKS.flatMap((track) => ["--input", disc(track)]),
    "--format",
    "zip",
    "--output",
    disc("disc.zip"),
  );

  // Each sheet runs from its own directory: a `.cue` beside a `.gdi` is read as one GD-ROM with both.
  const expected = {};
  for (const sheet of ["gdi", "cue"]) {
    const sheetDir = work(`${sheet}-source`);
    mkdirSync(sheetDir);
    for (const name of [`disc.${sheet}`, ...TRACKS]) copyFileSync(disc(name), path.join(sheetDir, name));
    run(
      "patch",
      "apply",
      "--input",
      path.join(sheetDir, `disc.${sheet}`),
      "--patch",
      disc("game.dcp"),
      "--no-compress",
      "--output",
      work(`${sheet}/disc.${sheet}`),
    );
    run(
      "patch",
      "apply",
      "--input",
      path.join(sheetDir, `disc.${sheet}`),
      "--patch",
      disc("game.dcp"),
      "--output",
      work(`${sheet}.chd`),
    );
    expected[sheet] = {
      chd: sha1(work(`${sheet}.chd`)),
      tracks: Object.fromEntries(TRACKS.map((track) => [track, sha1(work(`${sheet}/${track}`))])),
    };
  }
  writeFileSync(disc("expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
