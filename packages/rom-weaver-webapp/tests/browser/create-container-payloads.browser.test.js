import { expect, test } from "vitest";
import { ApplyWorkflow, CreateWorkflow } from "../../src/platform/browser/browser-api.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import {
  csoFixture,
  patchContainerFixtures,
  rawBpsFixture,
  rawCrc32,
  xisoFixture,
} from "../fixtures/synthetic-patch-containers.mjs";

const cueText = (fileName) => `FILE "${fileName}" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`;

const expectPayloadSize = (state, size, isPbp, sourceName) => {
  if (/\.xiso$/i.test(sourceName)) expect(state.fileName).toBe(sourceName);
  else expect(state.fileName).toMatch(/\.(iso|bin)$/i);
  if (isPbp) {
    expect(state.size).toBe(size + new TextEncoder().encode(cueText(state.fileName)).length);
  } else {
    expect(state.size).toBe(size);
  }
};

const expectOutputPayload = async (output, expected, hasCue, sourceName = "") => {
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
    } else if (/\.xiso$/i.test(sourceName)) {
      expect(output.fileName).toMatch(/\.xiso$/i);
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

const roundTrip = async (original, modified, expected, format = "bps", applyInputs = [original], sourceCrc32) => {
  const create = new CreateWorkflow({ settings: { format, workers: { threads: 1 } } });
  const apply = new ApplyWorkflow({ settings: { output: { compression: "none" }, workers: { threads: 1 } } });
  try {
    await create.setOriginal(original);
    await create.setModified(modified);
    const created = await create.run();
    try {
      const originalState = create.getOriginal();
      const modifiedState = create.getModified();
      expectPayloadSize(originalState, expected.length, original.name.endsWith(".pbp"), original.name);
      expectPayloadSize(modifiedState, expected.length, modified.name.endsWith(".pbp"), modified.name);
      const patch = new File([await created.output.getBlob()], created.output.fileName);
      if (sourceCrc32) expect(originalState.checksums.crc32).toBe(sourceCrc32);
      for (const [index, input] of applyInputs.entries()) {
        await apply.setInput(input);
        expect(apply.getInput().size).toBe(originalState.size);
        expect(apply.getInput().checksums.crc32).toBe(originalState.checksums.crc32);
        if (!index) await apply.addPatch(patch);
        const applied = await apply.run();
        try {
          await expectOutputPayload(applied.output, expected, original.name.endsWith(".pbp"), original.name);
        } finally {
          await applied.output.dispose();
        }
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

const zipXiso = async (bytes) => {
  const { output } = await browserRuntime.compression.create({
    entries: [{ data: bytes, fileName: "original.iso", filename: "original.iso" }],
    format: "zip",
    options: { outputName: "original.zip", threads: 1 },
  });
  try {
    return new File([await browserRuntime.publicOutput.getBlob(output)], "original.zip");
  } finally {
    await output.dispose();
  }
};

const canonicalXiso = async () => {
  const extracted = await browserRuntime.compression.extract({
    source: new File([xisoFixture()], "canonical.xiso"),
    entries: [],
    descendSinglePayload: true,
    format: "xiso",
    options: { threads: 1 },
  });
  try {
    const bytes = new Uint8Array(await (await browserRuntime.publicOutput.getBlob(extracted.output)).arrayBuffer());
    expect(bytes.length).toBe(131072);
    expect(bytes[1234]).toBe(0);
    expect(new TextDecoder().decode(bytes.subarray(69632, 69640))).toBe("XBE-STUB");
    return bytes;
  } finally {
    await Promise.all(extracted.outputs.map((output) => output.dispose()));
  }
};

for (const role of ["bare", "zip"]) {
  test.each([1234, 69632])(`XISO BPS preserves raw ${role} Original after an edit at %i`, async (offset) => {
    const canonical = await canonicalXiso();
    const original = canonical.slice();
    original[offset] ^= 1;
    const bare = new File([original], "original.iso");
    const zip = await zipXiso(original);
    await roundTrip(
      role === "bare" ? bare : zip,
      new File([canonical], "canonical.xiso"),
      canonical,
      "bps",
      role === "bare" ? [bare, zip] : [zip, bare],
      rawCrc32(original).toString(16).padStart(8, "0"),
    );
  });
}

test("XISO Modified preserves raw padding bytes", async () => {
  const canonical = await canonicalXiso();
  const modified = canonical.slice();
  modified[1234] ^= 1;
  await roundTrip(new File([canonical], "original.xiso"), new File([modified], "modified.iso"), modified);
});

test("an independently encoded raw BPS applies to a bare XISO with a video partition", async () => {
  const partitionOffset = 34078720;
  const original = xisoFixture(partitionOffset);
  const { patch, target } = rawBpsFixture(original, partitionOffset + 69632);
  expect(new TextDecoder().decode(original.subarray(0, 25))).toBe("SYNTHETIC VIDEO PARTITION");
  expect(new TextDecoder().decode(original.subarray(partitionOffset + 69632, partitionOffset + 69640))).toBe(
    "XBE-STUB",
  );
  const apply = new ApplyWorkflow({ settings: { output: { compression: "none" }, workers: { threads: 1 } } });
  try {
    await apply.setInput(new File([original], "original.iso"));
    expect(apply.getInput().size).toBe(original.length);
    expect(apply.getInput().checksums.crc32).toBe(rawCrc32(original).toString(16).padStart(8, "0"));
    await apply.addPatch(new File([patch], "external.bps"));
    const applied = await apply.run();
    try {
      await expectOutputPayload(applied.output, target, false);
    } finally {
      await applied.output.dispose();
    }
  } finally {
    await apply.dispose();
  }
});
