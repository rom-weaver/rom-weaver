// Every fixture of the apply matrix. See fixtures.mjs for the repo/cache/ext split.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as E from "./encoders.mjs";
import { runBspReference } from "./bsp-reference.mjs";

const ROM_SIZE = 0xa000; // > 0x9720 so PPF blockcheck (0x9320 + 1024) has data to validate
export const PATCH_FORMATS_WITH_CREATE = [
  "ips", "ips32", "solid", "bps", "ups", "vcdiff", "xdelta", "gdiff", "aps", "apsgba", "rup", "ppf", "pat", "ebp", "bdf", "dps", "mod",
];

const prng = (seed) => {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 0xff;
  };
};
const randomBytes = (length, seed) => {
  const next = prng(seed);
  return Uint8Array.from({ length }, next);
};

export const baseRom = () => randomBytes(ROM_SIZE, 0x524f4d21);
const withEdits = (rom) => {
  const target = rom.slice();
  for (let at = 0x10; at < 0x20; at++) target[at] ^= 0x55;
  const next = prng(0x1234567);
  for (let at = 0x1000; at < 0x1100; at++) target[at] = next();
  target.fill(0, 0x4000, 0x4258); // 600-byte zero run: RLE-friendly
  target[ROM_SIZE - 1] ^= 1;
  return target;
};
export const sameRom = () => withEdits(baseRom());
export const growRom = () => {
  const same = sameRom();
  const out = new Uint8Array(ROM_SIZE + 300);
  out.set(same);
  out.set(randomBytes(300, 0xfeed), ROM_SIZE);
  return out;
};
export const shrinkRom = () => sameRom().slice(0, ROM_SIZE - 1000);
export const rleRom = () => {
  const out = baseRom();
  out.fill(0xaa, 0x2000, 0x2000 + 200);
  return out;
};

const swapPairs = (bytes) => {
  const out = bytes.slice();
  for (let at = 0; at + 1 < out.length; at += 2) [out[at], out[at + 1]] = [bytes[at + 1], bytes[at]];
  return out;
};
const swapWords = (bytes) => {
  const out = bytes.slice();
  for (let at = 0; at + 3 < out.length; at += 4) {
    out[at] = bytes[at + 3];
    out[at + 1] = bytes[at + 2];
    out[at + 2] = bytes[at + 1];
    out[at + 3] = bytes[at];
  }
  return out;
};

const hex = (text) => Uint8Array.from(text.match(/../g).map((pair) => Number.parseInt(pair, 16)));

export const BSP_VECTORS = [
  // [name, patch hex, input hex]  (vectors from crates/rom-weaver-patches/tests/unit/bsp.rs);
  // expected output comes from the vendored upstream bsppatch.js runtime (lib/bsp-reference.mjs).
  ["noop-exit", "0600000000", "010203"],
  ["writebyte-seek", "600100000018ff0600000000", "010203"],
  ["fillbyte-seekend", "66000000007002000000aa0600000000", "010203"],
  ["writedata-label", "60000000007c1300000004000000060000000010203040", "00000000"],
  ["xordata-mask", "60000000006c13000000030000000600000000ff0ff0", "102030"],
  ["lock-unlock-truncate", "60010000008018aa620100000018bb8118cc820600000000", "0102030405"],
  ["conditional-ifeq", "840005000000500005000000150000000602000000600000000018770600000000", "010203"],
  ["call-return", "040a00000006000000006000000000185501", "010203"],
  ["stack-push-pop", "081200000008340000000a000a015000340000001d00000006030000005001120000002c0000000604000000600000000018990600000000", "010203"],
  ["bsppatch-nested", "600000000018aa9400160000000c0000000600000000600200000018bb0600000000", "00000000"],
];
// Vectors whose reference outcome is a script failure (nonzero exit) rather than output.
export const BSP_FAILURE_VECTORS = [["nonzero-exit", "0601000000", "010203"]];
export const BSP_MENU_HEX =
  "60000000006a00400000005400000000001c000000184106000000001842060000000000000000000000000000000000000000000000000000000000000000005000000052000000ffffffff0000000041004200";

/** Fixtures that depend on system tools. Returns names of missing tools for skip messages. */
export const have = (cmd) => {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

export const defineAll = (fx) => {
  const repo = (name, purpose, how, build) => fx.define(name, { where: "repo", purpose, how, deterministic: true, build });
  const cache = (name, purpose, how, build, deterministic = false) => fx.define(name, { where: "cache", purpose, how, deterministic, build });

  // ---------------------------------------------------------------- ROM family
  repo("rom/base.bin", "40 KiB pseudo-random source ROM (xorshift32 seed 0x524f4d21)", "lib/fixture-defs.mjs baseRom()", () => baseRom());
  repo("rom/same.bin", "Same-size target: header bytes xored, random block, 600-byte zero run, last byte flipped", "withEdits(base)", () => sameRom());
  repo("rom/grow.bin", "Target = same.bin plus 300 random trailing bytes", "growRom()", () => growRom());
  repo("rom/shrink.bin", "Target = same.bin truncated by 1000 bytes", "shrinkRom()", () => shrinkRom());
  repo("rom/rle.bin", "Target = base with 200 bytes of 0xAA at 0x2000 (RLE record carrier)", "rleRom()", () => rleRom());
  repo("rom/wrong.bin", "base.bin with byte 100 flipped: wrong-source input", "base[100]^=0xff", () => {
    const rom = baseRom();
    rom[100] ^= 0xff;
    return rom;
  });
  repo("rom/wrong-size.bin", "base.bin plus 16 trailing bytes: wrong-size input", "base + 16 bytes", () => E.concat(baseRom(), new Uint8Array(16).fill(7)));

  // -------------------------------------------- independent encoders (byte-deterministic)
  const base = () => fx.bytes("rom/base.bin");
  const target = (name) => fx.bytes(`rom/${name}.bin`);
  const ind = (name, purpose, build) => repo(`patches/ind/${name}`, purpose, "independent encoder in lib/encoders.mjs", build);
  for (const kind of ["same", "grow", "shrink"]) {
    ind(`${kind}.ips`, `IPS ${kind}`, () => E.encodeIps(base(), target(kind)));
    ind(`${kind}.bps`, `BPS ${kind}`, () => E.encodeBps(base(), target(kind)));
    ind(`${kind}.ups`, `UPS ${kind}`, () => E.encodeUps(base(), target(kind)));
    ind(`${kind}.gdiff`, `GDIFF ${kind}`, () => E.encodeGdiff(base(), target(kind)));
    ind(`${kind}.vcdiff`, `VCDIFF ${kind} (no adler)`, () => E.encodeVcdiff(base(), target(kind)));
  }
  for (const kind of ["same", "grow"]) {
    ind(`${kind}.ips32`, `IPS32 ${kind}`, () => E.encodeIps32(base(), target(kind)));
    ind(`${kind}.ppf`, `PPF3 ${kind}`, () => E.encodePpf3(base(), target(kind)));
  }
  ind("rle.ips", "IPS with an RLE record (200 x 0xAA at 0x2000)", () => E.encodeIps(base(), target("rle"), { rle: [[0x2000, 200, 0xaa]] }));
  ind("same.noeof.ips", "IPS lacking the EOF marker (tolerance probe)", () => E.encodeIps(base(), target("same")).slice(0, -3));
  ind("meta.bps", "BPS with metadata string", () => E.encodeBps(base(), target("grow"), { metadata: "<bps-metadata>hello</bps-metadata>" }));
  ind("targetcopy.bps", "BPS using TargetCopy actions", () => E.encodeBps(base(), target("same"), { useTargetCopy: true }));
  ind("v1.ppf", "PPF 1.0", () => E.encodePpf1(base(), target("same")));
  ind("v2.ppf", "PPF 2.0 with size + 1 KiB block check", () => E.encodePpf2(base(), target("same")));
  ind("v3-blockcheck.ppf", "PPF 3.0 with block check", () => E.encodePpf3(base(), target("same"), { blockCheck: true }));
  ind("v3-undo.ppf", "PPF 3.0 with undo data", () => E.encodePpf3(base(), target("same"), { undo: true }));
  ind("same.aps", "APS (N64) simple records", () => E.encodeApsN64(base(), target("same")));
  ind("rle.aps", "APS (N64) with an RLE record", () => E.encodeApsN64(base(), target("rle"), { rle: [[0x2000, 200, 0xaa]] }));
  ind("adler.vcdiff", "VCDIFF with xdelta3 Adler-32 window checksum", () => E.encodeVcdiff(base(), target("same"), { adler: true }));
  ind("norun.vcdiff", "VCDIFF without RUN instructions", () => E.encodeVcdiff(base(), target("same"), { runs: false }));

  // BSP / misc hand-written vectors
  for (const [name, patchHex, inputHex] of [...BSP_VECTORS, ...BSP_FAILURE_VECTORS]) {
    repo(`patches/bsp/${name}.bsp`, `BSP script vector ${name}`, "hex from crates/rom-weaver-patches/tests/unit/bsp.rs", () => hex(patchHex));
    repo(`patches/bsp/${name}.in`, `BSP vector input ${name}`, "hex", () => hex(inputHex));
  }
  for (const [name, patchHex, inputHex] of BSP_VECTORS) {
    repo(`patches/bsp/${name}.out`, `BSP vector expected output ${name}`, "upstream bsppatch.js oracle (lib/bsp-reference.mjs)", () => {
      const outcome = runBspReference(fx.root, hex(patchHex), hex(inputHex));
      if (outcome.state !== "ok") throw new Error(`BSP oracle did not succeed for ${name}: ${JSON.stringify(outcome)}`);
      return outcome.out;
    });
  }
  repo("patches/bsp/menu.bsp", "BSP with a nonempty menu (interactive, unsupported)", "hex from tests/cli_smoke/patch.rs", () => hex(BSP_MENU_HEX));
  repo("patches/ninja1.rnp", "NINJA1 header only: recognized but not applicable", "ascii header", () => E.concat(E.ascii("NINJA"), Uint8Array.of(0x32), new Uint8Array(64)));
  repo("patches/hdiff19.hdiff", "HDIFF19 directory-patch magic (unsupported)", "ascii header", () => E.concat(E.ascii("HDIFF19&"), new Uint8Array(64)));
  repo("patches/garbage.bin", "512 pseudo-random bytes: not a patch in any format", "xorshift", () => randomBytes(512, 0xbad));

  // --------------------------------------------- headered ROM family (SNES / NES / N64)
  const snesRom = () => randomBytes(0x8000, 0x534e4553);
  const snesTarget = () => {
    const out = snesRom();
    out[0x100] ^= 0xff;
    out[0x7ff0] ^= 0x0f;
    return out;
  };
  repo("hdr/snes.sfc", "32 KiB headerless SNES-sized ROM", "xorshift", () => snesRom());
  repo("hdr/snes-patched.sfc", "headerless SNES target", "snes.sfc with 2 bytes edited", () => snesTarget());
  repo("hdr/snes.smc", "snes.sfc behind a 512-byte zero copier header (len % 1024 == 512)", "512 zero bytes + snes.sfc", () => E.concat(new Uint8Array(512), snesRom()));
  repo("hdr/snes-patched.smc", "headered target (header kept)", "512 zero bytes + snes-patched.sfc", () => E.concat(new Uint8Array(512), snesTarget()));
  repo("hdr/snes.bps", "BPS made against the headerless ROM (carries crc32 proof)", "encodeBps", () => E.encodeBps(snesRom(), snesTarget()));
  repo("hdr/snes.ips", "IPS made against the headerless ROM (no proof)", "encodeIps", () => E.encodeIps(snesRom(), snesTarget()));
  repo("hdr/snes-hdr.bps", "BPS made against the headered ROM", "encodeBps", () => E.encodeBps(E.concat(new Uint8Array(512), snesRom()), E.concat(new Uint8Array(512), snesTarget())));

  const nesRom = () => E.concat(Uint8Array.of(0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), randomBytes(0x4000 + 0x2000, 0x4e4553));
  const nesTarget = () => {
    const out = nesRom();
    out[0x20] ^= 0xff;
    out[0x4010] ^= 0xff;
    return out;
  };
  repo("hdr/nes.nes", "iNES ROM, 16 KiB PRG + 8 KiB CHR", "synthetic", () => nesRom());
  repo("hdr/nes-patched.nes", "iNES target", "nes.nes edited", () => nesTarget());
  repo("hdr/nes.bps", "BPS against the whole iNES file", "encodeBps", () => E.encodeBps(nesRom(), nesTarget()));
  repo("hdr/nes-headerless.bps", "BPS against the iNES body without header", "encodeBps", () => E.encodeBps(nesRom().slice(16), nesTarget().slice(16)));

  const n64Z64 = () => {
    const out = randomBytes(0x10000, 0x4e363421);
    out.set([0x80, 0x37, 0x12, 0x40], 0); // z64 big-endian magic
    return out;
  };
  const n64Target = () => {
    const out = n64Z64();
    out[0x1000] ^= 0xff;
    out[0x2000] ^= 0xff;
    return out;
  };
  repo("hdr/n64.z64", "64 KiB N64 ROM, big-endian (.z64)", "synthetic", () => n64Z64());
  repo("hdr/n64.v64", "n64.z64 byte-swapped (.v64)", "swap pairs", () => swapPairs(n64Z64()));
  repo("hdr/n64.n64", "n64.z64 little-endian (.n64)", "swap words", () => swapWords(n64Z64()));
  repo("hdr/n64-patched.z64", "N64 target, big-endian", "synthetic", () => n64Target());
  repo("hdr/n64-patched.v64", "N64 target, byte-swapped", "swap pairs", () => swapPairs(n64Target()));
  repo("hdr/n64-patched.n64", "N64 target, little-endian", "swap words", () => swapWords(n64Target()));
  repo("hdr/n64.bps", "BPS made against the big-endian ROM", "encodeBps", () => E.encodeBps(n64Z64(), n64Target()));

  // ----------------------------------------------- product-made patches (cache)
  const rw = (name, format, kind) =>
    cache(`patches/rw/${kind}.${format}`, `${format} ${kind} patch authored by 'rom-weaver patch create'`, `rom-weaver patch create --original base.bin --modified ${kind}.bin -o ${name}`, (self) => {
      const out = self.location(`patches/rw/${kind}.${format}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const result = self.run(["patch", "create", "--original", self.path("rom/base.bin"), "--modified", self.path(`rom/${kind}.bin`), "--output", out, "--force"]);
      if (result.code !== 0) throw new Error(`patch create ${format} ${kind} failed: ${result.all.slice(0, 300)}`);
      return undefined;
    });
  for (const format of PATCH_FORMATS_WITH_CREATE) {
    rw(`same.${format}`, format, "same");
    if (format !== "pat") rw(`grow.${format}`, format, "grow");
    if (!["ips32", "ppf", "pat", "ebp", "mod"].includes(format)) rw(`shrink.${format}`, format, "shrink"); // those formats cannot encode a shorter target
  }
  for (const secondary of ["djw", "fgk", "lzma", "auto"]) {
    cache(`patches/rw/secondary-${secondary}.xdelta`, `xdelta with --xdelta-secondary ${secondary}`, "rom-weaver patch create --xdelta-secondary", (self) => {
      const out = self.location(`patches/rw/secondary-${secondary}.xdelta`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const result = self.run(["patch", "create", "--original", self.path("rom/base.bin"), "--modified", self.path("rom/same.bin"), "--output", out, "--xdelta-secondary", secondary, "--force"]);
      if (result.code !== 0) throw new Error(result.all.slice(0, 300));
      return undefined;
    });
  }
  cache("patches/rw/undo.ppf", "PPF made with --ppf-undo", "rom-weaver patch create --ppf-undo", (self) => {
    const out = self.location("patches/rw/undo.ppf");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const result = self.run(["patch", "create", "--original", self.path("rom/base.bin"), "--modified", self.path("rom/same.bin"), "--output", out, "--ppf-undo", "--force"]);
    if (result.code !== 0) throw new Error(result.all.slice(0, 300));
    return undefined;
  });

  // ------------------------------------------------ chains: base -ips-> same -bps-> grow -ups-> shrink
  repo("chain/1-base-to-same.ips", "chain step 1 (IPS, base -> same)", "encodeIps", () => E.encodeIps(base(), target("same")));
  repo("chain/2-same-to-grow.bps", "chain step 2 (BPS, same -> grow)", "encodeBps", () => E.encodeBps(target("same"), target("grow")));
  repo("chain/3-grow-to-shrink.ups", "chain step 3 (UPS, grow -> shrink)", "encodeUps", () => E.encodeUps(target("grow"), target("shrink")));
  repo("chain/2b-base-to-grow.bps", "BPS authored against the ORIGINAL ROM (base -> grow)", "encodeBps", () => E.encodeBps(base(), target("grow")));

  repo("cheats/nes32.nes", "iNES ROM, 32 KiB PRG of zeros (cheat offset arithmetic)", "port of cheats.rs nes_rom", () => E.concat(Uint8Array.of(0x4e, 0x45, 0x53, 0x1a, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), new Uint8Array(0x8000)));
  fx.define("cheats/snes4m.sfc", { where: "cache", purpose: "4 MiB zero headerless LoROM image for SNES Game Genie offsets", how: "zeros", deterministic: true, build: () => new Uint8Array(0x400000) });

  // -------------------------------------------- Game Boy ROM for --repair-checksum
  const gbRom = (patched) => {
    const rom = randomBytes(0x8000, 0x47422121);
    rom.set(hex("CEED6666CC0D000B03730083000C000D0008111F8889000EDCCC6EE6DDDDD999BBBB67636E0EECCCDDDC999FBBB9333E"), 0x104); // Nintendo logo
    rom.set(E.ascii("MATRIXTEST"), 0x134);
    rom[0x143] = 0;
    rom[0x147] = 0;
    rom[0x148] = 0;
    rom[0x149] = 0;
    if (patched) {
      rom[0x1000] ^= 0xff;
      rom[0x2000] ^= 0xff;
    }
    let header = 0;
    for (let at = 0x134; at <= 0x14c; at++) header = (header - rom[at] - 1) & 0xff;
    rom[0x14d] = header;
    let sum = 0;
    for (let at = 0; at < rom.length; at++) if (at !== 0x14e && at !== 0x14f) sum = (sum + rom[at]) & 0xffff;
    rom[0x14e] = sum >> 8;
    rom[0x14f] = sum & 0xff;
    return rom;
  };
  repo("gb/game.gb", "32 KiB Game Boy ROM with valid header + global checksums", "synthetic", () => gbRom(false));
  repo("gb/edit.ips", "IPS editing two data bytes (leaves GB checksums stale)", "encodeIps", () => E.encodeIps(gbRom(false), (() => {
    const t = gbRom(false).slice();
    t[0x1000] ^= 0xff;
    t[0x2000] ^= 0xff;
    return t;
  })()));

  // ------------------------------------ DLDI (driver is the patch; ROM needs a patchable slot)
  const dldiDriver = (log2, baseAddress, name) => {
    const size = 1 << log2;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    bytes.set([0xed, 0xa5, 0x8d, 0xbf, 0x20, 0x43, 0x68, 0x69, 0x73, 0x68, 0x6d, 0x00], 0);
    bytes[0x0c] = 1;
    bytes[0x0d] = log2;
    bytes[0x0e] = 0x0f;
    bytes[0x0f] = log2;
    bytes.set(E.ascii(name).subarray(0, 47), 0x10);
    const put = (at, value) => view.setInt32(at, value, true);
    put(0x40, baseAddress);
    put(0x44, baseAddress + size);
    put(0x48, baseAddress + 0xa0);
    put(0x4c, baseAddress + 0xa8);
    put(0x50, baseAddress + 0xa8);
    put(0x54, baseAddress + 0xb0);
    put(0x58, baseAddress + 0xb0);
    put(0x5c, baseAddress + 0xc0);
    put(0x68, baseAddress + 0x80);
    put(0x70, baseAddress + 0x88);
    put(0x74, baseAddress + 0x8c);
    put(0x7c, baseAddress + 0x90);
    put(0x84, baseAddress + 0xd0);
    put(0x8c, baseAddress + 0xd8);
    put(0xa0, baseAddress + 0x80);
    put(0xa8, baseAddress + 0x84);
    bytes.fill(0x7f, 0xb0, 0xc0);
    return bytes;
  };
  repo("dldi/slot.nds", "NDS-like file with a 4 KiB DLDI slot at 0x300", "port of build_nds_with_dldi_slot", () => {
    const file = new Uint8Array(0x300 + 0x1000 + 0x80).fill(0xcd);
    file.set(dldiDriver(12, 0x02000000, "Default driver"), 0x300);
    return file;
  });
  repo("dldi/driver.dldi", "256-byte DLDI driver (patch)", "port of build_dldi_driver", () => dldiDriver(8, 0xbf800000 | 0, "Matrix driver"));
  repo("dldi/oversized.dldi", "8 KiB DLDI driver, larger than the 4 KiB slot", "port of build_dldi_driver", () => dldiDriver(13, 0xbf800000 | 0, "Oversized driver"));
  repo("dldi/nonslot.nds", "File with no DLDI section", "0xCD fill", () => new Uint8Array(0x2000).fill(0xcd));
};

/** Container fixtures built with system tools / the rom-weaver binary. Registered separately for readability. */
export const defineContainers = (fx, { root }) => {
  const cache = (name, purpose, how, build) => fx.define(name, { where: "cache", purpose, how, deterministic: false, build });
  const stage = (names) => {
    fs.mkdirSync(fx.cacheDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(fx.cacheDir, ".stage-"));
    for (const [file, source] of Object.entries(names)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), typeof source === "string" ? fs.readFileSync(fx.path(source)) : source);
    }
    return dir;
  };
  const sh = (cwd, cmd, args, env) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  const done = (dir) => fs.rmSync(dir, { recursive: true, force: true });
  const viaTool = (name, purpose, files, tools) =>
    cache(`ctr/${name}`, purpose, tools.how, () => {
      fs.mkdirSync(path.dirname(fx.location(`ctr/${name}`)), { recursive: true });
      const dir = stage(files);
      try {
        tools.make(dir, fx.location(`ctr/${name}`));
      } finally {
        done(dir);
      }
      return undefined;
    });
  const rwCompress = (dir, out, extra = []) => {
    const result = fx.run(["compress", "--input", path.join(dir, "game.bin"), "--output", out, "--force", ...extra]);
    if (result.code !== 0) throw new Error(`rom-weaver compress failed: ${result.all.slice(0, 300)}`);
  };
  const one = { "game.bin": "rom/base.bin" };

  viaTool("zip-deflate.zip", "zip(deflate) from Info-ZIP", one, { how: "zip -9", make: (dir, out) => sh(dir, "zip", ["-q", "-9", out, "game.bin"]) });
  viaTool("zip-store.zip", "zip(stored) from Info-ZIP", one, { how: "zip -0", make: (dir, out) => sh(dir, "zip", ["-q", "-0", out, "game.bin"]) });
  viaTool("bsdtar.zip", "zip from bsdtar", one, { how: "bsdtar --format zip", make: (dir, out) => sh(dir, "bsdtar", ["--format", "zip", "-cf", out, "game.bin"]) });
  viaTool("bsdtar.7z", "7z from bsdtar (independent of rom-weaver)", one, { how: "bsdtar --format 7zip", make: (dir, out) => sh(dir, "bsdtar", ["--format", "7zip", "-cf", out, "game.bin"]) });
  viaTool("rw.zip", "zip from rom-weaver compress", one, { how: "rom-weaver compress", make: (dir, out) => rwCompress(dir, out) });
  viaTool("rw-store.zip", "zip (store codec) from rom-weaver", one, { how: "rom-weaver compress --codec store", make: (dir, out) => rwCompress(dir, out, ["--codec", "store"]) });
  viaTool("rw-zstd.zip", "zip (zstd codec) from rom-weaver", one, { how: "rom-weaver compress --codec zstd", make: (dir, out) => rwCompress(dir, out, ["--codec", "zstd"]) });
  viaTool("rw.7z", "7z from rom-weaver compress", one, { how: "rom-weaver compress", make: (dir, out) => rwCompress(dir, out) });
  viaTool("plain.tar", "tar", one, { how: "tar cf", make: (dir, out) => sh(dir, "tar", ["cf", out, "game.bin"]) });
  viaTool("plain.tar.gz", "tar.gz", one, { how: "tar czf", make: (dir, out) => sh(dir, "tar", ["czf", out, "game.bin"]) });
  viaTool("plain.tgz", "tgz", one, { how: "tar czf", make: (dir, out) => sh(dir, "tar", ["czf", out, "game.bin"]) });
  viaTool("plain.tar.bz2", "tar.bz2", one, { how: "tar cjf", make: (dir, out) => sh(dir, "tar", ["cjf", out, "game.bin"]) });
  viaTool("plain.tbz2", "tbz2", one, { how: "tar cjf", make: (dir, out) => sh(dir, "tar", ["cjf", out, "game.bin"]) });
  viaTool("plain.tar.xz", "tar.xz", one, { how: "tar cJf", make: (dir, out) => sh(dir, "tar", ["cJf", out, "game.bin"]) });
  viaTool("plain.txz", "txz", one, { how: "tar cJf", make: (dir, out) => sh(dir, "tar", ["cJf", out, "game.bin"]) });
  viaTool("game.bin.gz", "gzip single payload", one, { how: "gzip -n -c", make: (dir, out) => fs.writeFileSync(out, sh(dir, "gzip", ["-n", "-c", "game.bin"])) });
  viaTool("game.bin.bz2", "bzip2 single payload", one, { how: "bzip2 -c", make: (dir, out) => fs.writeFileSync(out, sh(dir, "bzip2", ["-c", "game.bin"])) });
  viaTool("game.bin.xz", "xz single payload", one, { how: "xz -c", make: (dir, out) => fs.writeFileSync(out, sh(dir, "xz", ["-c", "game.bin"])) });
  viaTool("game.bin.zst", "zstd single payload", one, { how: "zstd -c", make: (dir, out) => fs.writeFileSync(out, sh(dir, "zstd", ["-q", "-c", "game.bin"])) });
  viaTool("game.bin.lzma", "legacy lzma-alone payload (not a registered format)", one, { how: "lzma -c", make: (dir, out) => fs.writeFileSync(out, sh(dir, "lzma", ["-c", "game.bin"])) });
  viaTool("encrypted.zip", "password-protected zip (ZipCrypto)", one, { how: "zip -P secret", make: (dir, out) => sh(dir, "zip", ["-q", "-P", "secret", out, "game.bin"]) });
  viaTool("two-roms.zip", "zip with game.bin and other.bin", { "game.bin": "rom/base.bin", "other.bin": "rom/wrong.bin" }, { how: "zip", make: (dir, out) => sh(dir, "zip", ["-q", out, "game.bin", "other.bin"]) });
  viaTool("rom-plus-readme.zip", "zip with a ROM plus readme/sidecars", { "game.bin": "rom/base.bin", "README.txt": Buffer.from("read me\n"), "game.nfo": Buffer.from("nfo\n") }, { how: "zip", make: (dir, out) => sh(dir, "zip", ["-q", out, "game.bin", "README.txt", "game.nfo"]) });
  viaTool("rom-plus-patch.zip", "RetroArch layout: game.bin + game.ips in one zip", { "game.bin": "rom/base.bin", "game.ips": "patches/ind/same.ips" }, { how: "zip", make: (dir, out) => sh(dir, "zip", ["-q", out, "game.bin", "game.ips"]) });
  viaTool("subdir.zip", "ROM inside nested directories with spaces/unicode", { "dir one/ゲーム é/game.bin": "rom/base.bin" }, { how: "zip", make: (dir, out) => sh(dir, "zip", ["-q", "-r", out, "dir one"]) });
  viaTool("nested-inner.zip", "inner zip holding game.bin", one, { how: "zip", make: (dir, out) => sh(dir, "zip", ["-q", out, "game.bin"]) });
  cache("ctr/nested-outer.zip", "zip containing a zip containing game.bin", "zip of nested-inner.zip", () => {
    const dir = stage({ "inner.zip": fs.readFileSync(fx.path("ctr/nested-inner.zip")) });
    try {
      sh(dir, "zip", ["-q", fx.location("ctr/nested-outer.zip"), "inner.zip"]);
    } finally {
      done(dir);
    }
    return undefined;
  });
  cache("ctr/nested-tgz-7z.tgz", "tar.gz containing a 7z containing game.bin", "tar czf of bsdtar.7z", () => {
    const dir = stage({ "inner.7z": fs.readFileSync(fx.path("ctr/bsdtar.7z")) });
    try {
      sh(dir, "tar", ["czf", fx.location("ctr/nested-tgz-7z.tgz"), "inner.7z"]);
    } finally {
      done(dir);
    }
    return undefined;
  });
  cache("ctr/truncated.zip", "zip cut to half its length", "head -c of zip-deflate.zip", () => fs.readFileSync(fx.path("ctr/zip-deflate.zip")).subarray(0, 20000));
  cache("ctr/truncated.7z", "7z cut to half its length", "head -c of rw.7z", () => {
    const bytes = fs.readFileSync(fx.path("ctr/rw.7z"));
    return bytes.subarray(0, bytes.length >> 1);
  });
  cache("ctr/truncated.tar.gz", "tar.gz cut to half its length", "head -c of plain.tar.gz", () => {
    const bytes = fs.readFileSync(fx.path("ctr/plain.tar.gz"));
    return bytes.subarray(0, bytes.length >> 1);
  });
  cache("ctr/garbage.zip", "random bytes named .zip", "xorshift", () => randomBytes(4096, 0x21));
  cache("ctr/garbage.7z", "random bytes named .7z", "xorshift", () => randomBytes(4096, 0x22));
  viaTool("empty.zip", "zip with zero entries", one, { how: "zip then zip -d", make: (dir, out) => {
    sh(dir, "zip", ["-q", out, "game.bin"]);
    sh(dir, "zip", ["-q", "-d", out, "game.bin"]);
  } });
  // patch containers
  const patchSrc = "patches/ind/same.bps";
  viaTool("patch.bps.zip", "zip holding same.bps", { "same.bps": patchSrc }, { how: "zip", make: (dir, out) => sh(dir, "zip", ["-q", out, "same.bps"]) });
  viaTool("patch.bps.7z", "7z holding same.bps", { "same.bps": patchSrc }, { how: "bsdtar 7zip", make: (dir, out) => sh(dir, "bsdtar", ["--format", "7zip", "-cf", out, "same.bps"]) });
  viaTool("patch.bps.tar.gz", "tar.gz holding same.bps", { "same.bps": patchSrc }, { how: "tar czf", make: (dir, out) => sh(dir, "tar", ["czf", out, "same.bps"]) });
  viaTool("patch.bps.gz", "gzip of same.bps", { "same.bps": patchSrc }, { how: "gzip -n", make: (dir, out) => fs.writeFileSync(out, sh(dir, "gzip", ["-n", "-c", "same.bps"])) });
  viaTool("patch.bps.xz", "xz of same.bps", { "same.bps": patchSrc }, { how: "xz", make: (dir, out) => fs.writeFileSync(out, sh(dir, "xz", ["-c", "same.bps"])) });
  viaTool("patch.bps.zst", "zstd of same.bps", { "same.bps": patchSrc }, { how: "zstd", make: (dir, out) => fs.writeFileSync(out, sh(dir, "zstd", ["-q", "-c", "same.bps"])) });
  viaTool("patch.bps.bz2", "bzip2 of same.bps", { "same.bps": patchSrc }, { how: "bzip2", make: (dir, out) => fs.writeFileSync(out, sh(dir, "bzip2", ["-c", "same.bps"])) });
  viaTool("patches-multi.zip", "zip with two patches (same.bps, other.ips) and a readme", { "same.bps": patchSrc, "other.ips": "patches/ind/grow.ips", "README.txt": Buffer.from("notes\n") }, { how: "zip", make: (dir, out) => sh(dir, "zip", ["-q", out, "same.bps", "other.ips", "README.txt"]) });
  viaTool("patch-encrypted.zip", "password-protected zip holding a patch", { "same.bps": patchSrc }, { how: "zip -P", make: (dir, out) => sh(dir, "zip", ["-q", "-P", "secret", out, "same.bps"]) });

  // disc-ish containers made from the webapp's synthetic builders (see containers.mjs) -> built lazily there.
  void root;
};
