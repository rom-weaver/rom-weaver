import { describe, expect, it } from "vitest";
import {
  clampRomWeaverBrowserThreadRequest,
  collectRomWeaverRunInputPaths,
  createRomWeaverCommand,
  getRomWeaverCommandLabel,
  normalizeRomWeaverRunRequest,
  readRomWeaverRequestedThreadCount,
  readRomWeaverRunInputCommand,
  readRomWeaverRunRequestCommand,
  romWeaverCommandSupportsThreads,
  withRomWeaverDefaultThreads,
  withRomWeaverForcedThreads,
} from "../../src/wasm/rom-weaver-command.ts";
import type { RomWeaverCommand, RomWeaverRunRequest } from "../../src/wasm/rom-weaver-types.d.ts";

const asCommand = (command: unknown) => command as RomWeaverCommand;
const asRequest = (request: unknown) => request as RomWeaverRunRequest;

describe("createRomWeaverCommand", () => {
  it.each(["bundle-parse", "bundle-create"] as const)("accepts legacy input label %s", (label) => {
    const command = createRomWeaverCommand(label, { input: "old.json", output: "new.json" } as never);
    expect(command).toEqual({
      type: "bundle",
      args: { type: label === "bundle-parse" ? "parse" : "create", args: { input: "old.json", output: "new.json" } },
    });
  });

  it("passes a top-level command straight through", () => {
    for (const type of ["probe", "extract", "checksum", "identify", "ingest", "compress", "trim"] as const) {
      expect(createRomWeaverCommand(type, { input: "/rom.sfc" } as never)).toEqual({
        args: { input: "/rom.sfc" },
        type,
      });
    }
    expect(createRomWeaverCommand("plan-extract-batch", { threads: 4 } as never)).toEqual({
      args: { threads: 4 },
      type: "plan-extract-batch",
    });
  });

  it("nests every sub-command under its parent type", () => {
    expect(createRomWeaverCommand("patch-apply", { input: "/rom.sfc" } as never)).toEqual({
      args: { args: { input: "/rom.sfc" }, type: "apply" },
      type: "patch",
    });
    expect(createRomWeaverCommand("patch-validate", {} as never)).toEqual({
      args: { args: {}, type: "validate" },
      type: "patch",
    });
    expect(createRomWeaverCommand("patch-create", {} as never)).toEqual({
      args: { args: {}, type: "create" },
      type: "patch",
    });
    expect(createRomWeaverCommand("weave-parse", {} as never)).toEqual({
      args: { args: {}, type: "parse" },
      type: "weave",
    });
    expect(createRomWeaverCommand("weave-create", {} as never)).toEqual({
      args: { args: {}, type: "create" },
      type: "weave",
    });
    expect(createRomWeaverCommand("tools-ppf-undo", {} as never)).toEqual({
      args: { args: {}, type: "ppf-undo" },
      type: "tools",
    });
  });

  it("refuses a label it does not know", () => {
    expect(() => createRomWeaverCommand("nope" as never, {} as never)).toThrow(
      'Unhandled rom-weaver command shape: "nope"',
    );
  });
});

describe("normalizeRomWeaverRunRequest", () => {
  it.each([true, false])("preserves dry_run=%s when normalizing a request", (dryRun) => {
    const command = createRomWeaverCommand("extract", { input: "/input.zip", output: "/output" });
    const request = normalizeRomWeaverRunRequest({ command, dry_run: dryRun }, { json: true });
    expect(request).toEqual({ command, dry_run: dryRun, output: { json: true } });
    expect(JSON.parse(JSON.stringify(request)).dry_run).toBe(dryRun);
  });

  it.each(["true", "false", 1, null])("rejects invalid dry_run=%s instead of running the command", (dryRun) => {
    expect(() =>
      normalizeRomWeaverRunRequest(
        asRequest({
          command: { args: { input: "/input.zip", output: "/output" }, type: "extract" },
          dry_run: dryRun,
        }),
      ),
    ).toThrow("rom-weaver dry_run must be a boolean");
  });

  it("wraps a bare command and drops unset output options", () => {
    expect(normalizeRomWeaverRunRequest(asCommand({ args: { input: "/rom.sfc" }, type: "extract" }))).toEqual({
      command: { args: { input: "/rom.sfc" }, type: "extract" },
      output: {},
    });
  });

  it("copies the args so the caller's object cannot be mutated later", () => {
    const args = { input: "/rom.sfc" };
    const normalized = normalizeRomWeaverRunRequest(asCommand({ args, type: "extract" }));

    expect(normalized.command.args).not.toBe(args);
    expect(normalized.command.args).toEqual(args);
  });

  it("replaces missing args with an empty object", () => {
    expect(normalizeRomWeaverRunRequest(asCommand({ type: "probe" })).command).toEqual({ args: {}, type: "probe" });
    expect(normalizeRomWeaverRunRequest(asCommand({ args: [1, 2], type: "probe" })).command).toEqual({
      args: {},
      type: "probe",
    });
  });

  it("normalizes every output option and lets the overrides win", () => {
    const request = normalizeRomWeaverRunRequest(
      asRequest({
        command: { args: {}, type: "probe" },
        output: { dep_trace: 1, interactive_selection_enabled: 0, json: 1, log_level: "debug", progress: true },
      }),
      { json: false },
    );

    expect(request.output).toEqual({
      dep_trace: true,
      interactive_selection_enabled: false,
      json: false,
      log_level: "debug",
      progress: true,
    });
  });

  it("ignores a non-boolean progress flag and a non-object output block", () => {
    expect(
      normalizeRomWeaverRunRequest(asRequest({ command: { args: {}, type: "probe" }, output: { progress: "yes" } }))
        .output,
    ).toEqual({});
    expect(
      normalizeRomWeaverRunRequest(asRequest({ command: { args: {}, type: "probe" }, output: null })).output,
    ).toEqual({});
  });

  it("normalizes legacy bundle commands and fields to canonical weave names", () => {
    const request = normalizeRomWeaverRunRequest({
      command: {
        type: "bundle",
        args: {
          type: "create",
          args: {
            output: "new.json",
            bundle: "old.zip",
            weave: "new.zip",
            bundle_rom: "game.bin",
            no_bundle_rom: true,
          },
        },
      },
    } as unknown as RomWeaverRunRequest);
    expect(request.command).toEqual({
      type: "weave",
      args: {
        type: "create",
        args: { output: "new.json", weave: "new.zip", weave_rom: "game.bin", no_weave_rom: true },
      },
    });
  });

  it("normalizes each nested sub-command", () => {
    expect(
      normalizeRomWeaverRunRequest(asCommand({ args: { args: { input: "/a" }, type: "apply" }, type: "patch" }))
        .command,
    ).toEqual({ args: { args: { input: "/a" }, type: "apply" }, type: "patch" });
    expect(
      normalizeRomWeaverRunRequest(asCommand({ args: { args: [], type: "validate" }, type: "patch" })).command,
    ).toEqual({ args: { args: {}, type: "validate" }, type: "patch" });
    expect(normalizeRomWeaverRunRequest(asCommand({ args: { type: "create" }, type: "patch" })).command).toEqual({
      args: { args: {}, type: "create" },
      type: "patch",
    });
    expect(normalizeRomWeaverRunRequest(asCommand({ args: { type: "parse" }, type: "weave" })).command).toEqual({
      args: { args: {}, type: "parse" },
      type: "weave",
    });
    expect(normalizeRomWeaverRunRequest(asCommand({ args: { type: "create" }, type: "weave" })).command).toEqual({
      args: { args: {}, type: "create" },
      type: "weave",
    });
    expect(normalizeRomWeaverRunRequest(asCommand({ args: { type: "ppf-undo" }, type: "tools" })).command).toEqual({
      args: { args: {}, type: "ppf-undo" },
      type: "tools",
    });
    expect(
      normalizeRomWeaverRunRequest(
        asCommand({ args: { args: { input: "/save.sav", path: "player.lives" }, type: "get" }, type: "save" }),
      ).command,
    ).toEqual({
      args: { args: { input: "/save.sav", path: "player.lives" }, type: "get" },
      type: "save",
    });
  });

  it("rejects an input that is not an object", () => {
    for (const input of [null, undefined, "extract", 7, [1]]) {
      expect(() => normalizeRomWeaverRunRequest(input as never)).toThrow(
        "rom-weaver run requires a typed command or run request object",
      );
    }
  });

  it("rejects an unknown or missing command type", () => {
    expect(() => normalizeRomWeaverRunRequest(asCommand({ type: "explode" }))).toThrow(
      /rom-weaver typed command has unsupported `type` field: explode/,
    );
    expect(() => normalizeRomWeaverRunRequest(asCommand({ args: {} }))).toThrow(
      "rom-weaver typed command requires a string `type` field",
    );
  });

  it("rejects a sub-command whose payload is not an object", () => {
    expect(() => normalizeRomWeaverRunRequest(asCommand({ args: [], type: "patch" }))).toThrow(
      "rom-weaver patch command requires an object `args` payload",
    );
    expect(() => normalizeRomWeaverRunRequest(asCommand({ args: [], type: "weave" }))).toThrow(
      "rom-weaver weave command requires an object `args` payload",
    );
    expect(() => normalizeRomWeaverRunRequest(asCommand({ args: [], type: "tools" }))).toThrow(
      "rom-weaver tools command requires an object `args` payload",
    );
    expect(() => normalizeRomWeaverRunRequest(asCommand({ args: [], type: "save" }))).toThrow(
      "rom-weaver save command requires an object `args` payload",
    );
  });

  it("rejects an unknown sub-command type", () => {
    expect(() => normalizeRomWeaverRunRequest(asCommand({ args: { type: "reverse" }, type: "patch" }))).toThrow(
      /rom-weaver patch command has unsupported nested `type` field: reverse/,
    );
    expect(() => normalizeRomWeaverRunRequest(asCommand({ args: { type: "reverse" }, type: "weave" }))).toThrow(
      /rom-weaver weave command has unsupported nested `type` field: reverse/,
    );
    expect(() => normalizeRomWeaverRunRequest(asCommand({ args: { type: "reverse" }, type: "tools" }))).toThrow(
      "unsupported tools command: reverse",
    );
    expect(() => normalizeRomWeaverRunRequest(asCommand({ args: { type: "reverse" }, type: "save" }))).toThrow(
      "unsupported save command: reverse",
    );
    expect(() => normalizeRomWeaverRunRequest(asCommand({ args: { type: " ppf-undo " }, type: "tools" }))).toThrow(
      "unsupported tools command:  ppf-undo ",
    );
    expect(() => normalizeRomWeaverRunRequest(asCommand({ args: { type: " get " }, type: "save" }))).toThrow(
      "unsupported save command:  get ",
    );
  });
});

describe("command readers", () => {
  it("unwraps a command from either input shape", () => {
    const command = asCommand({ args: {}, type: "probe" });

    expect(readRomWeaverRunInputCommand(command)).toBe(command);
    expect(readRomWeaverRunInputCommand(asRequest({ command, output: {} }))).toBe(command);
    expect(readRomWeaverRunRequestCommand(asRequest({ command, output: {} }))).toBe(command);
  });

  it("labels every command branch", () => {
    expect(getRomWeaverCommandLabel(asCommand({ args: {}, type: "extract" }))).toBe("extract");
    expect(getRomWeaverCommandLabel(asCommand({ args: { args: {}, type: "apply" }, type: "patch" }))).toBe(
      "patch-apply",
    );
    expect(getRomWeaverCommandLabel(asCommand({ args: { args: {}, type: "validate" }, type: "patch" }))).toBe(
      "patch-validate",
    );
    expect(getRomWeaverCommandLabel(asCommand({ args: { args: {}, type: "create" }, type: "patch" }))).toBe(
      "patch-create",
    );
    expect(getRomWeaverCommandLabel(asCommand({ args: { args: {}, type: "parse" }, type: "weave" }))).toBe(
      "weave-parse",
    );
    expect(getRomWeaverCommandLabel(asCommand({ args: { args: {}, type: "create" }, type: "weave" }))).toBe(
      "weave-create",
    );
    expect(getRomWeaverCommandLabel(asCommand({ args: { args: {}, type: "ppf-undo" }, type: "tools" }))).toBe(
      "tools-ppf-undo",
    );
  });

  it("refuses to label a branch it does not know", () => {
    expect(() => getRomWeaverCommandLabel(asCommand({ args: {}, type: "explode" }))).toThrow(
      /Unhandled rom-weaver command shape/,
    );
    expect(() => getRomWeaverCommandLabel(asCommand({ args: { type: "reverse" }, type: "patch" }))).toThrow(
      /Unhandled rom-weaver command shape/,
    );
    expect(() => getRomWeaverCommandLabel(asCommand({ args: { type: "reverse" }, type: "weave" }))).toThrow(
      /Unhandled rom-weaver command shape/,
    );
    expect(() => getRomWeaverCommandLabel(asCommand({ args: { type: "reverse" }, type: "tools" }))).toThrow(
      "unsupported tools command: reverse",
    );
  });
});

describe("collectRomWeaverRunInputPaths", () => {
  it("collects the input of each single-input command", () => {
    for (const type of ["probe", "extract", "checksum"] as const) {
      expect(collectRomWeaverRunInputPaths(asCommand({ args: { input: "/rom.sfc" }, type }))).toEqual(["/rom.sfc"]);
    }
  });

  it("collects the database list for identify and ingest", () => {
    expect(
      collectRomWeaverRunInputPaths(
        asCommand({ args: { database: ["/a.dat", "/b.dat"], input: "/rom.sfc" }, type: "identify" }),
      ),
    ).toEqual(["/rom.sfc", "/a.dat", "/b.dat"]);
    expect(
      collectRomWeaverRunInputPaths(asCommand({ args: { database: "/only.dat", input: "/rom.sfc" }, type: "ingest" })),
    ).toEqual(["/rom.sfc", "/only.dat"]);
  });

  it("skips the input of a sidecar-only ingest", () => {
    expect(
      collectRomWeaverRunInputPaths(
        asCommand({ args: { database: "/db.dat", input: "/rom.sfc", sidecar_only: true }, type: "ingest" }),
      ),
    ).toEqual(["/db.dat"]);
  });

  it("collects multi-input commands", () => {
    expect(collectRomWeaverRunInputPaths(asCommand({ args: { input: ["/a", "/b"] }, type: "compress" }))).toEqual([
      "/a",
      "/b",
    ]);
    expect(collectRomWeaverRunInputPaths(asCommand({ args: { input: ["/c"] }, type: "trim" }))).toEqual(["/c"]);
  });

  it("collects the inputs of each nested sub-command", () => {
    expect(
      collectRomWeaverRunInputPaths(
        asCommand({
          args: { args: { input: "/rom.sfc", patches: ["/p1.ips", "/p2.ips"] }, type: "apply" },
          type: "patch",
        }),
      ),
    ).toEqual(["/rom.sfc", "/p1.ips", "/p2.ips"]);
    expect(
      collectRomWeaverRunInputPaths(
        asCommand({ args: { args: { input: "/rom.sfc", patches: "/p.ips" }, type: "validate" }, type: "patch" }),
      ),
    ).toEqual(["/rom.sfc", "/p.ips"]);
    expect(
      collectRomWeaverRunInputPaths(
        asCommand({ args: { args: { modified: "/new.sfc", original: "/old.sfc" }, type: "create" }, type: "patch" }),
      ),
    ).toEqual(["/old.sfc", "/new.sfc"]);
    expect(
      collectRomWeaverRunInputPaths(
        asCommand({ args: { args: { input: "/pack.rwfp" }, type: "parse" }, type: "weave" }),
      ),
    ).toEqual(["/pack.rwfp"]);
    expect(
      collectRomWeaverRunInputPaths(
        asCommand({ args: { args: { patch: ["/p.ips"], rom: "/rom.sfc" }, type: "create" }, type: "weave" }),
      ),
    ).toEqual(["/rom.sfc", "/p.ips"]);
    expect(
      collectRomWeaverRunInputPaths(
        asCommand({ args: { args: { patch: "/p.ppf", rom: "/rom.iso" }, type: "ppf-undo" }, type: "tools" }),
      ),
    ).toEqual(["/rom.iso", "/p.ppf"]);
  });

  it("reads no paths from a pure planning command", () => {
    expect(collectRomWeaverRunInputPaths(asCommand({ args: { threads: 4 }, type: "plan-extract-batch" }))).toEqual([]);
  });

  it("appends the caller's known paths and de-duplicates", () => {
    expect(
      collectRomWeaverRunInputPaths(asCommand({ args: { input: "/rom.sfc" }, type: "extract" }), {
        knownInputPaths: ["/rom.sfc", "/extra.bin"],
      }),
    ).toEqual(["/rom.sfc", "/extra.bin"]);
  });

  it("ignores blank, flag-like, and non-string path values", () => {
    expect(
      collectRomWeaverRunInputPaths(asCommand({ args: { input: ["  ", "-v", 7, null, " /kept "] }, type: "compress" })),
    ).toEqual(["/kept"]);
  });

  it("refuses a command branch it does not know", () => {
    expect(() => collectRomWeaverRunInputPaths(asCommand({ args: {}, type: "explode" }))).toThrow(
      /Unhandled rom-weaver command shape/,
    );
    expect(() => collectRomWeaverRunInputPaths(asCommand({ args: { type: "reverse" }, type: "patch" }))).toThrow(
      /Unhandled rom-weaver command shape/,
    );
    expect(() => collectRomWeaverRunInputPaths(asCommand({ args: { type: "reverse" }, type: "weave" }))).toThrow(
      /Unhandled rom-weaver command shape/,
    );
  });
});

describe("romWeaverCommandSupportsThreads", () => {
  it("answers for every command branch", () => {
    expect(romWeaverCommandSupportsThreads(asCommand({ args: {}, type: "probe" }))).toBe(false);
    expect(romWeaverCommandSupportsThreads(asCommand({ args: {}, type: "plan-extract-batch" }))).toBe(false);
    expect(romWeaverCommandSupportsThreads(asCommand({ args: { args: {}, type: "ppf-undo" }, type: "tools" }))).toBe(
      true,
    );
    for (const type of ["extract", "checksum", "identify", "ingest", "compress", "trim"] as const) {
      expect(romWeaverCommandSupportsThreads(asCommand({ args: {}, type }))).toBe(true);
    }
    for (const type of ["apply", "validate", "create"] as const) {
      expect(romWeaverCommandSupportsThreads(asCommand({ args: { args: {}, type }, type: "patch" }))).toBe(true);
    }
    for (const type of ["parse", "create"] as const) {
      expect(romWeaverCommandSupportsThreads(asCommand({ args: { args: {}, type }, type: "weave" }))).toBe(true);
    }
  });

  it("refuses a branch it does not know", () => {
    expect(() => romWeaverCommandSupportsThreads(asCommand({ args: {}, type: "explode" }))).toThrow(
      /Unhandled rom-weaver command shape/,
    );
    expect(() => romWeaverCommandSupportsThreads(asCommand({ args: { type: "reverse" }, type: "patch" }))).toThrow(
      /Unhandled rom-weaver command shape/,
    );
    expect(() => romWeaverCommandSupportsThreads(asCommand({ args: { type: "reverse" }, type: "weave" }))).toThrow(
      /Unhandled rom-weaver command shape/,
    );
  });
});

describe("withRomWeaverDefaultThreads", () => {
  it("injects the default into a thread-capable command", () => {
    const request = asRequest({ command: { args: { input: "/a" }, type: "extract" }, output: {} });

    expect(withRomWeaverDefaultThreads(request, "auto")).toEqual({
      command: { args: { input: "/a", threads: "auto" }, type: "extract" },
      output: {},
    });
  });

  it("injects into a nested sub-command without losing the wrapper", () => {
    const request = asRequest({
      command: { args: { args: { input: "/a" }, type: "apply" }, type: "patch" },
      output: { json: true },
    });

    expect(withRomWeaverDefaultThreads(request, 4 as never)).toEqual({
      command: { args: { args: { input: "/a", threads: 4 }, type: "apply" }, type: "patch" },
      output: { json: true },
    });
  });

  it("leaves the request alone when there is nothing to inject", () => {
    const noDefault = asRequest({ command: { args: {}, type: "extract" }, output: {} });
    expect(withRomWeaverDefaultThreads(noDefault, null as never)).toBe(noDefault);

    const noThreadSupport = asRequest({ command: { args: {}, type: "probe" }, output: {} });
    expect(withRomWeaverDefaultThreads(noThreadSupport, "auto")).toBe(noThreadSupport);

    const alreadySet = asRequest({ command: { args: { threads: 2 }, type: "extract" }, output: {} });
    expect(withRomWeaverDefaultThreads(alreadySet, "auto")).toBe(alreadySet);
  });

  it("treats an explicit null or undefined thread count as unset", () => {
    const request = asRequest({ command: { args: { threads: null }, type: "extract" }, output: {} });

    expect(withRomWeaverDefaultThreads(request, "auto").command.args).toEqual({ threads: "auto" });
  });
});

describe("clampRomWeaverBrowserThreadRequest", () => {
  const clampThreads = (threads: unknown, options?: Parameters<typeof clampRomWeaverBrowserThreadRequest>[1]) =>
    (
      clampRomWeaverBrowserThreadRequest(
        asRequest({ command: { args: { threads }, type: "extract" }, output: {} }),
        options,
      ).command.args as { threads: unknown }
    ).threads;

  it("clamps a numeric request to the ceiling", () => {
    expect(clampThreads(4)).toBe(4);
    expect(clampThreads(1024)).toBe(64);
    expect(clampThreads(9.7, { maxThreads: 8 })).toBe(8);
  });

  it("clamps a bigint request and returns a number", () => {
    expect(clampThreads(4n)).toBe(4);
    expect(clampThreads(1024n, { maxThreads: 8 })).toBe(8);
  });

  it("resolves an auto request against the default, then the auto fallback", () => {
    expect(clampThreads("auto")).toBe(4);
    expect(clampThreads("AUTO", { autoThreads: 12 })).toBe(12);
    expect(clampThreads("auto", { autoThreads: 12, maxThreads: 6 })).toBe(6);
    expect(clampThreads("auto", { autoThreads: 12, defaultThreads: 3 })).toBe(3);
    expect(clampThreads("auto", { defaultThreads: 100, maxThreads: 8 })).toBe(8);
  });

  it("clamps a numeric string", () => {
    expect(clampThreads(" 6 ")).toBe(6);
    expect(clampThreads("128", { maxThreads: 16 })).toBe(16);
  });

  it("leaves a value it cannot read alone", () => {
    expect(clampThreads(0)).toBe(0);
    expect(clampThreads(-2)).toBe(-2);
    expect(clampThreads(0n)).toBe(0n);
    expect(clampThreads("many")).toBe("many");
  });

  it("falls back to the default ceiling for an unusable maxThreads option", () => {
    expect(clampThreads(1000, { maxThreads: 0 })).toBe(64);
    expect(clampThreads(1000, { maxThreads: null })).toBe(64);
  });

  it("returns the same request when there is nothing to clamp", () => {
    const noThreadSupport = asRequest({ command: { args: { threads: 1000 }, type: "probe" }, output: {} });
    expect(clampRomWeaverBrowserThreadRequest(noThreadSupport)).toBe(noThreadSupport);

    const unset = asRequest({ command: { args: {}, type: "extract" }, output: {} });
    expect(clampRomWeaverBrowserThreadRequest(unset)).toBe(unset);

    const alreadyInRange = asRequest({ command: { args: { threads: 4 }, type: "extract" }, output: {} });
    expect(clampRomWeaverBrowserThreadRequest(alreadyInRange)).toBe(alreadyInRange);
  });
});

describe("withRomWeaverForcedThreads", () => {
  it("forces the count on a bare command and on a run request", () => {
    expect(withRomWeaverForcedThreads(asCommand({ args: { input: "/a" }, type: "extract" }), 3)).toEqual({
      args: { input: "/a", threads: 3 },
      type: "extract",
    });
    expect(
      withRomWeaverForcedThreads(
        asRequest({ command: { args: { args: {}, type: "parse" }, type: "weave" }, output: {} }),
        2,
      ),
    ).toEqual({ command: { args: { args: { threads: 2 }, type: "parse" }, type: "weave" }, output: {} });
  });

  it("floors the count and never drops below one", () => {
    expect(
      (withRomWeaverForcedThreads(asCommand({ args: {}, type: "extract" }), 3.9) as { args: { threads: number } }).args
        .threads,
    ).toBe(3);
    expect(
      (withRomWeaverForcedThreads(asCommand({ args: {}, type: "extract" }), -5) as { args: { threads: number } }).args
        .threads,
    ).toBe(1);
  });

  it("returns the input unchanged when nothing would change", () => {
    const threadless = asCommand({ args: {}, type: "probe" });
    expect(withRomWeaverForcedThreads(threadless, 4)).toBe(threadless);

    const alreadyForced = asCommand({ args: { threads: 4 }, type: "extract" });
    expect(withRomWeaverForcedThreads(alreadyForced, 4)).toBe(alreadyForced);
  });
});

describe("readRomWeaverRequestedThreadCount", () => {
  const readThreads = (threads: unknown, options?: Parameters<typeof readRomWeaverRequestedThreadCount>[1]) =>
    readRomWeaverRequestedThreadCount(asCommand({ args: { threads }, type: "extract" }), options);

  it("reads a numeric or bigint budget", () => {
    expect(readThreads(6)).toBe(6);
    expect(readThreads(6.9)).toBe(6);
    expect(readThreads(1000)).toBe(64);
    expect(readThreads(6n)).toBe(6);
    expect(readThreads(1000n, { maxThreads: 12 })).toBe(12);
  });

  it("reads a string budget", () => {
    expect(readThreads(" 8 ")).toBe(8);
    expect(readThreads("1000", { maxThreads: 10 })).toBe(10);
    expect(readThreads("auto", { defaultThreads: 5 })).toBe(5);
    expect(readThreads("auto")).toBe(4);
  });

  it("returns null for anything it cannot read as a positive count", () => {
    expect(readThreads(undefined)).toBeNull();
    expect(readThreads(null)).toBeNull();
    expect(readThreads(0)).toBeNull();
    expect(readThreads(-1n)).toBeNull();
    expect(readThreads("")).toBeNull();
    expect(readThreads("   ")).toBeNull();
    expect(readThreads("many")).toBeNull();
    expect(readThreads(Number.NaN)).toBeNull();
    expect(readThreads({ threads: 4 })).toBeNull();
    expect(readRomWeaverRequestedThreadCount(asCommand({ args: { threads: 4 }, type: "probe" }))).toBeNull();
  });

  it("reads through a run request wrapper", () => {
    expect(
      readRomWeaverRequestedThreadCount(
        asRequest({ command: { args: { threads: "auto" }, type: "extract" }, output: {} }),
      ),
    ).toBe(4);
  });
});

describe("legacy raw command inspection", () => {
  it("preserves legacy commands through thread modifiers and preserves output options", () => {
    const command = asCommand({
      type: "bundle",
      args: { type: "parse", args: { input: "/recipe.json", output: "/out" } },
    });
    const request = { command, output: { json: true } };
    const injected = withRomWeaverDefaultThreads(request, 3);
    expect(injected.command.type).toBe("bundle");
    expect(readRomWeaverRequestedThreadCount(injected)).toBe(3);
    expect(injected.output).toEqual({ json: true });
    expect(withRomWeaverForcedThreads(request, 2)).toEqual({
      ...injected,
      command: { type: "bundle", args: { type: "parse", args: { input: "/recipe.json", output: "/out", threads: 2 } } },
    });
    expect(clampRomWeaverBrowserThreadRequest(request).command.type).toBe("bundle");
  });
  it("preserves legacy fields when creating a command using a legacy label", () => {
    const command = createRomWeaverCommand("bundle-create", { output: "recipe.json", bundle: "old.zip" } as never);
    expect(command).toEqual({
      type: "bundle",
      args: { type: "create", args: { output: "recipe.json", bundle: "old.zip" } },
    });
  });

  it.each([false, true])("preserves raw legacy inputs while helpers inspect them (request: %s)", (request) => {
    const command = asCommand({
      type: "bundle",
      args: { type: "parse", args: { input: "/work/recipe.json", output: "/work/out", threads: 3 } },
    });
    const input = request ? { command, output: { json: true } } : command;
    expect(collectRomWeaverRunInputPaths(input)).toEqual(["/work/recipe.json"]);
    expect(readRomWeaverRequestedThreadCount(input)).toBe(3);
    expect(getRomWeaverCommandLabel(command)).toBe("bundle-parse");
    expect(romWeaverCommandSupportsThreads(command)).toBe(true);
    expect(readRomWeaverRunInputCommand(input)).toEqual({ type: "bundle", args: command.args });
    expect(normalizeRomWeaverRunRequest(input).command).toEqual({ type: "weave", args: command.args });
    expect((command as { type: unknown }).type).toBe("bundle");
  });
});
