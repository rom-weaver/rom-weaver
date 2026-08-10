import { expect, test } from "vitest";
import {
  collectRomDropFiles,
  getRomDropNotice,
  getRomDropNoticeLevel,
  routeByOrder,
  routeSingleRom,
} from "../../src/public/react/unified-drop-routing.ts";

const file = (name) => new File([], name);
const names = (files) => files.map((entry) => (entry ? entry.name : null));

test("collectRomDropFiles keeps roms and archives but drops patches", () => {
  const result = collectRomDropFiles([file("game.sfc"), file("hack.ips"), file("bundle.zip")]);
  expect(names(result.roms)).toEqual(["game.sfc", "bundle.zip"]);
  expect(names(result.ignoredPatches)).toEqual(["hack.ips"]);
});

test("routeByOrder fills empty slots in drop order", () => {
  const result = routeByOrder([file("a-very-long-name.sfc"), file("b.sfc")], [false, false]);
  expect(names(result.assignment)).toEqual(["a-very-long-name.sfc", "b.sfc"]);
  expect(names(routeByOrder([file("a.sfc")], [true, false]).assignment)).toEqual([null, "a.sfc"]);
});

test("routeByOrder preserves archive and ROM drop order", () => {
  const result = routeByOrder([file("release.zip"), file("game.sfc")], [false, false]);
  expect(names(result.assignment)).toEqual(["release.zip", "game.sfc"]);
});

test("routeByOrder reports overflow without replacing accepted slots", () => {
  const full = routeByOrder([file("new.sfc")], [true, true]);
  expect(names(full.assignment)).toEqual([null, null]);
  expect(names(full.unused)).toEqual(["new.sfc"]);
  expect(getRomDropNoticeLevel(full)).toBe("error");

  const overflow = routeByOrder([file("a.sfc"), file("b.sfc"), file("c.sfc")], [false, false]);
  expect(names(overflow.assignment)).toEqual(["a.sfc", "b.sfc"]);
  expect(names(overflow.unused)).toEqual(["c.sfc"]);
  expect(getRomDropNoticeLevel(overflow)).toBe("warn");
});

test("routeByOrder returns ignored patches for a user-facing notice", () => {
  const result = routeByOrder([file("hack.ips"), file("game.sfc")], [false, false]);
  expect(names(result.assignment)).toEqual(["game.sfc", null]);
  expect(names(result.ignoredPatches)).toEqual(["hack.ips"]);
  expect(getRomDropNotice(result)).toContain("Patches belong in Apply");
});

test("getRomDropNotice bounds unused names", () => {
  const result = routeByOrder(
    Array.from({ length: 5 }, (_, index) => file(`${String(index).repeat(100)}.sfc`)),
    [],
  );
  const notice = getRomDropNotice(result);
  expect(notice).toContain("and 2 more");
  expect(notice.length).toBeLessThan(300);
});

test("routeSingleRom returns the first non-patch rom and reports unused inputs", () => {
  expect(routeSingleRom([file("game.sfc")]).source?.name).toBe("game.sfc");
  expect(routeSingleRom([file("hack.ips"), file("game.sfc")]).source?.name).toBe("game.sfc");
  expect(routeSingleRom([file("game.sfc"), file("extra.sfc")]).unused.map((entry) => entry.name)).toEqual([
    "extra.sfc",
  ]);
  expect(routeSingleRom([file("hack.ips")]).source).toBeNull();
  expect(routeSingleRom([]).source).toBeNull();
});
