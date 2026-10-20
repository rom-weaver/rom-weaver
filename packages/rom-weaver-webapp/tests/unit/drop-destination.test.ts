import { describe, expect, it } from "vitest";
import {
  classifyDropEntry,
  countDropEntries,
  isEmulatorSaveExportName,
  isUsableDropFile,
  planDropDestinations,
  planDropRedirect,
  readDropEntries,
} from "../../src/public/react/drop-destination.ts";

const counts = (...names: string[]) => countDropEntries(names.map((name) => ({ name })));
const plan = (...names: string[]) => planDropDestinations(counts(...names));

describe("classifyDropEntry", () => {
  it("reads patches, weaves, saves, ROMs and unknown files by name", () => {
    expect(classifyDropEntry({ name: "translation.bps" })).toBe("patch");
    expect(classifyDropEntry({ name: "rom-weaver-weave.json" })).toBe("patch");
    expect(classifyDropEntry({ name: "game.sfc" })).toBe("rom");
    expect(classifyDropEntry({ name: "game.sav" })).toBe("save");
    expect(classifyDropEntry({ name: "readme.txt" })).toBe("unknown");
  });

  it("counts an archive as a ROM unless its name or listing says patch", () => {
    expect(classifyDropEntry({ name: "game.zip" })).toBe("rom");
    expect(classifyDropEntry({ name: "hack.bps.zip" })).toBe("patch");
    expect(classifyDropEntry({ archiveBucket: "patch", name: "release.7z" })).toBe("patch");
  });
});

describe("isEmulatorSaveExportName", () => {
  it("matches the backups Saves & storage exports, compressed or not", () => {
    expect(isEmulatorSaveExportName("Zelda.rw-emulator-save.zip")).toBe(true);
    expect(isEmulatorSaveExportName("Zelda.RW-EMULATOR-SAVE.json")).toBe(true);
    expect(isEmulatorSaveExportName("game.zip")).toBe(false);
    expect(isEmulatorSaveExportName("rom-weaver-weave.json")).toBe(false);
  });
});

describe("countDropEntries", () => {
  it("folds cue/gdi track files into their sheet", () => {
    expect(counts("game.cue", "game (Track 1).bin", "game (Track 2).bin").roms).toBe(1);
    expect(counts("a.bin", "b.bin").roms).toBe(2);
  });
});

describe("planDropDestinations", () => {
  it("offers Apply or Weave for a weave alongside its source files", () => {
    expect(plan("rom-weaver-weave.json", "game.sfc", "fix.ips")).toEqual({
      destinations: ["patcher", "weave"],
      mixed: false,
    });
  });

  it("sends patches alone, or one ROM with patches, to Apply", () => {
    expect(plan("translation.bps")).toEqual({ destinations: ["patcher"], mixed: false });
    expect(plan("game.sfc", "translation.bps", "fix.ips")).toEqual({ destinations: ["patcher"], mixed: false });
  });

  it("asks Apply or Test for one ROM", () => {
    expect(plan("game.sfc")).toEqual({ destinations: ["patcher", "test"], mixed: false });
  });

  it("sends a ROM with its save to Test", () => {
    expect(plan("Pokemon Red.gb", "Pokemon Red.sav")).toEqual({ destinations: ["test"], mixed: false });
  });

  it("sends a save alone to Test, and saves with patches to Apply", () => {
    expect(plan("Pokemon Red.sav")).toEqual({ destinations: ["test"], mixed: false });
    expect(plan("Pokemon Red.sav", "fix.ips")).toEqual({ destinations: ["patcher"], mixed: false });
  });

  it("sends two ROMs to Create and a disc to Apply or Test", () => {
    expect(plan("original.sfc", "my-hack.sfc")).toEqual({ destinations: ["creator"], mixed: false });
    expect(plan("game.cue", "game (Track 1).bin").destinations).toEqual(["patcher", "test"]);
  });

  it("asks Create or Apply, flagged mixed, for several ROMs with patches", () => {
    expect(plan("original.sfc", "my-hack.sfc", "fix.ips")).toEqual({
      destinations: ["creator", "patcher"],
      mixed: true,
    });
  });

  it("does nothing for an empty drop", () => {
    expect(plan()).toEqual({ destinations: [], mixed: false });
  });
});

describe("planDropRedirect", () => {
  it("offers Apply before Test when patches arrive on Test", () => {
    expect(planDropRedirect("test", counts("game.sfc", "translation.bps"))).toEqual({
      reason: "applyBeforeTest",
      to: "patcher",
    });
    expect(planDropRedirect("test", counts("game.gb", "game.sav"))).toBeNull();
  });

  it("keeps patches on Create and offers Apply for patches on Trim", () => {
    expect(planDropRedirect("creator", counts("game.sfc", "hack.ips"))).toBeNull();
    expect(planDropRedirect("trim", counts("hack.ips"))?.to).toBe("patcher");
    expect(planDropRedirect("creator", counts("a.sfc", "b.sfc", "hack.ips"))).toBeNull();
  });

  it("offers Create for two ROMs on Apply, ignoring saves and unknown files", () => {
    expect(planDropRedirect("patcher", counts("a.sfc", "b.sfc"))?.to).toBe("creator");
    expect(planDropRedirect("patcher", counts("a.sfc", "a.sav", "notes.txt"))).toBeNull();
  });

  it("does not offer Create on Apply for an archive it has not listed", () => {
    expect(planDropRedirect("patcher", counts("game.sfc", "SMB3 Hack v1.0.zip"))).toBeNull();
  });

  it("never redirects from workflows that take any file", () => {
    expect(planDropRedirect("identify", counts("game.sfc", "hack.ips"))).toBeNull();
    expect(planDropRedirect("home", counts("game.sfc", "hack.ips"))).toBeNull();
  });
});

describe("readDropEntries", () => {
  it.each([
    ["release.zip", "rom-weaver-weave.json", ["game.sfc", "fix.ips"]],
    ["release.zip", "rom-weaver-bundle.json", ["fix.ips"]],
    ["fix.bps.zip", "./ROM-WEAVER-WEAVE.JSON", ["fix.bps"]],
  ])("offers Apply or Weave for %s containing %s", async (name, manifest, members) => {
    const entries = await readDropEntries([new File(["zip"], name)], async () => [manifest, ...members]);
    expect(planDropDestinations(countDropEntries(entries))).toEqual({
      destinations: ["patcher", "weave"],
      mixed: false,
    });
    expect(planDropRedirect("test", countDropEntries(entries))?.to).toBe("patcher");
  });

  it("does not treat a nested or compressed archive member as a root weave", async () => {
    const entries = await readDropEntries([new File(["zip"], "release.zip")], async () => [
      "examples/rom-weaver-weave.json",
      "rom-weaver-weave.json.gz",
      "game.sfc",
    ]);
    expect(planDropDestinations(countDropEntries(entries)).destinations).toEqual(["patcher", "test"]);
  });

  it("lists archives so a zipped patch routes to Apply with its ROM", async () => {
    const listed: string[] = [];
    const entries = await readDropEntries(
      [new File(["x"], "game.sfc"), new File(["x"], "SMB3 Hack v1.0.zip"), new File(["x"], "fix.bps.zip")],
      async (archive) => {
        listed.push(archive.name);
        return ["hack.ips", "readme.txt"];
      },
    );
    expect(listed).toEqual(["SMB3 Hack v1.0.zip", "fix.bps.zip"]);
    expect(planDropDestinations(countDropEntries(entries))).toEqual({ destinations: ["patcher"], mixed: false });
  });

  it("counts an archive as a ROM when its listing fails", async () => {
    const entries = await readDropEntries([new File(["x"], "a.sfc"), new File(["x"], "b.zip")], () =>
      Promise.reject(new Error("unreadable")),
    );
    expect(planDropDestinations(countDropEntries(entries)).destinations).toEqual(["creator"]);
  });
});

describe("isUsableDropFile", () => {
  it("pre-checks only what the destination uses", () => {
    expect(isUsableDropFile("creator", "fix.ips")).toBe(true);
    expect(isUsableDropFile("creator", "game.sfc")).toBe(true);
    expect(isUsableDropFile("test", "game.sav")).toBe(true);
    expect(isUsableDropFile("patcher", "game.sav")).toBe(false);
  });
});
