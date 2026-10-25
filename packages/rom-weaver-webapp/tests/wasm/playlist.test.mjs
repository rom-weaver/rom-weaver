import { expect, test } from "vitest";
import { assertRunJsonSucceeded, readGuestFile, toBytes, withTempFixture, writeGuestFile } from "./test-helpers.mjs";

const decode = (bytes) => new TextDecoder().decode(bytes);

test("the real WASM playlist command orders discs given out of order and writes bare file names", async () => {
  await withTempFixture(async ({ opfsHandle, worker }) => {
    const discs = ["Game (Disc 3).chd", "Game (Disc 1).chd", "Game (Disc 2).chd"];
    for (const name of discs) await writeGuestFile(opfsHandle, `/work/${name}`, toBytes(name));

    const outputPath = "/work/Game.m3u";
    const result = await worker.runJson({
      args: { flat: true, input: discs.map((name) => `/work/${name}`), output: outputPath },
      type: "playlist",
    });
    const event = assertRunJsonSucceeded(result, { command: "playlist" });
    expect(event.details.playlist.entries).toEqual(["Game (Disc 1).chd", "Game (Disc 2).chd", "Game (Disc 3).chd"]);
    expect(decode(await readGuestFile(opfsHandle, outputPath))).toBe(
      "Game (Disc 1).chd\nGame (Disc 2).chd\nGame (Disc 3).chd\n",
    );
  });
});

test("the real WASM playlist command keeps the given order with no_sort and bundles a ZIP", async () => {
  await withTempFixture(async ({ opfsHandle, worker }) => {
    const sheet = (name) => `FILE "${name}.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`;
    for (const stem of ["Game.disc02", "Game.disc01"]) {
      await writeGuestFile(opfsHandle, `/work/${stem}.cue`, toBytes(sheet(stem)));
      await writeGuestFile(opfsHandle, `/work/${stem}.bin`, toBytes(stem));
    }
    const inputs = ["/work/Game.disc02.cue", "/work/Game.disc02.bin", "/work/Game.disc01.cue"];

    const unsorted = await worker.runJson({
      args: { flat: true, input: inputs, no_sort: true, output: "/work/unsorted.m3u" },
      type: "playlist",
    });
    const unsortedEvent = assertRunJsonSucceeded(unsorted, { command: "playlist" });
    expect(unsortedEvent.details.playlist.entries).toEqual(["Game.disc02.cue", "Game.disc01.cue"]);

    const zipped = await worker.runJson({
      args: { input: inputs, output: "/work/Game.zip" },
      type: "playlist",
    });
    const zippedEvent = assertRunJsonSucceeded(zipped, { command: "playlist" });
    expect(zippedEvent.details.playlist.entries).toEqual(["Game.disc01.cue", "Game.disc02.cue"]);
    expect((await readGuestFile(opfsHandle, "/work/Game.zip")).byteLength).toBeGreaterThan(0);
  });
});
