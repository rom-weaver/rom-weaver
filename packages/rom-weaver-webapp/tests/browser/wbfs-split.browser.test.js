import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import {
  resetRomWeaverRunner,
  runRomWeaverJson,
  warmupRomWeaverRunner,
} from "../../src/workers/rom-weaver/rom-weaver-runner.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../src/workers/shared/worker-storage/storage-layout.ts";

const BLOCK_SIZE = 0x200000;
const SECTOR_SIZE = 0x200;
// Wii double-layer sector count >> (block shift - 15), as the WBFS reader computes it.
const MAX_BLOCKS = (143432 * 2) >> (21 - 15);
const NKIT_HEADER_OFFSET = 0x10000;

const gamecubeIso = () => {
  const iso = new Uint8Array(0x20440);
  iso.set(new TextEncoder().encode("RWTEST"));
  iso.set([0xc2, 0x33, 0x9f, 0x3d], 0x1c);
  iso.set(new TextEncoder().encode("rom-weaver-test"), 0x20);
  for (let index = 0x440; index < iso.length; index++) iso[index] = (index - 0x440) % 251;
  return iso;
};

/**
 * Builds a single-disc WBFS with the layout nod writes: header, disc table, disc header copy,
 * and block map in block 0, an NKit v2 header recording the ISO size, then one 2 MiB data block.
 */
const wbfsFromIso = (iso, { extraDisc = false } = {}) => {
  const wbfs = new Uint8Array(BLOCK_SIZE * 2);
  const view = new DataView(wbfs.buffer);
  wbfs.set(new TextEncoder().encode("WBFS"));
  view.setUint32(4, wbfs.length / SECTOR_SIZE);
  wbfs.set([9, 21, 1], 8);
  wbfs[12] = 1;
  // Disc table entry 1: a multi-game drive image.
  if (extraDisc) wbfs[13] = 1;
  wbfs.set(iso.subarray(0, 0x100), SECTOR_SIZE);
  view.setUint16(SECTOR_SIZE + 0x100, 1);
  expect(SECTOR_SIZE + 0x100 + MAX_BLOCKS * 2).toBeLessThan(NKIT_HEADER_OFFSET);
  wbfs.set(new TextEncoder().encode("NKIT  v2"), NKIT_HEADER_OFFSET);
  view.setUint16(NKIT_HEADER_OFFSET + 8, 20);
  view.setUint16(NKIT_HEADER_OFFSET + 10, 1);
  view.setBigUint64(NKIT_HEADER_OFFSET + 12, BigInt(iso.length));
  wbfs.set(iso, BLOCK_SIZE);
  return wbfs;
};

const splitParts = (wbfs, parts) => {
  const chunk = Math.ceil(wbfs.length / parts);
  return Array.from(
    { length: parts },
    (_, index) =>
      new File([wbfs.subarray(index * chunk, (index + 1) * chunk)], index === 0 ? "Disc.wbfs" : `Disc.wbf${index}`),
  );
};

const extractAll = async (source, companionFiles) => {
  const extract = browserRuntime.compression.extract;
  if (!extract) throw new Error("Runtime compression extract capability is unavailable");
  return extract({ companionFiles, entries: [], extractAll: true, options: { threads: 1 }, source });
};

test("WASM extracts a split WBFS set byte for byte and rejects a set with a missing part", async () => {
  await resetRomWeaverRunner();
  try {
    await warmupRomWeaverRunner();
    const iso = gamecubeIso();
    const [source, ...parts] = splitParts(wbfsFromIso(iso), 3);
    const probe = await browserRuntime.compression.probe?.({ companionFiles: parts, options: { threads: 1 }, source });
    expect(probe?.platform).toBe("Nintendo GameCube");
    expect(probe?.entries.map((entry) => entry.filename)).toEqual(["Disc.iso"]);
    const result = await extractAll(source, parts);
    try {
      expect(result.outputs.map((output) => output.fileName)).toEqual(["Disc.iso"]);
      const blob = await browserRuntime.publicOutput.getBlob(result.outputs[0]);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(iso);
    } finally {
      await Promise.all(result.outputs.map((output) => output.dispose()));
    }
    await expect(extractAll(source, parts.slice(0, 1))).rejects.toThrow(
      /Invalid WBFS file size.*\[wbfs\.size_mismatch\] \(actual=\d+, expected=\d+\)/i,
    );
  } finally {
    await resetRomWeaverRunner();
  }
});

test("WASM refuses a multi-disc WBFS with the single-disc error instead of extracting the first game", async () => {
  await resetRomWeaverRunner();
  try {
    await warmupRomWeaverRunner();
    const source = new File([wbfsFromIso(gamecubeIso(), { extraDisc: true })], "Multi.wbfs");
    const error = await extractAll(source, []).then(
      () => null,
      (cause) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("Only single WBFS discs are supported");
    // The size-mismatch advice in the extract form is for split sets; a multi-disc image must not get it.
    expect(error.message).not.toContain("[wbfs.size_mismatch]");
  } finally {
    await resetRomWeaverRunner();
  }
});

test("WASM compresses a WBFS to RVZ that extracts to the original disc image", async () => {
  await resetRomWeaverRunner();
  const outputs = [];
  try {
    await warmupRomWeaverRunner();
    const iso = gamecubeIso();
    const { create, extract } = browserRuntime.compression;
    if (!(create && extract)) throw new Error("Runtime compression capabilities are unavailable");
    const rvz = await create({
      fileName: "Disc.wbfs",
      format: "rvz",
      options: { threads: 1 },
      outputName: "Disc.rvz",
      source: new File([wbfsFromIso(iso)], "Disc.wbfs"),
    });
    outputs.push(rvz.output);
    const extracted = await extract({
      entries: [],
      extractAll: true,
      format: "rvz",
      options: { threads: 1 },
      source: rvz.output,
    });
    outputs.push(...extracted.outputs);
    const blob = await browserRuntime.publicOutput.getBlob(extracted.outputs[0]);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(iso);
  } finally {
    await Promise.all(outputs.map((output) => output.dispose()));
    await resetRomWeaverRunner();
  }
});

const outputBytes = async (output) =>
  new Uint8Array(await (await browserRuntime.publicOutput.getBlob(output)).arrayBuffer());

const stagedPaths = async (runId, files) => {
  const paths = [];
  for (const file of files) {
    const path = `${WORKER_OPFS_MOUNTPOINT}/wbfs-${runId}-${file.name}`;
    await browserRuntime.vfs.truncate(path, 0);
    await browserRuntime.vfs.write(path, new Uint8Array(await file.arrayBuffer()), { fileOffset: 0 });
    paths.push(path);
  }
  return paths;
};

const hex = (digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

for (const format of ["zip", "7z"]) {
  test(`WASM archives every part of a split WBFS to ${format}, refuses a partial set, and the archive still extracts to the ISO`, async () => {
    await resetRomWeaverRunner();
    const outputs = [];
    try {
      await warmupRomWeaverRunner();
      const iso = gamecubeIso();
      const files = splitParts(wbfsFromIso(iso), 3);
      const { create, extract } = browserRuntime.compression;
      if (!(create && extract)) throw new Error("Runtime compression capabilities are unavailable");
      const entryOf = (file) => ({ file, fileName: file.name });
      // Like the CLI, a partial set is refused rather than archived with parts silently left out.
      for (const partial of [files.slice(0, 1), files.slice(0, 2)]) {
        await expect(
          create({
            entries: partial.map(entryOf),
            format,
            options: { outputName: `Partial.${format}`, threads: 1 },
          }),
        ).rejects.toThrow(/WBFS file, or the first part of a split WBFS set.*header declares/is);
      }
      const archive = await create({
        entries: files.map(entryOf),
        format,
        options: { outputName: `Disc.${format}`, threads: 1 },
      });
      outputs.push(archive.output);
      const unpacked = await extract({
        entries: [],
        extractAll: true,
        format,
        options: { threads: 1 },
        source: archive.output,
      });
      outputs.push(...unpacked.outputs);
      // Extracting the archive descends into the complete WBFS set it holds: the ISO is written and the
      // continuation parts are left as stored files.
      const byName = new Map(unpacked.outputs.map((output) => [output.fileName, output]));
      expect([...byName.keys()].sort()).toEqual(["Disc.iso", "Disc.wbf1", "Disc.wbf2"]);
      expect(await outputBytes(byName.get("Disc.iso"))).toEqual(iso);
      for (const file of files.slice(1)) {
        expect(await outputBytes(byName.get(file.name))).toEqual(new Uint8Array(await file.arrayBuffer()));
      }
    } finally {
      await Promise.all(outputs.map((output) => output.dispose().catch(() => undefined)));
      await resetRomWeaverRunner();
    }
  });
}

test("WASM archives a split WBFS whose parts differ in extension case", async () => {
  await resetRomWeaverRunner();
  const outputs = [];
  try {
    await warmupRomWeaverRunner();
    const parts = splitParts(wbfsFromIso(gamecubeIso()), 3);
    // The extract path accepts this mix of cases for one set, so create must too.
    const names = ["Disc.WBFS", "disc.wbf1", "Disc.WBF2"];
    const entries = parts.map((part, index) => ({
      file: new File([part], names[index]),
      fileName: names[index],
    }));
    const archive = await browserRuntime.compression.create({
      entries,
      format: "zip",
      options: { outputName: "Mixed.zip", threads: 1 },
    });
    outputs.push(archive.output);
    expect(archive.output.fileName).toBe("Mixed.zip");
  } finally {
    await Promise.all(outputs.map((output) => output.dispose().catch(() => undefined)));
    await resetRomWeaverRunner();
  }
});

test("WASM checksums a split WBFS to the extracted ISO's hashes and probes its game ID and title", async () => {
  await resetRomWeaverRunner();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const paths = [];
  try {
    await warmupRomWeaverRunner();
    const iso = gamecubeIso();
    const files = splitParts(wbfsFromIso(iso), 3);
    paths.push(...(await stagedPaths(runId, files)));
    const isoPath = `${WORKER_OPFS_MOUNTPOINT}/wbfs-${runId}-raw.iso`;
    paths.push(...(await stagedPaths(runId, [new File([iso], "raw.iso")])));

    const checksum = async (input) => {
      const result = await runRomWeaverJson(
        { args: { algo: ["crc32", "md5", "sha1"], input }, type: "checksum" },
        { knownInputPaths: paths },
      );
      expect(result.exitCode, JSON.stringify(result.events?.at(-1))).toBe(0);
      return result.events.at(-1)?.details;
    };
    const fromWbfs = await checksum(paths[0]);
    const fromIso = await checksum(isoPath);
    expect(JSON.stringify(fromWbfs)).toContain(hex(await crypto.subtle.digest("SHA-1", iso)));
    expect(fromWbfs.checksums ?? fromWbfs).toEqual(fromIso.checksums ?? fromIso);

    const probe = await runRomWeaverJson(
      { args: { input: paths[0], no_extract: true }, type: "probe" },
      { knownInputPaths: paths },
    );
    expect(probe.exitCode).toBe(0);
    const details = probe.events.at(-1)?.details;
    expect(details.platform).toBe("Nintendo GameCube");
    expect(details.game_id).toBe("RWTEST");
    expect(details.title).toBe("rom-weaver-test");
    expect(
      details.container.entries.map((entry) =>
        entry
          .split("/")
          .pop()
          .replace(/^wbfs-[^-]+-[^-]+-/, ""),
      ),
    ).toEqual(["Disc.iso"]);
    expect(details.container.recommended_compress_format).toBe("rvz");
  } finally {
    await Promise.all(paths.map((path) => browserRuntime.vfs.remove(path).catch(() => undefined)));
    await resetRomWeaverRunner();
  }
});

const varint = (value) => {
  const bytes = [];
  let rest = value;
  do {
    const low = rest & 0x7f;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? low | 0x80 : low);
  } while (rest > 0);
  return bytes;
};

const hexBytes = (text) =>
  Array.from({ length: text.length / 2 }, (_, i) => Number.parseInt(text.slice(i * 2, i * 2 + 2), 16));

/** A one-game RWFP1 identify pack naming a disc by size, CRC32, MD5 and SHA-1 (layout of identify_pack_v1.rs). */
const identifyPackForDisc = (name, size, crc32, md5, sha1) => {
  const encoder = new TextEncoder();
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  const u32 = (value) => new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
  const u64 = (value) => new Uint8Array([...u32(value), 0, 0, 0, 0]);
  const nameBytes = encoder.encode(name);
  const scope = encoder.encode("full_file");
  const members = [
    [
      "strings.bin",
      concat(
        encoder.encode("RWS5"),
        new Uint8Array([1, 2, nameBytes.length]),
        nameBytes,
        new Uint8Array([scope.length]),
        scope,
      ),
    ],
    [
      "hashes.bin",
      concat(
        encoder.encode("RWH5"),
        new Uint8Array([1, 1, ...varint(size), 0, 7, ...hexBytes(crc32), ...hexBytes(md5), ...hexBytes(sha1)]),
      ),
    ],
    ["components.bin", concat(encoder.encode("RWC5"), new Uint8Array([1, 1, 0, 0, 0, 3]))],
    ["games.bin", concat(encoder.encode("RWG5"), new Uint8Array([1, 1, 0, 0, 1, 0, 0]))],
    ["owners.bin", concat(encoder.encode("RWO5"), new Uint8Array([1, 1, 1, 0]))],
    ["routes.bin", concat(encoder.encode("RWR5"), new Uint8Array([1, 1, 0]))],
    ["sets.bin", concat(encoder.encode("RWX5"), new Uint8Array([1, 1, 0, 1, 0]))],
    [
      "manifest.json",
      encoder.encode(
        '{"format":"rom-weaver-identify-system-pack-v1","platform":"Nintendo GameCube","source":"libretro","canonicalizationProfile":"full_file","canonicalizationVersion":1,"provenance":[]}',
      ),
    ],
  ];
  const directory = members.map(([member, bytes]) =>
    concat(new Uint8Array([member.length & 255, member.length >>> 8]), u64(bytes.length), encoder.encode(member)),
  );
  return concat(encoder.encode("RWFP1\0\0\0"), u32(members.length), ...directory, ...members.map(([, bytes]) => bytes));
};

test("WASM identifies a split WBFS by the extracted ISO's hash, matching the same pack entry as the ISO", async () => {
  await resetRomWeaverRunner();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const paths = [];
  try {
    await warmupRomWeaverRunner();
    const iso = gamecubeIso();
    const files = splitParts(wbfsFromIso(iso), 3);
    paths.push(...(await stagedPaths(runId, files)));
    const isoPath = (await stagedPaths(runId, [new File([iso], "raw.iso")]))[0];
    paths.push(isoPath);

    const checksum = await runRomWeaverJson(
      { args: { algo: ["crc32", "md5", "sha1"], input: isoPath }, type: "checksum" },
      { knownInputPaths: paths },
    );
    expect(checksum.exitCode).toBe(0);
    const digests = checksum.events.at(-1)?.details;
    const find = (algorithm) => String(digests.checksums[algorithm]).toLowerCase();
    const pack = `${WORKER_OPFS_MOUNTPOINT}/wbfs-${runId}-test.pack`;
    await browserRuntime.vfs.truncate(pack, 0);
    await browserRuntime.vfs.write(
      pack,
      identifyPackForDisc("RW Test Disc", iso.length, find("crc32"), find("md5"), find("sha1")),
      { fileOffset: 0 },
    );
    paths.push(pack);

    const identify = async (input) => {
      const result = await runRomWeaverJson(
        { args: { database: [pack], input }, type: "identify" },
        { knownInputPaths: paths },
      );
      expect(result.exitCode, JSON.stringify(result.events?.at(-1))).toBe(0);
      return result.events.at(-1)?.details?.identify;
    };
    const fromIso = await identify(isoPath);
    expect(fromIso.status).toBe("matched");
    expect(fromIso.matches.map((match) => match.name)).toEqual(["RW Test Disc"]);
    const fromWbfs = await identify(paths[0]);
    expect(fromWbfs.status).toBe("matched");
    expect(fromWbfs.matches.map((match) => match.name)).toEqual(["RW Test Disc"]);
  } finally {
    await Promise.all(paths.map((path) => browserRuntime.vfs.remove(path).catch(() => undefined)));
    await resetRomWeaverRunner();
  }
});
