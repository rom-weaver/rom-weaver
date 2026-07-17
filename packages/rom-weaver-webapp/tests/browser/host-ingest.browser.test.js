import { afterEach, expect, test } from "vitest";
import {
  HOST_INGEST_EVENT,
  ingest,
  resolveHostIngestFiles,
  subscribeHostIngest,
} from "../../src/webapp/host-ingest.ts";
import { createBrowserOpfsSourceRef } from "../../src/workers/protocol/browser-opfs-source-ref.ts";
import { getManagedOpfsFileHandle, removeManagedOpfsPath } from "../../src/workers/protocol/opfs-path.ts";

const FILE_PATH = "/work/rom-weaver-imports/change.ips";

afterEach(async () => {
  await removeManagedOpfsPath(FILE_PATH);
});

test("ingest and the public event deliver the same OPFS path lists", () => {
  const received = [];
  const unsubscribe = subscribeHostIngest((paths) => received.push([...paths]));
  try {
    ingest([FILE_PATH]);
    document.dispatchEvent(new CustomEvent(HOST_INGEST_EVENT, { detail: [FILE_PATH] }));
  } finally {
    unsubscribe();
  }
  expect(received).toEqual([[FILE_PATH], [FILE_PATH]]);
});

test("resolveHostIngestFiles keeps the OPFS path on the classifiable File", async () => {
  const handle = await getManagedOpfsFileHandle(FILE_PATH, { create: true, navigatorObject: navigator });
  const writer = await handle.createWritable();
  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.close();

  const [file] = await resolveHostIngestFiles([FILE_PATH]);
  expect(file).toBeInstanceOf(File);
  expect(file.name).toBe("change.ips");
  expect(file.filePath).toBe(FILE_PATH);
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);

  const staged = await createBrowserOpfsSourceRef(file, file.name, {
    mountPoint: "/work",
    pathPrefix: "host-ingest",
  });
  expect(staged.filePath).toBe(FILE_PATH);
  expect(staged.virtual).toBeUndefined();
  await staged.cleanup();
  expect(await getManagedOpfsFileHandle(FILE_PATH, { navigatorObject: navigator })).not.toBeNull();
});

test("host ingest rejects paths outside its preserved directory", async () => {
  expect(() => ingest(["/work/private/game.bin"])).toThrow("/work/rom-weaver-imports/");
  await expect(resolveHostIngestFiles(["/work/private/game.bin"])).rejects.toThrow("/work/rom-weaver-imports/");
});
