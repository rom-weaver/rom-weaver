import { describe, expect, it } from "vitest";
import {
  assertRunJsonSucceeded,
  getGuestFileSize,
  joinGuestPath,
  withTempFixture,
  writeGuestFile,
} from "./test-helpers.mjs";

// A two-entry zip (`game.bin`, `bonus.sfc`) - two distinct top-level payloads, so an interactive
// extract with no `--select` is ambiguous and the wasm app prompts via `select_many`.
const MULTI_ROM_ZIP_URL = new URL("../fixtures/archives/multi-rom.zip", import.meta.url);

async function loadMultiRomZipBytes() {
  const response = await fetch(MULTI_ROM_ZIP_URL.href);
  if (!response.ok) throw new Error(`failed to load multi-rom.zip fixture (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function guestFileSizeOrNull(opfsHandle, guestPath) {
  try {
    return await getGuestFileSize(opfsHandle, guestPath);
  } catch {
    return null;
  }
}

// Drive a real interactive `extract` on the two-entry archive, capturing the selection request the
// wasm app posts and answering it with `resolveSelection`. Exercises every layer of the prompt
// channel: wasm `select_many` extern -> env import -> runner SAB -> worker client -> handler.
async function extractMultiRomWithSelection(resolveSelection) {
  // `withTempFixture` does not forward its callback's return value, so collect the outcome here.
  let captured;
  await withTempFixture(async ({ dir, worker, opfsHandle }) => {
    const archivePath = joinGuestPath(dir, "multi-rom.zip");
    const extractDir = joinGuestPath(dir, "multi-rom-extract");
    await writeGuestFile(opfsHandle, archivePath, await loadMultiRomZipBytes());

    const requests = [];
    worker.setSelectionHandler((request) => {
      const parsed = JSON.parse(request);
      requests.push(parsed);
      return resolveSelection(parsed);
    });

    const result = await worker.runJson(["extract", archivePath, "--out-dir", extractDir, "--threads", "1"], {
      interactive_selection_enabled: true,
    });

    captured = {
      bonusSize: await guestFileSizeOrNull(opfsHandle, joinGuestPath(extractDir, "bonus.sfc")),
      gameSize: await guestFileSizeOrNull(opfsHandle, joinGuestPath(extractDir, "game.bin")),
      requests,
      result,
    };
  });
  return captured;
}

describe("rom-weaver-wasm interactive multi-select prompt", () => {
  it("extracts every entry chosen in a multi-select prompt", async () => {
    const { requests, result, gameSize, bonusSize } = await extractMultiRomWithSelection((parsed) =>
      parsed.candidates.map((_candidate, index) => index),
    );

    assertRunJsonSucceeded(result, { command: "extract" });
    // The app asked for a many-select with both payloads as candidates.
    expect(requests).toHaveLength(1);
    expect(requests[0].mode).toBe("many");
    expect(requests[0].candidates).toHaveLength(2);
    // Both chosen entries made it out of the archive.
    expect(gameSize).toBe(13);
    expect(bonusSize).toBe(10);
  });

  it("extracts only the subset of entries selected", async () => {
    // Pick just the first candidate (`game.bin`); `bonus.sfc` must be left behind.
    const { result, gameSize, bonusSize } = await extractMultiRomWithSelection(() => [0]);

    assertRunJsonSucceeded(result, { command: "extract" });
    expect(gameSize).toBe(13);
    expect(bonusSize).toBeNull();
  });

  it("cancels the extract when the multi-select prompt resolves to no entries", async () => {
    // An empty selection is a cancel: the run fails and nothing is extracted.
    const { result, gameSize, bonusSize } = await extractMultiRomWithSelection(() => []);

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(gameSize).toBeNull();
    expect(bonusSize).toBeNull();
  });
});
