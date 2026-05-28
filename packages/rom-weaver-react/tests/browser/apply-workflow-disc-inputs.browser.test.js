import { expect, test } from "vitest";
import { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";

const RAW_ROM = "tests/fixtures/archive_sources/game.bin";
const ONE_PATCH_7Z = "tests/fixtures/archives/one-patch.7z";
const MULTI_PATCH_ZIP = "tests/fixtures/archives/multi-patch.zip";

const loadFixtureFile = async (filePath, type = "application/octet-stream") => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  const bytes = await response.arrayBuffer();
  return new File([bytes], filePath.split("/").pop() || "input.bin", { type });
};

const createTraceWorkflow = () => {
  const logs = [];
  const workflow = new ApplyWorkflow({
    settings: {
      logging: {
        level: "trace",
        sink: (record) => {
          logs.push(record || {});
        },
      },
    },
  });
  return { logs, workflow };
};

test("apply workflow resolves RVZ inputs to extracted names during staging", async () => {
  const workflow = new ApplyWorkflow();
  const progressEvents = [];
  workflow.on("progress", (event) => progressEvents.push(event));
  try {
    await workflow.setInput(await loadFixtureFile("tests/fixtures/browser-generated/game.rvz"));
    const input = workflow.getInput();
    expect(input?.fileName).toBe("game.iso");
    expect(input?.wasDecompressed).toBe(true);
    expect(input?.parentCompressions?.map((entry) => entry.fileName) || []).toContain("game.rvz");
    expect(
      progressEvents.some(
        (event) => event.role === "input" && event.stage === "decompress" && /^extracted\b/i.test(event.label || ""),
      ),
    ).toBe(false);
    const lastExtractIndex = progressEvents.findLastIndex(
      (event) => event.role === "input" && event.stage === "decompress",
    );
    const checksumIndex = progressEvents.findIndex((event) => event.role === "input" && event.stage === "checksum");
    expect(lastExtractIndex).toBeGreaterThanOrEqual(0);
    expect(checksumIndex).toBe(-1);
  } finally {
    await workflow.dispose();
  }
});

test("apply workflow resolves CHD inputs to extracted names during staging", async () => {
  const workflow = new ApplyWorkflow();
  const progressEvents = [];
  workflow.on("progress", (event) => progressEvents.push(event));
  try {
    await workflow.setInput(await loadFixtureFile("tests/fixtures/browser-generated/game-cd.chd"));
    const input = workflow.getInput();
    expect(input?.fileName).not.toMatch(/\.chd$/i);
    expect(input?.wasDecompressed).toBe(true);
    const checksumIndex = progressEvents.findIndex((event) => event.role === "input" && event.stage === "checksum");
    expect(checksumIndex).toBe(-1);
  } finally {
    await workflow.dispose();
  }
});

test("patch archive staging extract dispatch omits checksum args in browser", async () => {
  const { workflow, logs } = createTraceWorkflow();
  try {
    await workflow.setInput(await loadFixtureFile(RAW_ROM));
    await workflow.addPatch(await loadFixtureFile(ONE_PATCH_7Z, "application/x-7z-compressed"));
    await expect
      .poll(
        () =>
          workflow
            .getPatches()
            .map((patch) => patch.fileName)
            .join(","),
        { timeout: 30000 },
      )
      .toMatch(/change\.ips/i);
    await expect
      .poll(() => logs.find((entry) => String(entry?.message || "") === "runJson extract dispatch") || null, {
        timeout: 30000,
      })
      .not.toBeNull();
    const extractDispatch = logs.find((entry) => String(entry?.message || "") === "runJson extract dispatch");
    const args = Array.isArray(extractDispatch?.details?.args) ? extractDispatch.details.args.map(String) : [];
    expect(args).toContain("extract");
    expect(args).not.toContain("--checksum");
  } finally {
    await workflow.dispose();
  }
});

test("patch archive candidate discovery does not extract every candidate", async () => {
  const { workflow, logs } = createTraceWorkflow();
  try {
    await workflow.setInput(await loadFixtureFile(RAW_ROM));
    await workflow.addPatch(await loadFixtureFile(MULTI_PATCH_ZIP, "application/zip"));
    const patch = workflow.getPatches()[0];
    expect(patch?.status).toBe("needsSelection");
    const extractDispatches = logs.filter((entry) => String(entry?.message || "") === "runJson extract dispatch");
    expect(extractDispatches).toHaveLength(0);
  } finally {
    await workflow.dispose();
  }
});

test("RVZ staging emits list then extract trace events", async () => {
  const { workflow, logs } = createTraceWorkflow();
  try {
    await workflow.setInput(await loadFixtureFile("tests/fixtures/browser-generated/game.rvz"));
    const messages = logs.map((entry) => String(entry?.message || ""));
    const listIndex = messages.findIndex((message) => message === "input.archive.list.finish");
    const extractIndex = messages.findIndex((message) => message === "input.archive.extract.start");
    const workerTraceLines = logs
      .filter((entry) => entry?.namespace === "runtime:rom-weaver")
      .map((entry) => String(entry?.message || "").trim())
      .filter((line) => !!line);
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThan(listIndex);
    expect(workerTraceLines.length).toBeGreaterThan(0);
    expect(workerTraceLines.some((line) => line.includes('command="extract"'))).toBe(true);
    expect(workerTraceLines.some((line) => line.includes("scratch=1"))).toBe(true);
  } finally {
    await workflow.dispose();
  }
});

test("CHD staging emits list then extract trace events", async () => {
  const { workflow, logs } = createTraceWorkflow();
  try {
    await workflow.setInput(await loadFixtureFile("tests/fixtures/browser-generated/game-cd.chd"));
    const messages = logs.map((entry) => String(entry?.message || ""));
    const workerTraceLines = logs
      .filter((entry) => entry?.namespace === "runtime:rom-weaver")
      .map((entry) => String(entry?.message || "").trim())
      .filter((line) => !!line);
    const listIndex = messages.findIndex((message) => message === "input.archive.list.finish");
    const extractIndex = messages.findIndex((message) => message === "input.archive.extract.start");
    const extractDispatch = logs.find((entry) => String(entry?.message || "") === "runJson extract dispatch");
    const checksumDispatch = logs.find((entry) => String(entry?.message || "") === "runJson checksum dispatch");
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThan(listIndex);
    expect(workerTraceLines.length).toBeGreaterThan(0);
    expect(workerTraceLines.some((line) => line.includes('command="extract"'))).toBe(true);
    const args = Array.isArray(extractDispatch?.details?.args) ? extractDispatch.details.args.map(String) : [];
    expect(args.filter((value) => value === "--checksum").length).toBeGreaterThanOrEqual(3);
    expect(args).toContain("crc32");
    expect(args).toContain("md5");
    expect(args).toContain("sha1");
    expect(checksumDispatch).toBeUndefined();
  } finally {
    await workflow.dispose();
  }
});
