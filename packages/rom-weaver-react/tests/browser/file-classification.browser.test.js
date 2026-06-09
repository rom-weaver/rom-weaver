import { expect, test } from "vitest";
import {
  classifyDroppedFiles,
  classifyFileName,
  isArchiveFileName,
  isPatchFileName,
  isRomFileName,
} from "../../src/public/react/file-classification.ts";

const file = (name) => new File([], name);
const names = (files) => files.map((entry) => entry.name);

test("name predicates recognize patches, archives, and roms (case-insensitive)", () => {
  expect(isPatchFileName("hack.ips")).toBe(true);
  expect(isPatchFileName("hack.BPS")).toBe(true);
  // numbered soft-patch variant
  expect(isPatchFileName("hack.ips1")).toBe(true);
  expect(isPatchFileName("game.sfc")).toBe(false);

  expect(isArchiveFileName("bundle.zip")).toBe(true);
  expect(isArchiveFileName("disc.7Z")).toBe(true);
  expect(isRomFileName("game.sfc")).toBe(true);
  expect(isRomFileName("bundle.zip")).toBe(false);
});

test("classifyFileName follows patch > archive > rom precedence", () => {
  expect(classifyFileName("hack.ips")).toBe("patch");
  expect(classifyFileName("bundle.zip")).toBe("archive");
  expect(classifyFileName("game.sfc")).toBe("rom");
  // .chd is both a container and a rom extension; archive precedence wins so the
  // extract pipeline can probe it.
  expect(classifyFileName("game.chd")).toBe("archive");
  expect(classifyFileName("notes.txt")).toBe("unknown");
});

test("classifyDroppedFiles splits a mixed drop into buckets", () => {
  const result = classifyDroppedFiles([
    file("game.sfc"),
    file("hack.ips"),
    file("bundle.zip"),
    file("disc.chd"),
    file("notes.txt"),
  ]);
  expect(names(result.patches)).toEqual(["hack.ips"]);
  expect(names(result.archives)).toEqual(["bundle.zip", "disc.chd"]);
  // rom + unknown both fall into inputs
  expect(names(result.inputs)).toEqual(["game.sfc", "notes.txt"]);
});

test("classifyDroppedFiles on an empty drop yields empty buckets", () => {
  expect(classifyDroppedFiles([])).toEqual({ archives: [], inputs: [], patches: [] });
});
