import { expect, test } from "vitest";
import { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";

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
  try {
    await workflow.setInput(await loadFixtureFile("tests/fixtures/browser-generated/game.rvz"));
    const input = workflow.getInput();
    expect(input?.fileName).toBe("game.iso");
    expect(input?.wasDecompressed).toBe(true);
    expect(input?.parentCompressions?.map((entry) => entry.fileName) || []).toContain("game.rvz");
  } finally {
    await workflow.dispose();
  }
});

test("apply workflow resolves CHD inputs to extracted names during staging", async () => {
  const workflow = new ApplyWorkflow();
  try {
    await workflow.setInput(await loadFixtureFile("tests/fixtures/browser-generated/game-cd.chd"));
    const input = workflow.getInput();
    expect(input?.fileName).not.toMatch(/\.chd$/i);
    expect(input?.wasDecompressed).toBe(true);
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
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThan(listIndex);
    expect(workerTraceLines.length).toBeGreaterThan(0);
    expect(workerTraceLines.some((line) => line.includes('command="extract"'))).toBe(true);
  } finally {
    await workflow.dispose();
  }
});
