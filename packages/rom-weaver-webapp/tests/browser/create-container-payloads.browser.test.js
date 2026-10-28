import { expect, test } from "vitest";
import { ApplyWorkflow, CreateWorkflow } from "../../src/platform/browser/browser-api.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { csoFixture, patchContainerFixtures, xisoFixture } from "../fixtures/synthetic-patch-containers.mjs";

const cueText = (fileName) => `FILE "${fileName}" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`;

const expectPayloadSize = (state, size, isPbp) => {
  expect(state.fileName).toMatch(/\.(iso|bin)$/i);
  if (isPbp) {
    expect(state.size).toBe(size + new TextEncoder().encode(cueText(state.fileName)).length);
  } else {
    expect(state.size).toBe(size);
  }
};

const expectOutputPayload = async (output, expected, hasCue) => {
  let extracted;
  try {
    let blob = await output.getBlob();
    if (hasCue) {
      expect(output.fileName).toMatch(/\.zip$/i);
      extracted = await browserRuntime.compression.extract({
        source: new File([blob], output.fileName),
        entries: [],
        format: "zip",
        extractAll: true,
        options: { threads: 1 },
      });
      expect(extracted.outputs).toHaveLength(2);
      const track = extracted.outputs.find((entry) => /\.bin$/i.test(entry.fileName));
      const sheet = extracted.outputs.find((entry) => /\.cue$/i.test(entry.fileName));
      expect(track).toBeTruthy();
      expect(sheet).toBeTruthy();
      expect(await (await browserRuntime.publicOutput.getBlob(sheet)).text()).toBe(cueText(track.fileName).trimEnd());
      blob = await browserRuntime.publicOutput.getBlob(track);
    } else {
      expect(output.fileName).toMatch(/\.(iso|bin)$/i);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes.length).toBe(expected.length);
    expect(bytes.findIndex((value, index) => value !== expected[index])).toBe(-1);
  } finally {
    if (extracted) await Promise.all(extracted.outputs.map((entry) => entry.dispose()));
  }
};

const roundTrip = async (original, modified, expected, format = "bps") => {
  const create = new CreateWorkflow({ settings: { format, workers: { threads: 1 } } });
  const apply = new ApplyWorkflow({ settings: { output: { compression: "none" }, workers: { threads: 1 } } });
  try {
    await create.setOriginal(original);
    await create.setModified(modified);
    const created = await create.run();
    try {
      const originalState = create.getOriginal();
      const modifiedState = create.getModified();
      expectPayloadSize(originalState, expected.length, original.name.endsWith(".pbp"));
      expectPayloadSize(modifiedState, expected.length, modified.name.endsWith(".pbp"));
      const patch = new File([await created.output.getBlob()], created.output.fileName);
      await apply.setInput(original);
      expect(apply.getInput().size).toBe(originalState.size);
      expect(apply.getInput().checksums.crc32).toBe(originalState.checksums.crc32);
      await apply.addPatch(patch);
      const applied = await apply.run();
      try {
        await expectOutputPayload(applied.output, expected, original.name.endsWith(".pbp"));
      } finally {
        await applied.output.dispose();
      }
    } finally {
      await created.output.dispose();
    }
  } finally {
    await apply.dispose();
    await create.dispose();
  }
};

for (const { extension, container, payload, payloadExtension } of patchContainerFixtures()) {
  for (const role of ["original", "modified"]) {
    test(`Create and Apply use the expanded ${extension} payload as ${role}`, async () => {
      const wrapped = new File([container], `source.${extension}`);
      const edited = payload.slice();
      edited[1234] ^= 1;
      const raw = new File([edited], `edited.${payloadExtension}`);
      await roundTrip(
        role === "original" ? wrapped : raw,
        role === "modified" ? wrapped : raw,
        role === "original" ? edited : payload,
      );
    });
  }
}

test("CSO to IPS preserves an edit at ROM offset zero", async () => {
  const { container, payload } = csoFixture();
  const expected = payload.slice();
  expected[0] = 0x43;
  await roundTrip(new File([container], "source.cso"), new File([expected], "target.iso"), expected, "ips");
});

test.each([1234, 69632])("XISO BPS accepts its unchanged Original after an edit at %i", async (offset) => {
  const source = new File([xisoFixture()], "canonical.xiso");
  const extracted = await browserRuntime.compression.extract({
    source,
    entries: [],
    descendSinglePayload: true,
    format: "xiso",
    options: { threads: 1 },
  });
  try {
    const canonical = new Uint8Array(await (await browserRuntime.publicOutput.getBlob(extracted.output)).arrayBuffer());
    expect(canonical.length).toBe(131072);
    expect(canonical[1234]).toBe(0);
    expect(new TextDecoder().decode(canonical.subarray(69632, 69640))).toBe("XBE-STUB");
    const original = canonical.slice();
    original[offset] ^= 1;
    await roundTrip(new File([original], "original.iso"), new File([canonical], "canonical.xiso"), canonical);
  } finally {
    await Promise.all(extracted.outputs.map((output) => output.dispose()));
  }
});
