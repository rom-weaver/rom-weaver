import fs from "node:fs";
import { createHash } from "node:crypto";
import { add, check } from "../lib/harness.mjs";

const sha1 = (bytes) => createHash("sha1").update(bytes).digest();

// Raw LZMA2 permits uncompressed packets; these have no payload checksum.
const lzma2 = (bytes) => {
  const packets = [];
  for (let at = 0; at < bytes.length; at += 65536) {
    const data = bytes.subarray(at, at + 65536);
    const header = Buffer.alloc(3);
    header[0] = at === 0 ? 1 : 2;
    header.writeUInt16BE(data.length - 1, 1);
    packets.push(header, data);
  }
  return Buffer.concat([...packets, Buffer.from([0])]);
};

const wiaFixture = (compression, nkit) => {
  const iso = Buffer.alloc(0x20000);
  iso.write("RWTE00");
  iso.writeUInt32BE(0xc2339f3d, 0x1c);
  for (let at = 0x8000; at < iso.length; at++) iso[at] = at % 251;
  const encode = compression === "none" ? (bytes) => bytes : lzma2;
  const nkitHeader = Buffer.alloc(nkit ? 32 : 0);
  if (nkit) {
    nkitHeader.write("NKIT  v2");
    nkitHeader.writeUInt16BE(32, 8);
    nkitHeader.writeUInt16BE(8, 10);
    sha1(iso).copy(nkitHeader, 12);
  }
  const raw = Buffer.alloc(24);
  raw.writeBigUInt64BE(BigInt(iso.length), 8);
  raw.writeUInt32BE(1, 20);
  const rawEncoded = encode(raw);
  const groupOffset = 0x124 + nkitHeader.length + rawEncoded.length;
  const payloadOffset = (groupOffset + encode(Buffer.alloc(8)).length + 3) & ~3;
  const payload = encode(iso);
  const group = Buffer.alloc(8);
  group.writeUInt32BE(payloadOffset / 4);
  group.writeUInt32BE(payload.length, 4);
  const groupEncoded = encode(group);
  const disc = Buffer.alloc(0xdc);
  disc.writeUInt32BE(1);
  disc.writeUInt32BE(compression === "none" ? 0 : 4, 4);
  disc.writeUInt32BE(0x200000, 12);
  iso.copy(disc, 16, 0, 0x80);
  disc.writeUInt32BE(0x30, 148);
  sha1(Buffer.alloc(0)).copy(disc, 160);
  disc.writeUInt32BE(1, 180);
  disc.writeBigUInt64BE(BigInt(0x124 + nkitHeader.length), 184);
  disc.writeUInt32BE(rawEncoded.length, 192);
  disc.writeUInt32BE(1, 196);
  disc.writeBigUInt64BE(BigInt(groupOffset), 200);
  disc.writeUInt32BE(groupEncoded.length, 208);
  disc[212] = compression === "none" ? 0 : 1;
  const image = Buffer.alloc(payloadOffset + payload.length);
  image.set([0x57, 0x49, 0x41, 1]);
  image.writeUInt32BE(0x01000000, 4);
  image.writeUInt32BE(0x01000000, 8);
  image.writeUInt32BE(disc.length, 12);
  sha1(disc).copy(image, 16);
  image.writeBigUInt64BE(BigInt(iso.length), 36);
  image.writeBigUInt64BE(BigInt(image.length), 44);
  sha1(image.subarray(0, 52)).copy(image, 52);
  disc.copy(image, 0x48);
  nkitHeader.copy(image, 0x124);
  rawEncoded.copy(image, 0x124 + nkitHeader.length);
  groupEncoded.copy(image, groupOffset);
  payload.copy(image, payloadOffset);
  return { image, iso, payloadOffset };
};

export const registerWiaCases = () => {
  for (const [compression, count] of [["none", 40], ["lzma2", 13]]) {
    for (const region of ["header", "payload", "nkit-payload"]) {
      add(`container.disc.wia-bitflip.${compression}.${region}`, ["container", "disc", "wia", "negative"], (ctx) => {
        const { image, iso, payloadOffset } = wiaFixture(compression, region === "nkit-payload");
        const extract = (bytes, name) => {
          const input = ctx.write(`${name}.wia`, bytes);
          const dir = ctx.tmp(name);
          const result = ctx.run(["extract", "--input", input, "--output", dir, "-j", "1"]);
          return { result, output: `${dir}/${name}.iso` };
        };
        const control = extract(image, "valid");
        ctx.ok(control.result, "valid WIA extraction");
        check(fs.readFileSync(control.output).equals(iso), "valid WIA changed ISO bytes");
        let cleanFailures = 0;
        let documentedLimits = 0;
        for (let index = 0; index < count; index++) {
          const mutated = Buffer.from(image);
          const at = region === "header" ? Math.floor(index * 0x124 / count) : payloadOffset + 0x9000 + index * 97;
          mutated[at] ^= 1;
          const { result, output } = extract(mutated, `flip-${index}`);
          check(!result.panic && !result.timedOut, () => ctx.describe(result));
          if (result.code !== 0) {
            ctx.failed(result, { what: `WIA bit flip at ${at}` });
            check(!ctx.exists(output), "failed WIA extraction left output");
            cleanFailures++;
          } else {
            const correct = fs.readFileSync(output).equals(iso);
            check(region === "payload" || correct, `${region} corruption escaped its checksum at ${at}`);
            if (!correct) documentedLimits++;
          }
        }
        ctx.note(`${count} flips: ${cleanFailures} fail-cleanly, ${documentedLimits} documented-limit (docs/reference/formats.md, WIA payload integrity)`);
      });
    }
  }
};
