import { describe, expect, it, vi } from "vitest";
import { lookupExpectedRom } from "../../src/lib/apply/expected-rom-lookup.ts";
import { attachBareRomIngestMetadata } from "../../src/lib/input/input-preparation-archive.ts";
import { finalizeApplyInputChecksums } from "../../src/lib/workflow/apply-input-checksums.ts";

vi.mock("../../src/lib/apply/expected-rom-lookup.ts", () => ({ lookupExpectedRom: vi.fn() }));

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const setup = (retry: Promise<boolean>) => {
  const rom = {
    file: {
      _sourceRef: { fileName: "game.sfc", size: 8, source: "/work/game.sfc" },
      fileName: "game.sfc",
      fileSize: 8,
    },
    fileName: "game.sfc",
    id: "rom",
    kind: "rom",
    patchable: true,
    size: 8,
  } as Record<string, unknown>;
  const stage = {
    parentCompressions: [],
    preparedInputAssets: [rom],
    state: {
      candidates: [],
      fileName: "game.sfc",
      id: "input-1",
      order: 0,
      role: "input",
      status: "ready",
      warnings: [],
    },
  };
  const session = { stages: [stage], synthetic: false, view: stage };
  const runtime = {
    ingest: {
      run: vi.fn(async () => ({
        identifyRetry: retry,
        identifyUnavailable: "ROM identify data did not finish within 5000 ms",
        result: { assets: [{ checksums: { crc32: "D4C3B2A1" }, isRom: true }], isRom: true },
      })),
    },
  };
  let current = true;
  const adapters = {
    emitProgress: vi.fn(),
    getSelectedInputOwner: vi.fn(() => stage),
    isCurrentSession: vi.fn(() => current),
    onIdentified: vi.fn(),
    runtime,
    settings: {},
    syncInputSessionView: vi.fn(),
    workflowId: "apply",
  };
  return { adapters, remove: () => (current = false), rom, runtime, session, stage };
};

describe("late identification after the ingest bound", () => {
  it("moves a timed-out input from unavailable to the identified state without re-running checksums", async () => {
    let settle: (ok: boolean) => void = () => undefined;
    const { adapters, rom, runtime, session, stage } = setup(new Promise<boolean>((resolve) => (settle = resolve)));
    vi.mocked(lookupExpectedRom).mockResolvedValue(undefined);

    await finalizeApplyInputChecksums(session as never, adapters as never);
    expect((rom.identification as { status: string }).status).toBe("unavailable");
    expect(stage.state).toMatchObject({ identification: { status: "unavailable" } });

    settle(true);
    await flush();

    expect(lookupExpectedRom).toHaveBeenCalledWith({ checksums: { crc32: "d4c3b2a1" }, size: 8 });
    expect(rom.identification).toEqual({ matches: [], status: "unknown" });
    expect(stage.state).toMatchObject({ identification: { matches: [], status: "unknown" } });
    expect(adapters.onIdentified).toHaveBeenCalledTimes(1);
    expect(runtime.ingest.run).toHaveBeenCalledTimes(1);
  });

  it("does not update an input removed or replaced before the background load settled", async () => {
    let settle: (ok: boolean) => void = () => undefined;
    const { adapters, remove, rom, session } = setup(new Promise<boolean>((resolve) => (settle = resolve)));
    vi.mocked(lookupExpectedRom).mockResolvedValue({ matches: [], status: "unknown" });

    await finalizeApplyInputChecksums(session as never, adapters as never);
    remove();
    settle(true);
    await flush();

    expect((rom.identification as { status: string }).status).toBe("unavailable");
    expect(adapters.onIdentified).not.toHaveBeenCalled();
  });

  it("keeps unavailable when the background load fails or the lookup stays unavailable", async () => {
    const failed = setup(Promise.resolve(false));
    await finalizeApplyInputChecksums(failed.session as never, failed.adapters as never);
    await flush();
    expect((failed.rom.identification as { status: string }).status).toBe("unavailable");
    expect(failed.adapters.onIdentified).not.toHaveBeenCalled();

    vi.mocked(lookupExpectedRom).mockRejectedValue(new Error("pack corrupt"));
    const rejected = setup(Promise.resolve(true));
    await finalizeApplyInputChecksums(rejected.session as never, rejected.adapters as never);
    await flush();
    expect((rejected.rom.identification as { status: string }).status).toBe("unavailable");
    expect(rejected.adapters.onIdentified).not.toHaveBeenCalled();
  });

  it("keeps unavailable and re-identifies when the ingest result was consumed during input preparation", async () => {
    // The real Apply path: a bare ROM is ingested while preparing the input, so the checksum step
    // reuses those values and never calls ingest.run itself.
    let settle: (ok: boolean) => void = () => undefined;
    const { adapters, rom, runtime, session, stage } = setup(new Promise<boolean>((resolve) => (settle = resolve)));
    const checksums = { crc32: "d4c3b2a1", md5: "m".repeat(32), sha1: "s".repeat(40) };
    const ingested = await runtime.ingest.run();
    runtime.ingest.run.mockResolvedValue({
      ...ingested,
      result: { assets: [{ checksums, isRom: true }], isRom: true },
    });
    runtime.ingest.run.mockClear();
    await attachBareRomIngestMetadata(rom.file as never, undefined, {
      ...runtime,
      name: "browser",
      workerIo: {},
    } as never);
    expect(runtime.ingest.run).toHaveBeenCalledTimes(1);
    runtime.ingest.run.mockClear();
    vi.mocked(lookupExpectedRom).mockResolvedValue(undefined);
    (runtime.ingest.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("must not re-ingest"));

    await finalizeApplyInputChecksums(session as never, adapters as never);
    expect(runtime.ingest.run).not.toHaveBeenCalled();
    expect((rom.identification as { status: string }).status).toBe("unavailable");
    expect(stage.state).toMatchObject({ identification: { status: "unavailable" } });
    expect(adapters.onIdentified).not.toHaveBeenCalled();

    settle(true);
    await flush();
    expect(rom.identification).toEqual({ matches: [], status: "unknown" });
    expect(adapters.onIdentified).toHaveBeenCalledTimes(1);
  });
});
