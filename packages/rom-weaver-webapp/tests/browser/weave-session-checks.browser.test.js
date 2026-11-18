import { expect, test, vi } from "vitest";
import { loadLocalWeaveSession } from "../../src/lib/weave/local-weave-session.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { CreateWorkflow } from "../../src/platform/browser/browser-api.ts";
import { installPatcherTestHooks, loadFixtureFile, RAW_PATCH, RAW_ROM } from "./patcher-test-shared.js";
import {
  buildZip,
  RAW_ROM_CHECKS,
  SAMPLE_ROM,
  SAMPLE_ROM_CHECKS,
  mountStrict,
  hex,
  fileChecks,
  noiseBytes,
  withBytes,
  createBps,
  createIps,
  applyRecords,
  SNES_INTERNAL_HEADER,
  byteSwap16,
  buildTransformWeave,
  applyWeaveAndReadOutput,
  buildWeaveArchive,
  applyOwnEvidenceWeave,
  expectStrictApply,
  sha256Checks,
  withSha256HashCount,
} from "./weave-session-shared.js";

installPatcherTestHooks();

test("weave rom.checks of a headered ROM accept it for a headerless BPS", async () => {
  const headered = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
  const headerless = headered.subarray(16);
  const modified = withBytes(headerless, 0x98, [0x12, 0x0f, 0x0d, 0x00, 0x00]);
  const weaveArchive = await buildTransformWeave(
    SAMPLE_ROM_CHECKS,
    "hack.bps",
    createBps(headerless, modified),
    "hello-world.nes",
  );
  const { options, output } = await applyWeaveAndReadOutput([weaveArchive, await loadFixtureFile(SAMPLE_ROM)]);
  // The patched headerless bytes, with or without the copier header put back.
  expect(hex(output.subarray(output.length - modified.length))).toBe(hex(modified));
  // Never the engine's --expect-in, which checks the transformed bytes and steers the header choice.
  expect(options?.validateWithChecksums).toBeUndefined();
});

test("weave rom.checks of a headered SNES ROM keep the automatic headerless IPS basis", async () => {
  const headerless = withBytes(noiseBytes(1024 * 1024, 0x5eed), 0x7fc0, SNES_INTERNAL_HEADER);
  const headered = new Uint8Array(512 + headerless.length);
  headered.set(headerless, 512);
  const records = [
    [0x100, 0xf2],
    [0x8000, 0x09],
    [0x9001, 0x7e],
    [0xffff0, 0x78],
  ];
  const modified = applyRecords(headerless, records);
  // A hand-written weave may carry only a CRC32 and size for its ROM.
  const { checksums, size } = await fileChecks(headered);
  const weaveArchive = await buildTransformWeave(
    { checksums: { crc32: checksums.crc32 }, size },
    "hack.ips",
    createIps(records),
    "game.smc",
  );
  const { options, output } = await applyWeaveAndReadOutput([weaveArchive, new File([headered], "game.smc")]);
  // With the header wrongly kept, every IPS record would land 512 bytes early.
  expect(hex(output.subarray(output.length - modified.length))).toBe(hex(modified));
  // Never the engine's --expect-in, which checks the transformed bytes and steers the header choice.
  expect(options?.validateWithChecksums).toBeUndefined();
});

test("weave rom.checks of a byte-swapped N64 ROM accept it for a big-endian BPS", async () => {
  const bigEndian = withBytes(noiseBytes(1024 * 1024, 0x64), 0, [0x80, 0x37, 0x12, 0x40]);
  const modified = withBytes(bigEndian, 0x1000, [0xde, 0xad, 0xbe, 0xef]);
  const byteSwapped = byteSwap16(bigEndian);
  const weaveArchive = await buildTransformWeave(
    await fileChecks(byteSwapped),
    "hack.bps",
    createBps(bigEndian, modified),
    "game.v64",
  );
  const { options, output } = await applyWeaveAndReadOutput([weaveArchive, new File([byteSwapped], "game.v64")]);
  const normalized = output[0] === 0x37 && output[1] === 0x80 ? byteSwap16(output) : output;
  expect(hex(normalized)).toBe(hex(modified));
  // Never the engine's --expect-in, which checks the transformed bytes and steers the header choice.
  expect(options?.validateWithChecksums).toBeUndefined();
});

// A patch with no layout evidence of its own (an IPS) applies to the layout the weave's ROM check
// matched: the headerless body, or the big-endian byte order.
test("an IPS applies to the headerless body when rom.checks match only the header-stripped NES ROM", async () => {
  const headered = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
  const body = headered.subarray(16);
  const records = [
    [0x98, 0x12],
    [0x99, 0x0f],
    [0x9a, 0x0d],
  ];
  const weaveArchive = await buildTransformWeave(
    await fileChecks(body),
    "hack.ips",
    createIps(records),
    "hello-world.nes",
  );
  const { output } = await applyWeaveAndReadOutput([weaveArchive, new File([headered], "hello-world.nes")]);
  const modified = applyRecords(body, records);
  expect(hex(output.subarray(output.length - modified.length))).toBe(hex(modified));
});

test("an IPS applies in big-endian order when rom.checks match only the .z64 layout of a .v64 dump", async () => {
  const bigEndian = withBytes(noiseBytes(1024 * 1024, 0x64), 0, [0x80, 0x37, 0x12, 0x40]);
  const records = [
    [0x1000, 0xde],
    [0x1001, 0xad],
    [0x1002, 0xbe],
    [0x1003, 0xef],
    [0x8001, 0x11],
  ];
  const weaveArchive = await buildTransformWeave(
    await fileChecks(bigEndian),
    "hack.ips",
    createIps(records),
    "game.z64",
  );
  const { output } = await applyWeaveAndReadOutput([weaveArchive, new File([byteSwap16(bigEndian)], "game.v64")]);
  const normalized = output[0] === 0x37 && output[1] === 0x80 ? byteSwap16(output) : output;
  expect(hex(normalized)).toBe(hex(applyRecords(bigEndian, records)));
});

test("a patch's own layout evidence still wins over the layout rom.checks matched", async () => {
  const headered = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
  // A BPS made for the headered file: its source CRC32 says keep the header.
  const modified = withBytes(headered, 0x98, [0x12, 0x0f, 0x0d]);
  const weaveArchive = await buildTransformWeave(
    await fileChecks(headered.subarray(16)),
    "hack.bps",
    createBps(headered, modified),
    "hello-world.nes",
  );
  const { output } = await applyWeaveAndReadOutput([weaveArchive, new File([headered], "hello-world.nes")]);
  expect(hex(output)).toBe(hex(modified));
});

test("a patch's declared inputChecks keep its raw layout when rom.checks match only the headerless body", async () => {
  const headered = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
  const records = [
    [0xa8, 0x12],
    [0xa9, 0x0f],
    [0xaa, 0x0d],
  ];
  const patchFile = new File([createIps(records)], "hack.ips");
  const { output } = await applyOwnEvidenceWeave({ inputChecks: await fileChecks(headered) }, patchFile, headered);
  expect(hex(output)).toBe(hex(applyRecords(headered, records)));
});

test.each(["crc32", "md5", "sha1"].map((algorithm) => [algorithm, "base"]))(
  "a later patch's declared %s with %s basis outranks the weave layout",
  async (algorithm, basis) => {
    const headered = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
    const inputChecks = { checksums: { [algorithm]: SAMPLE_ROM_CHECKS.checksums[algorithm] } };
    const firstRecords = [[0xa8, 0x12]];
    const laterRecords = [[0xa9, 0x0f]];
    const patches = [
      new File([createIps(firstRecords)], "first.ips"),
      new File([createIps(laterRecords)], "later.ips"),
    ];
    const weaveArchive = await buildWeaveArchive(
      {
        output: { name: "transform-output" },
        patches: patches.map((patch) => ({ ...(basis === "base" ? { basis } : {}), inputChecks, path: patch.name })),
        rom: { checks: await fileChecks(headered.subarray(16)), name: "hello-world.nes" },
        version: 1,
      },
      patches,
    );
    const { output } = await applyWeaveAndReadOutput([weaveArchive, new File([headered], "hello-world.nes")]);
    expect(hex(output)).toBe(hex(applyRecords(applyRecords(headered, firstRecords), laterRecords)));
  },
);

test("a first patch's SHA256 declaration keeps the validation plan on its raw layout", async () => {
  const headered = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
  const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", headered)));
  const patchFile = new File([createIps([[0xa8, 0x12]])], "hack.ips");
  const weaveArchive = await buildWeaveArchive(
    {
      output: { name: "transform-output" },
      patches: [{ path: patchFile.name, inputChecks: { checksums: { sha256 } } }],
      rom: { checks: await fileChecks(headered.subarray(16)), name: "hello-world.nes" },
      version: 1,
    },
    [patchFile],
  );
  const originalValidate = browserRuntime.patch.validatePatch;
  let result;
  const validateSpy = vi.spyOn(browserRuntime.patch, "validatePatch").mockImplementation(async (input) => {
    result = await originalValidate.call(browserRuntime.patch, input);
    return result;
  });
  try {
    mountStrict([weaveArchive, new File([headered], "hello-world.nes")]);
    await expect.poll(() => result?.plan?.per_patch?.[0]?.input_verdict, { timeout: 30000 }).toBe("passed");
    expect(result.plan.per_patch[0].matched).toEqual({ kind: "base", variant: "raw" });
    expect(validateSpy.mock.calls.at(-1)?.[0]?.options.removeHeader).toBe(false);
  } finally {
    validateSpy.mockRestore();
  }
});

test("a RUP's embedded MD5 keeps its raw layout when rom.checks match only the headerless body", async () => {
  const headered = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
  const modified = withBytes(headered, 0xa8, [0x12, 0x0f, 0x0d]);
  const workflow = new CreateWorkflow({
    settings: { format: "rup", output: { compression: "none", outputName: "hack.rup" }, workers: { threads: 1 } },
  });
  await workflow.setOriginal(new File([headered], "original.nes"));
  await workflow.setModified(new File([modified], "modified.nes"));
  const created = await workflow.run();
  const rupBytes = await (await created.output.getBlob()).arrayBuffer();
  await created.output.dispose();
  // Renamed so no filename checksum token adds evidence: only the RUP's embedded MD5 remains.
  const { output } = await applyOwnEvidenceWeave({}, new File([rupBytes], "hack.rup"), headered);
  expect(hex(output)).toBe(hex(modified));
});

// The browser export writes `target: {rom: true}` on every patch, version 2 and patchBasis auto.
for (const romMatches of [true, false]) {
  test(`exported-shape weave verifies rom.checks (${romMatches ? "matching" : "wrong"} ROM)`, async () => {
    const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
    const checks = romMatches
      ? RAW_ROM_CHECKS
      : { checksums: { crc32: "a1cecd74", sha1: "96ff406466d366276a84a48947ae14cac4065e1c" }, size: 14 };
    const weaveArchive = await buildWeaveArchive(
      {
        output: { name: "exported-output" },
        patchBasis: "auto",
        patches: [{ name: "Core", path: patchFile.name, target: { rom: true } }],
        rom: { checks, name: "game.bin" },
        version: 2,
      },
      [patchFile],
    );
    await expectStrictApply([weaveArchive, romFile], { outputName: "exported-output", romMatches });
  });
}

// `weave create --output weave.json` records the input ROM as `rom.path`; zipping that JSON by hand leaves the
// path unbundled. Like `rom.name`, it means the user supplies the ROM (the CLI accepts it too).
for (const romMatches of [true, false]) {
  test(`weave zip with an unbundled rom.path verifies rom.checks (${romMatches ? "matching" : "wrong"} ROM)`, async () => {
    const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
    const checks = romMatches
      ? RAW_ROM_CHECKS
      : { checksums: { crc32: "a1cecd74", sha1: "96ff406466d366276a84a48947ae14cac4065e1c" }, size: 14 };
    const weaveArchive = await buildWeaveArchive(
      {
        output: { name: "unbundled-path-output" },
        patchBasis: "auto",
        patches: [{ name: "Core", path: patchFile.name, target: { rom: true } }],
        rom: { checks, path: "not-in-the-zip/game.bin" },
        version: 2,
      },
      [patchFile],
    );
    await expectStrictApply([weaveArchive, romFile], { outputName: "unbundled-path-output", romMatches });
  });
}

// An unbundled rom.path whose rom.checks match a bundled member under another name binds that member
// (resolved by the Rust `weave parse`), so the weave loads without a separate ROM file.
test("weave zip with an unbundled rom.path binds the bundled member whose checksums match", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const bundledRom = new File([await romFile.arrayBuffer()], "bundled-renamed.bin");
  const weaveArchive = await buildWeaveArchive(
    {
      output: { name: "bound-by-checks-output" },
      patchBasis: "auto",
      patches: [{ name: "Core", path: patchFile.name, target: { rom: true } }],
      rom: { checks: RAW_ROM_CHECKS, path: "not-in-the-zip/game.bin" },
      version: 2,
    },
    [patchFile, bundledRom],
  );
  await expectStrictApply([weaveArchive], { outputName: "bound-by-checks-output", romMatches: true });
});

test("weave zip whose patch path matches no member still fails to load", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const weaveArchive = await buildWeaveArchive(
    {
      output: { name: "missing-patch-output" },
      patches: [{ name: "Core", path: "missing.ips" }],
      rom: { checks: RAW_ROM_CHECKS, name: "game.bin" },
      version: 1,
    },
    [patchFile],
  );
  await expect(loadLocalWeaveSession(weaveArchive, [romFile])).rejects.toThrow(/matches no archive member/);
});

// `weave create --checksum sha256` writes algorithms staging does not compute; they are hashed on demand.
for (const romMatches of [true, false]) {
  test(`sha256-only rom.checks are computed and verified (${romMatches ? "matching" : "wrong"} ROM)`, async () => {
    const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
    const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", await romFile.arrayBuffer())));
    const weaveArchive = await buildWeaveArchive(
      {
        output: { name: "sha256-output" },
        patchBasis: "auto",
        patches: [{ name: "Core", path: patchFile.name }],
        rom: { checks: { checksums: { sha256: romMatches ? sha256 : "0".repeat(64) } }, name: "game.bin" },
        version: 2,
      },
      [patchFile],
    );
    await expectStrictApply([weaveArchive, romFile], { outputName: "sha256-output", romMatches });
  });
}

// A patch's own SHA-256 inputChecks must not read as malformed, and a wrong ROM keeps the override.
for (const romMatches of [true, false]) {
  test(`sha256 patch inputChecks are verified (${romMatches ? "matching" : "wrong"} ROM)`, async () => {
    const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
    const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", await romFile.arrayBuffer())));
    const weaveArchive = await buildWeaveArchive(
      {
        output: { name: "sha256-input-output" },
        patchBasis: "auto",
        patches: [
          {
            inputChecks: { checksums: { sha256: romMatches ? sha256 : "0".repeat(64) } },
            name: "Core",
            path: patchFile.name,
            target: { rom: true },
          },
        ],
        rom: { name: "game.bin" },
        version: 2,
      },
      [patchFile],
    );
    await expectStrictApply([weaveArchive, romFile], { outputName: "sha256-input-output", romMatches });
    expect(document.body.textContent).not.toContain("is malformed");
  });
}

// A member-lane weave: rom.member names the disc track the weave's ROM checks describe.
for (const romMatches of [true, false]) {
  test(`member-lane weave verifies rom.checks on rom.member (${romMatches ? "matching" : "wrong"} ROM)`, async () => {
    const trackOneName = "member-lane-track01.bin";
    const trackTwoName = "member-lane-track02.bin";
    const trackOne = noiseBytes(2352 * 40, 0x01);
    const trackTwo = noiseBytes(2352 * 40, 0x02);
    const cue = new File(
      [
        `FILE "${trackOneName}" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n` +
          `FILE "${trackTwoName}" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n`,
      ],
      "member-lane.cue",
      { type: "application/x-cue" },
    );
    const patchFile = new File([createIps([[0, 0xd4]])], "track.ips");
    const target = { member: trackTwoName, rom: true };
    // The weave bundles the disc as one ROM archive. The wrong case declares track 1's checks for
    // track 2, as a weave made from another disc would.
    const disc = await buildZip(
      [
        { file: cue, fileName: cue.name },
        { file: new File([trackOne], trackOneName), fileName: trackOneName },
        { file: new File([trackTwo], trackTwoName), fileName: trackTwoName },
      ],
      "member-lane.zip",
    );
    const weaveArchive = await buildWeaveArchive(
      {
        output: { name: "member-lane-output" },
        patchBasis: "auto",
        patches: [{ name: "Track", path: patchFile.name, target }],
        rom: {
          checks: await fileChecks(romMatches ? trackTwo : trackOne),
          member: trackTwoName,
          name: disc.name,
          path: disc.name,
        },
        version: 2,
      },
      [patchFile, disc],
    );
    await expectStrictApply([weaveArchive], { outputName: "member-lane-output", romMatches });
  });
}

// A member-lane weave given only the extracted ROM member, not the archive it came from.
for (const romMatches of [true, false]) {
  test(`member-lane weave verifies rom.checks on the bare member file (${romMatches ? "matching" : "wrong"} ROM)`, async () => {
    const memberName = "bare-member-track02.bin";
    const member = noiseBytes(2352 * 40, 0x02);
    const patchFile = new File([createIps([[0, 0xd4]])], "track.ips");
    const weaveArchive = await buildWeaveArchive(
      {
        output: { name: "bare-member-output" },
        patchBasis: "auto",
        // `weave create --rom-member` names the member on rom only; its patches carry no target.
        patches: [{ name: "Track", path: patchFile.name }],
        rom: {
          checks: await fileChecks(romMatches ? member : noiseBytes(member.length, 0x01)),
          member: memberName,
          name: "bare-member.zip",
        },
        version: 2,
      },
      [patchFile],
    );
    await expectStrictApply([weaveArchive, new File([member], memberName)], {
      outputName: "bare-member-output",
      romMatches,
    });
  });
}

// A checks-only weave and the user's ROM archive arrive in ONE drop: the archive is a ROM candidate
// and the weave's rom.member is extracted from it, exactly as when it is dropped second.
test("single drop of a checks-only weave and a cartridge ROM zip stages the ROM", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const romZip = await buildZip([{ file: romFile, fileName: "game.bin" }], "rom.zip");
  const weaveArchive = await buildWeaveArchive(
    {
      output: { name: "single-drop-output" },
      patchBasis: "auto",
      patches: [{ name: "Core", path: patchFile.name, target: { rom: true } }],
      rom: { checks: RAW_ROM_CHECKS, member: "game.bin", name: "rom.zip" },
      version: 2,
    },
    [patchFile],
  );
  await expectStrictApply([weaveArchive, romZip], { outputName: "single-drop-output", romMatches: true });
});

test("single drop of a checks-only weave and a cue/bin ROM zip stages the disc", async () => {
  const trackOneName = "single-drop-track01.bin";
  const trackTwoName = "single-drop-track02.bin";
  const trackOne = noiseBytes(2352 * 40, 0x01);
  const trackTwo = noiseBytes(2352 * 40, 0x02);
  const cue = new File(
    [
      `FILE "${trackOneName}" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n` +
        `FILE "${trackTwoName}" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n`,
    ],
    "single-drop.cue",
    { type: "application/x-cue" },
  );
  const patchFile = new File([createIps([[0, 0xd4]])], "track.ips");
  const discZip = await buildZip(
    [
      { file: cue, fileName: cue.name },
      { file: new File([trackOne], trackOneName), fileName: trackOneName },
      { file: new File([trackTwo], trackTwoName), fileName: trackTwoName },
    ],
    "disc.zip",
  );
  const weaveArchive = await buildWeaveArchive(
    {
      output: { name: "single-drop-disc-output" },
      patchBasis: "auto",
      patches: [{ name: "Track", path: patchFile.name, target: { member: trackTwoName, rom: true } }],
      rom: { checks: await fileChecks(trackTwo), member: trackTwoName, name: "disc.zip" },
      version: 2,
    },
    [patchFile],
  );
  await expectStrictApply([weaveArchive, discZip], { outputName: "single-drop-disc-output", romMatches: true });
});

// rom.checks recorded from the headerless or big-endian ROM still accept the user's headered or
// byte-swapped dump, and the patch still lands on the bytes it targets.
test("weave rom.checks of a headerless SNES ROM accept the headered dump", async () => {
  const headerless = withBytes(noiseBytes(1024 * 1024, 0x5eed), 0x7fc0, SNES_INTERNAL_HEADER);
  const headered = new Uint8Array(512 + headerless.length);
  headered.set(headerless, 512);
  const records = [
    [0x100, 0xf2],
    [0x8000, 0x09],
  ];
  const weaveArchive = await buildTransformWeave(
    await fileChecks(headerless),
    "hack.ips",
    createIps(records),
    "game.sfc",
  );
  const { output } = await applyWeaveAndReadOutput([weaveArchive, new File([headered], "game.smc")]);
  const modified = applyRecords(headerless, records);
  expect(hex(output.subarray(output.length - modified.length))).toBe(hex(modified));
});

test("weave rom.checks of a big-endian N64 ROM accept the byte-swapped dump", async () => {
  const bigEndian = withBytes(noiseBytes(1024 * 1024, 0x64), 0, [0x80, 0x37, 0x12, 0x40]);
  const modified = withBytes(bigEndian, 0x1000, [0xde, 0xad, 0xbe, 0xef]);
  const weaveArchive = await buildTransformWeave(
    await fileChecks(bigEndian),
    "hack.bps",
    createBps(bigEndian, modified),
    "game.z64",
  );
  const { output } = await applyWeaveAndReadOutput([weaveArchive, new File([byteSwap16(bigEndian)], "game.v64")]);
  const normalized = output[0] === 0x37 && output[1] === 0x80 ? byteSwap16(output) : output;
  expect(hex(normalized)).toBe(hex(modified));
});

test("sha256-only rom.checks of a headerless NES ROM accept the headered dump", async () => {
  const headered = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
  const body = headered.subarray(16);
  const records = [
    [0x98, 0x12],
    [0x99, 0x0f],
  ];
  const weaveArchive = await buildTransformWeave(
    await sha256Checks(body),
    "hack.ips",
    createIps(records),
    "hello-world.nes",
  );
  const { result, sha256Hashes } = await withSha256HashCount(() =>
    applyWeaveAndReadOutput([weaveArchive, new File([headered], "hello-world.nes")]),
  );
  const modified = applyRecords(body, records);
  expect(hex(result.output.subarray(result.output.length - modified.length))).toBe(hex(modified));
  expect(sha256Hashes).toBe(1);
});

test("sha256-only rom.checks of a headerless SNES ROM accept the headered dump", async () => {
  const headerless = withBytes(noiseBytes(1024 * 1024, 0x5eed), 0x7fc0, SNES_INTERNAL_HEADER);
  const headered = new Uint8Array(512 + headerless.length);
  headered.set(headerless, 512);
  const records = [
    [0x100, 0xf2],
    [0x8000, 0x09],
  ];
  const weaveArchive = await buildTransformWeave(
    await sha256Checks(headerless),
    "hack.ips",
    createIps(records),
    "game.sfc",
  );
  const { result, sha256Hashes } = await withSha256HashCount(() =>
    applyWeaveAndReadOutput([weaveArchive, new File([headered], "game.smc")]),
  );
  const modified = applyRecords(headerless, records);
  expect(hex(result.output.subarray(result.output.length - modified.length))).toBe(hex(modified));
  expect(sha256Hashes).toBe(1);
});

test("sha256-only rom.checks of a big-endian N64 ROM accept the byte-swapped dump", async () => {
  const bigEndian = withBytes(noiseBytes(1024 * 1024, 0x64), 0, [0x80, 0x37, 0x12, 0x40]);
  const modified = withBytes(bigEndian, 0x1000, [0xde, 0xad, 0xbe, 0xef]);
  const weaveArchive = await buildTransformWeave(
    await sha256Checks(bigEndian),
    "hack.bps",
    createBps(bigEndian, modified),
    "game.z64",
  );
  const { result, sha256Hashes } = await withSha256HashCount(() =>
    applyWeaveAndReadOutput([weaveArchive, new File([byteSwap16(bigEndian)], "game.v64")]),
  );
  const normalized = result.output[0] === 0x37 && result.output[1] === 0x80 ? byteSwap16(result.output) : result.output;
  expect(hex(normalized)).toBe(hex(modified));
  // The same-size raw file is hashed on demand first; that pass already hashes its variants.
  expect(sha256Hashes).toBe(1);
});

test("sha256-only rom.checks still reject the headered dump of a different ROM", async () => {
  const headered = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
  const otherBody = withBytes(headered.subarray(16), 0x98, [0xff]);
  const weaveArchive = await buildTransformWeave(
    await sha256Checks(otherBody),
    "hack.ips",
    createIps([[0x99, 0x0f]]),
    "hello-world.nes",
  );
  await expectStrictApply([weaveArchive, new File([headered], "hello-world.nes")], {
    outputName: "transform-output",
    romMatches: false,
  });
});
