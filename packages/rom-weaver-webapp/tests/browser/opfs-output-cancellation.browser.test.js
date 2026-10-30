import { afterEach, expect, it } from "vitest";
import { runWithRomWeaverOutputScope } from "../../src/lib/runtime/run-output-paths.ts";
import { removeManagedOpfsPath } from "../../src/workers/protocol/opfs-path.ts";
import { resetRomWeaverRunner, waitForRomWeaverShutdown } from "../../src/workers/rom-weaver/runner-control.ts";
import { runRomWeaverJson } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";
import { buildStoredZip } from "../wasm/stored-zip-fixture.mjs";
import { assertRunJsonSucceeded, toTypedRunInput } from "../wasm/test-helpers.mjs";

const ownedScopes = new Set();

async function directoryAt(guestPath) {
  let directory = await navigator.storage.getDirectory();
  try {
    for (const part of guestPath.replace(/^\/work\//, "").split("/")) {
      directory = await directory.getDirectoryHandle(part, { create: false });
    }
    return directory;
  } catch (error) {
    if (error.name === "NotFoundError") return null;
    throw error;
  }
}

async function hasPopulatedOutput(path) {
  const directory = await directoryAt(path);
  if (!directory) return false;
  for await (const entry of directory.values()) {
    if (entry.kind === "file" && (await entry.getFile()).size > 0) return true;
  }
  return false;
}

afterEach(async () => {
  await resetRomWeaverRunner({ terminate: true });
  await waitForRomWeaverShutdown();
  for (const scope of ownedScopes) await removeManagedOpfsPath(scope, undefined, { ignoreErrors: false });
  ownedScopes.clear();
});

it.each([false, true])(
  "cancellation after populated OPFS output removes its scope and permits retry (concurrent reset=%s)",
  async (concurrentReset) => {
    const archivePath = `/work/cancel-output-${crypto.randomUUID()}.zip`;
    const source = new Blob([buildStoredZip(128, 512 * 1024)], { type: "application/zip" });
    const controller = new AbortController();
    let outputDirectory;
    let scopePath;
    let settled = false;
    const pending = runWithRomWeaverOutputScope(archivePath, "extracted", [], async (outputPath) => {
      outputDirectory = outputPath;
      scopePath = outputPath.slice(0, outputPath.lastIndexOf("/"));
      ownedScopes.add(scopePath);
      const result = await runRomWeaverJson(
        toTypedRunInput(["extract", "--input", archivePath, "--out-dir", outputPath, "--threads", "1"]),
        {
          signal: controller.signal,
          interactiveSelectionEnabled: false,
          virtualFiles: [{ path: archivePath, source }],
        },
      );
      assertRunJsonSucceeded(result);
      return result;
    }).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    await expect
      .poll(async () => outputDirectory && hasPopulatedOutput(outputDirectory), { timeout: 60000, interval: 5 })
      .toBe(true);
    expect(settled, "the operation must still be writing when cancellation begins").toBe(false);
    controller.abort();
    const resets = concurrentReset
      ? [resetRomWeaverRunner({ terminate: true }), resetRomWeaverRunner({ terminate: true })]
      : [];
    const cancelled = await pending;
    expect(cancelled.value).toBeUndefined();
    expect(cancelled.error).toMatchObject({ name: "AbortError", code: "CANCELLED" });
    await Promise.all(resets);
    await waitForRomWeaverShutdown();
    expect(await directoryAt(scopePath)).toBeNull();

    const retry = await runWithRomWeaverOutputScope(archivePath, "retry", [], async (outputPath) => {
      ownedScopes.add(outputPath.slice(0, outputPath.lastIndexOf("/")));
      const result = await runRomWeaverJson(
        toTypedRunInput(["extract", "--input", archivePath, "--out-dir", outputPath, "--threads", "1"]),
        {
          interactiveSelectionEnabled: false,
          virtualFiles: [{ path: archivePath, source: new Blob([buildStoredZip(2, 257)]) }],
        },
      );
      assertRunJsonSucceeded(result);
      expect(await hasPopulatedOutput(outputPath)).toBe(true);
      return result;
    });
    await retry.cleanup();
    expect(
      await directoryAt(scopePath),
      "closed writers must not recreate the cancelled scope during the next run",
    ).toBeNull();
  },
  120000,
);
