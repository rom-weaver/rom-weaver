import { describe, expect, it, vi } from "vitest";
import { lookupExpectedRom } from "../../src/lib/apply/expected-rom-lookup.ts";
import { CreateWorkflowController } from "../../src/lib/workflow/create-workflow-controller.ts";
import { TrimWorkflowController } from "../../src/lib/workflow/trim-workflow-controller.ts";

vi.mock("../../src/lib/apply/expected-rom-lookup.ts", () => ({ lookupExpectedRom: vi.fn() }));

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const MATCH = {
  matches: [{ name: "Super Game (USA)", source: "no-intro" }],
  status: "matched",
} as const;

const makeRuntime = (retry: Promise<boolean>, extraAssetFields: Record<string, unknown> = {}) => ({
  ingest: {
    run: vi.fn(async () => ({
      identifyRetry: retry,
      identifyUnavailable: "ROM identify data did not finish within 5000 ms",
      result: {
        assets: [{ checksums: { crc32: "D4C3B2A1" }, isRom: true, ...extraAssetFields }],
        isRom: true,
      },
    })),
  },
});

const makeStage = (role: "input" | "original") => {
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
    selectedArchiveEntry: undefined,
    source: { name: "game.sfc" },
    state: {
      candidates: [],
      fileName: "game.sfc",
      id: "input-1",
      order: 0,
      parentCompressions: [],
      role,
      selectedCandidateId: "c",
      size: 8,
      status: "ready",
      warnings: [],
    },
  };
  return { rom, stage };
};

type TrimInternals = {
  finalizeInputStableState: (stage: unknown) => Promise<void>;
  inputStage?: unknown;
  manualOutputName: boolean;
  outputLocked: boolean;
  outputName: string;
};

const setupTrim = (retry: Promise<boolean>) => {
  const controller = new TrimWorkflowController<unknown, unknown>(makeRuntime(retry) as never, {});
  const internals = controller as unknown as TrimInternals;
  const { rom, stage } = makeStage("input");
  internals.inputStage = stage;
  const onChange = vi.fn();
  controller.subscribe(onChange);
  return { controller, internals, onChange, rom, stage };
};

describe("TrimWorkflowController late identification", () => {
  it("upgrades a timed-out input on a match, names the output from it and notifies", async () => {
    let settle: (ok: boolean) => void = () => undefined;
    const { controller, internals, onChange, rom, stage } = setupTrim(new Promise((resolve) => (settle = resolve)));
    vi.mocked(lookupExpectedRom).mockResolvedValue(MATCH as never);
    await internals.finalizeInputStableState(stage);
    internals.outputName = controller.getSnapshot().outputName;
    expect(stage.state).toMatchObject({ identification: { status: "unavailable" } });
    onChange.mockClear();

    settle(true);
    await flush();

    expect(rom.identification).toMatchObject({ status: "matched" });
    expect(stage.state).toMatchObject({ identification: { status: "matched" } });
    expect(controller.getSnapshot().outputName).toBe("Super Game (USA) (trimmed).sfc");
    expect(onChange).toHaveBeenCalled();
  });

  it("keeps a typed output name, a started run and a replaced input untouched", async () => {
    vi.mocked(lookupExpectedRom).mockResolvedValue(MATCH as never);
    let settleTyped: (ok: boolean) => void = () => undefined;
    const typed = setupTrim(new Promise((resolve) => (settleTyped = resolve)));
    await typed.internals.finalizeInputStableState(typed.stage);
    await typed.controller.setOutputName("mine.sfc");
    settleTyped(true);
    await flush();
    expect(typed.controller.getSnapshot().outputName).toBe("mine.sfc");
    expect(typed.stage.state).toMatchObject({ identification: { status: "matched" } });

    let settleRun: (ok: boolean) => void = () => undefined;
    const ran = setupTrim(new Promise((resolve) => (settleRun = resolve)));
    await ran.internals.finalizeInputStableState(ran.stage);
    ran.internals.outputName = "game (trimmed).sfc";
    ran.internals.outputLocked = true;
    settleRun(true);
    await flush();
    expect(ran.controller.getSnapshot().outputName).toBe("game (trimmed).sfc");

    let settleGone: (ok: boolean) => void = () => undefined;
    const gone = setupTrim(new Promise((resolve) => (settleGone = resolve)));
    await gone.internals.finalizeInputStableState(gone.stage);
    gone.internals.inputStage = undefined;
    settleGone(true);
    await flush();
    expect((gone.rom.identification as { status: string }).status).toBe("unavailable");
  });

  it("reports unknown only for a plain single blob and survives a failed lookup", async () => {
    vi.mocked(lookupExpectedRom).mockResolvedValue({ matches: [], status: "unknown" });
    const plain = setupTrim(Promise.resolve(true));
    await plain.internals.finalizeInputStableState(plain.stage);
    await flush();
    expect((plain.rom.identification as { status: string }).status).toBe("unknown");

    const variant = { checksums: { crc32: "11111111" }, kind: "headerless" };
    const headered = new TrimWorkflowController<unknown, unknown>(
      makeRuntime(Promise.resolve(true), { checksumVariants: [variant, variant] }) as never,
      {},
    );
    const h = makeStage("input");
    (headered as unknown as TrimInternals).inputStage = h.stage;
    await (headered as unknown as TrimInternals).finalizeInputStableState(h.stage);
    await flush();
    expect((h.rom.identification as { status: string }).status).toBe("unavailable");

    vi.mocked(lookupExpectedRom).mockRejectedValue(new Error("pack corrupt"));
    const failed = setupTrim(Promise.resolve(true));
    await failed.internals.finalizeInputStableState(failed.stage);
    await flush();
    expect((failed.rom.identification as { status: string }).status).toBe("unavailable");
  });
});

type CreateInternals = {
  finalizeSourceStableState: (session: unknown) => Promise<void>;
  originalSession?: unknown;
};

describe("CreateWorkflowController late identification", () => {
  const setupCreate = (retry: Promise<boolean>) => {
    const controller = new CreateWorkflowController<unknown, unknown>(makeRuntime(retry) as never, {});
    const internals = controller as unknown as CreateInternals;
    const { rom, stage } = makeStage("original");
    const session = { source: {}, stages: [stage], synthetic: false, view: stage };
    internals.originalSession = session;
    const onChange = vi.fn();
    controller.subscribe(onChange);
    return { controller, internals, onChange, rom, session, stage };
  };

  it("upgrades a timed-out source on a match and notifies", async () => {
    let settle: (ok: boolean) => void = () => undefined;
    const { internals, onChange, rom, session, stage } = setupCreate(new Promise((resolve) => (settle = resolve)));
    vi.mocked(lookupExpectedRom).mockResolvedValue(MATCH as never);
    await internals.finalizeSourceStableState(session);
    expect(stage.state).toMatchObject({ identification: { status: "unavailable" } });
    onChange.mockClear();
    settle(true);
    await flush();
    expect(rom.identification).toMatchObject({ status: "matched" });
    expect(stage.state).toMatchObject({ identification: { status: "matched" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("drops a late result for a removed source and keeps unavailable on a failed load", async () => {
    vi.mocked(lookupExpectedRom).mockResolvedValue(MATCH as never);
    let settle: (ok: boolean) => void = () => undefined;
    const gone = setupCreate(new Promise((resolve) => (settle = resolve)));
    await gone.internals.finalizeSourceStableState(gone.session);
    gone.internals.originalSession = undefined;
    settle(true);
    await flush();
    expect((gone.rom.identification as { status: string }).status).toBe("unavailable");

    const failed = setupCreate(Promise.resolve(false));
    await failed.internals.finalizeSourceStableState(failed.session);
    await flush();
    expect((failed.rom.identification as { status: string }).status).toBe("unavailable");
  });
});
