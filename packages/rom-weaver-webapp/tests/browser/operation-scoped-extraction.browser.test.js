import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

const ENTRY_NAMES = ["game.bin", "bonus.sfc"];
const MULTI_ROM_ZIP = "tests/fixtures/archives/multi-rom.zip";

const loadMultiRomArchive = async () => {
  const response = await fetch(`/${MULTI_ROM_ZIP}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${MULTI_ROM_ZIP}`);
  return new File([await response.arrayBuffer()], "multi-rom.zip", { type: "application/zip" });
};

const createZcciFixtureFile = async () => {
  const sourceBytes = new Uint8Array(64 * 1024);
  sourceBytes.set([0x4e, 0x43, 0x53, 0x44], 0);
  for (let index = 4; index < sourceBytes.length; index += 1) sourceBytes[index] = index % 251;
  const source = new File([sourceBytes], "source.cci", { type: "application/octet-stream" });
  const result = await browserRuntime.compression.create?.({
    fileName: source.name,
    format: "z3ds",
    options: { workerThreads: 1 },
    outputName: "game.zcci",
    source: { fileName: source.name, source },
  });
  const output = result?.output;
  if (!output) throw new Error("ZCCI fixture compression did not return output");
  try {
    return new File([await browserRuntime.publicOutput.getBlob(output)], "game.zcci", {
      type: "application/octet-stream",
    });
  } finally {
    await output.dispose().catch(() => undefined);
  }
};

const parentPath = (filePath) => filePath.replace(/\/[^/]+$/, "");
const disposeOutputs = async (outputs) => {
  await Promise.all(outputs.map((output) => output.dispose().catch(() => undefined)));
};

test("browser ingest isolates same-named runs and retains a multi-output scope until its last disposal", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();
  const source = await loadMultiRomArchive();
  const first = await browserRuntime.ingest.run({
    checksumAlgorithms: ["crc32"],
    select: ENTRY_NAMES,
    source,
  });
  const second = await browserRuntime.ingest.run({
    checksumAlgorithms: ["crc32"],
    select: ENTRY_NAMES,
    source,
  });
  const allOutputs = [...first.outputs, ...second.outputs];
  try {
    expect(first.outputs.map((output) => output.fileName).sort()).toEqual([...ENTRY_NAMES].sort());
    expect(second.outputs.map((output) => output.fileName).sort()).toEqual([...ENTRY_NAMES].sort());
    expect(allOutputs.every((output) => output.checksums?.crc32)).toBe(true);
    expect(allOutputs.every((output) => /^\/work\/operations\/[^/]+\//.test(output.path))).toBe(true);

    const firstScope = new Set(first.outputs.map((output) => parentPath(output.path)));
    const secondScope = new Set(second.outputs.map((output) => parentPath(output.path)));
    expect(firstScope.size).toBe(1);
    expect(secondScope.size).toBe(1);
    expect([...firstScope][0]).not.toBe([...secondScope][0]);

    await first.outputs[0].dispose();
    expect(await browserRuntime.vfs.stat(first.outputs[0].path)).toBeNull();
    expect(await browserRuntime.vfs.stat(first.outputs[1].path)).not.toBeNull();
    expect(await browserRuntime.vfs.stat(second.outputs[0].path)).not.toBeNull();

    await first.outputs[1].dispose();
    expect(await Promise.all(first.outputs.map((output) => browserRuntime.vfs.stat(output.path)))).toEqual([
      null,
      null,
    ]);
    expect(await Promise.all(second.outputs.map((output) => browserRuntime.vfs.stat(output.path)))).not.toContain(null);
  } finally {
    await disposeOutputs(allOutputs);
  }
});

test("archive descend shares one operation scope while selected entries use one scope per command", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();
  const extract = browserRuntime.compression.extract;
  if (!extract) throw new Error("Runtime compression extract capability is unavailable");
  const source = await loadMultiRomArchive();
  const descended = await extract({
    descendSinglePayload: true,
    entries: ENTRY_NAMES,
    format: "zip",
    options: { extractChecksumAlgorithms: ["crc32"] },
    source,
  });
  const selected = await extract({
    entries: ENTRY_NAMES,
    format: "zip",
    options: { extractChecksumAlgorithms: ["crc32"] },
    source,
  });
  const allOutputs = [...descended.outputs, ...selected.outputs];
  try {
    expect(descended.outputs.map((output) => output.fileName).sort()).toEqual([...ENTRY_NAMES].sort());
    expect(selected.outputs.map((output) => output.fileName).sort()).toEqual([...ENTRY_NAMES].sort());
    expect(allOutputs.every((output) => output.checksums?.crc32)).toBe(true);
    expect(allOutputs.every((output) => /^\/work\/operations\/[^/]+\//.test(output.path))).toBe(true);

    const descendScopes = new Set(descended.outputs.map((output) => parentPath(output.path)));
    const selectedScopes = new Set(selected.outputs.map((output) => parentPath(output.path)));
    expect(descendScopes.size).toBe(1);
    expect(selectedScopes.size).toBe(2);
    expect(selectedScopes.has([...descendScopes][0])).toBe(false);

    await descended.outputs[0].dispose();
    expect(await browserRuntime.vfs.stat(descended.outputs[0].path)).toBeNull();
    expect(await browserRuntime.vfs.stat(descended.outputs[1].path)).not.toBeNull();

    await selected.outputs[0].dispose();
    expect(await browserRuntime.vfs.stat(selected.outputs[0].path)).toBeNull();
    expect(await browserRuntime.vfs.stat(selected.outputs[1].path)).not.toBeNull();
  } finally {
    await disposeOutputs(allOutputs);
  }
});

test("Z3DS extraction owns and removes its operation scope", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();
  const extract = browserRuntime.compression.extract;
  if (!extract) throw new Error("Runtime compression extract capability is unavailable");
  let output = null;
  try {
    const result = await extract({
      entries: ["game.cci"],
      format: "z3ds",
      options: { workerThreads: 1 },
      outputName: "game.cci",
      source: await createZcciFixtureFile(),
    });
    output = result.output;
    expect(output.fileName).toBe("game.cci");
    expect(output.path).toMatch(/^\/work\/operations\/[^/]+\/game\.cci$/);
    const scopePath = parentPath(output.path);
    await output.dispose();
    output = null;
    expect(await browserRuntime.vfs.stat(scopePath)).toBeNull();
  } finally {
    await output?.dispose().catch(() => undefined);
  }
});
