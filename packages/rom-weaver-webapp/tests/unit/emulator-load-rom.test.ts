import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowProgress } from "../../src/platform/browser/browser-api.ts";
import {
  loadEmulatorRom,
  pickEmulatorRomOutput,
  renameRomToOutput,
} from "../../src/public/react/components/emulator-load-rom.ts";

const workflowMocks = vi.hoisted(() => ({
  constructorOptions: null as { signal?: AbortSignal } | null,
  dispose: vi.fn(async () => undefined),
  getBlob: vi.fn(async () => new Blob(["game"])),
  listener: null as ((progress: WorkflowProgress) => void) | null,
  outputDispose: vi.fn(async () => undefined),
}));

vi.mock("../../src/platform/browser/browser-api.ts", () => ({
  ApplyWorkflow: class {
    constructor(options: { signal?: AbortSignal }) {
      workflowMocks.constructorOptions = options;
    }

    on(_event: "progress", listener: (progress: WorkflowProgress) => void) {
      workflowMocks.listener = listener;
    }

    off(_event: "progress", listener: (progress: WorkflowProgress) => void) {
      if (workflowMocks.listener === listener) workflowMocks.listener = null;
    }

    async setInput() {
      return undefined;
    }

    async run() {
      workflowMocks.listener?.({
        id: "extract",
        label: "Extracting games.zip...",
        percent: 42,
        role: "input",
        sequence: 1,
        stage: "decompress",
        workflow: "apply",
      });
      return {
        outputs: [
          {
            dispose: workflowMocks.outputDispose,
            fileName: "game.nes",
            getBlob: workflowMocks.getBlob,
          },
        ],
      };
    }

    dispose = workflowMocks.dispose;
  },
}));

type ArchiveOutput = Parameters<typeof pickEmulatorRomOutput>[0][number];

const output = (fileName: string): ArchiveOutput => ({ fileName }) as ArchiveOutput;

beforeEach(() => {
  workflowMocks.constructorOptions = null;
  workflowMocks.dispose.mockClear();
  workflowMocks.getBlob.mockClear();
  workflowMocks.listener = null;
  workflowMocks.outputDispose.mockClear();
});

it("forwards archive extraction progress and releases the workflow", async () => {
  const onProgress = vi.fn();
  const abortController = new AbortController();

  const loaded = await loadEmulatorRom(new Blob(["archive"]), "games.zip", {
    onProgress,
    signal: abortController.signal,
  });

  expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ label: "Extracting games.zip...", percent: 42 }));
  expect(workflowMocks.constructorOptions?.signal).toBe(abortController.signal);
  expect(loaded.fileName).toBe("game.nes");
  expect(workflowMocks.listener).toBeNull();
  expect(workflowMocks.outputDispose).toHaveBeenCalledOnce();
  expect(workflowMocks.dispose).toHaveBeenCalledOnce();
});

describe("pickEmulatorRomOutput", () => {
  it("throws when the archive produced no files", () => {
    expect(() => pickEmulatorRomOutput([])).toThrow("did not produce any files");
  });

  it("prefers a ROM-extension output over an earlier non-ROM file", () => {
    const rom = output("game.nes");
    expect(pickEmulatorRomOutput([output("readme.txt"), rom])).toBe(rom);
  });

  it("prefers a ROM with an emulator core over one without", () => {
    const withCore = output("game.nes");
    expect(pickEmulatorRomOutput([output("disc.iso"), withCore])).toBe(withCore);
  });

  it("falls back to the first ROM when no output has a core", () => {
    const first = output("disc.iso");
    expect(pickEmulatorRomOutput([output("notes.txt"), first, output("disc2.iso")])).toBe(first);
  });

  it("falls back to the first output when nothing matches a ROM extension", () => {
    const first = output("readme.txt");
    expect(pickEmulatorRomOutput([first, output("cover.png")])).toBe(first);
  });
});

describe("renameRomToOutput", () => {
  it("keeps the output stem and takes the ROM's extension", () => {
    expect(renameRomToOutput("my-hack.zip", "Legend of Zelda, The (U).nes")).toBe("my-hack.nes");
  });

  it("is the identity when the output was not an archive", () => {
    expect(renameRomToOutput("my-hack.nes", "my-hack.nes")).toBe("my-hack.nes");
  });

  it("handles a ROM without an extension", () => {
    expect(renameRomToOutput("my-hack.zip", "ROMFILE")).toBe("my-hack");
  });
});
