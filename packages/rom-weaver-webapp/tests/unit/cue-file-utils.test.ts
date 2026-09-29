import { describe, expect, it } from "vitest";
import { replaceCuePatchFileName } from "../../src/workers/protocol/cue-file-utils.ts";

describe("replaceCuePatchFileName", () => {
  it("points the first BINARY entry at the file even when an audio entry comes first", () => {
    const cue = 'FILE "intro.wav" WAVE\n  TRACK 01 AUDIO\nFILE "data.bin" BINARY\n  TRACK 02 MODE1/2352\n';
    expect(replaceCuePatchFileName(cue, "/work/staged.bin")).toBe(
      'FILE "intro.wav" WAVE\n  TRACK 01 AUDIO\nFILE "/work/staged.bin" BINARY\n  TRACK 02 MODE1/2352\n',
    );
  });

  it("points an audio-only cue's FILE entry at the file and keeps its type", () => {
    const cue = 'FILE "song.wav" WAVE\r\n  TRACK 01 AUDIO\r\n    INDEX 01 00:00:00\r\n';
    expect(replaceCuePatchFileName(cue, "/work/staged.wav")).toBe(
      'FILE "/work/staged.wav" WAVE\r\n  TRACK 01 AUDIO\r\n    INDEX 01 00:00:00\r\n',
    );
  });

  it("keeps a CRLF sheet's carriage return on the rewritten BINARY line", () => {
    expect(replaceCuePatchFileName('FILE "a.bin" BINARY\r\n  TRACK 01 MODE1/2352\r\n', "b.bin")).toBe(
      'FILE "b.bin" BINARY\r\n  TRACK 01 MODE1/2352\r\n',
    );
  });

  it("rejects a cue without any FILE entry", () => {
    expect(() => replaceCuePatchFileName("TRACK 01 AUDIO\n", "x.bin")).toThrow(
      "CD CHD cue does not contain a FILE entry",
    );
  });
});
