import { expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { runEmulatorBootCheck } from "../../src/public/react/components/emulator-boot-check.ts";

const bootOptions = {
  checksum: "a".repeat(40),
  core: "nes",
  dataUrl: "/emulatorjs/data/",
  fileName: "hello-world.nes",
};

test("the boot check gives MEMFS the registered ROM buffer and releases its URL after booting", async () => {
  const response = await fetch("/hello-world.nes");
  expect(response.ok).toBe(true);
  const rom = await response.blob();
  const read = rom.arrayBuffer.bind(rom);
  let buffer;
  const arrayBuffer = vi.spyOn(rom, "arrayBuffer").mockImplementation(async () => {
    buffer = await read();
    return buffer;
  });
  const createUrl = vi.spyOn(URL, "createObjectURL");
  const controller = new AbortController();
  const host = document.createElement("div");
  const start = document.createElement("button");
  start.textContent = "Check boot";
  host.append(start);
  document.body.append(host);
  await userEvent.click(start);
  const check = runEmulatorBootCheck({ ...bootOptions, host, rom, signal: controller.signal, timeoutMs: 60_000 });
  const gameUrl = createUrl.mock.results[0].value;
  const frame = host.querySelector("iframe");
  try {
    expect(globalThis.__romWeaverEmulatorGames?.get(gameUrl)).toBe(rom);
    await expect.poll(() => buffer, { timeout: 60_000 }).toBeInstanceOf(ArrayBuffer);
    await expect
      .poll(() => {
        const emulator = frame.contentWindow?.EJS_emulator;
        return emulator?.gameManager?.FS.lookupPath(`/${emulator.fileName}`).node.contents.buffer;
      })
      .toBe(buffer);
    expect(await check).toMatchObject({ status: "boots" });
    expect(arrayBuffer).toHaveBeenCalledOnce();
    expect(frame.isConnected).toBe(false);
    expect(globalThis.__romWeaverEmulatorGames.get(gameUrl)).toBeNull();
    await expect(fetch(gameUrl)).rejects.toThrow();
  } finally {
    controller.abort();
    await check.catch(() => undefined);
    arrayBuffer.mockRestore();
    createUrl.mockRestore();
    host.remove();
  }
}, 120_000);

test.each(["abort", "error"])("the boot check releases its registered ROM and URL on %s", async (ending) => {
  const rom = new Blob([new Uint8Array([1, 2, 3])]);
  const controller = new AbortController();
  const createUrl = vi.spyOn(URL, "createObjectURL");
  const failure = new Error("The boot check host could not attach the player.");
  let registered;
  let frame;
  const host = {
    append(player) {
      frame = player;
      const gameUrl = createUrl.mock.results[0].value;
      registered = globalThis.__romWeaverEmulatorGames?.get(gameUrl);
      if (ending === "error") throw failure;
      document.body.append(player);
    },
  };
  const check = runEmulatorBootCheck({ ...bootOptions, host, rom, signal: controller.signal });
  const gameUrl = createUrl.mock.results[0].value;
  try {
    if (ending === "abort") controller.abort();
    await expect(check).rejects.toMatchObject(ending === "abort" ? { name: "AbortError" } : failure);
    expect(registered).toBe(rom);
    expect(frame.isConnected).toBe(false);
    expect(globalThis.__romWeaverEmulatorGames.get(gameUrl)).toBeNull();
    await expect(fetch(gameUrl)).rejects.toThrow();
  } finally {
    controller.abort();
    await check.catch(() => undefined);
    createUrl.mockRestore();
    frame?.remove();
  }
});
