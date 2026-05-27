import { expect, test } from "vitest";
import { clearOpfsOnPageLoad } from "../../src/webapp/site-data-cleanup.ts";

const createOpfsStorage = (names, options = {}) => {
  const removed = [];
  const failingNames = new Set(options.failingNames || []);
  const root = {
    async *keys() {
      for (const name of names) yield name;
    },
    async removeEntry(name, removeOptions) {
      removed.push({ name, options: removeOptions });
      if (failingNames.has(name)) throw new Error(`remove failed for ${name}`);
    },
  };
  return {
    removed,
    storage: {
      getDirectory: async () => root,
    },
  };
};

test("clearOpfsOnPageLoad removes every OPFS root entry recursively", async () => {
  const { removed, storage } = createOpfsStorage(["input", "output", ".rom-weaver-opfs-scratch"]);

  await expect(clearOpfsOnPageLoad({ storage })).resolves.toEqual({
    deletedEntries: 3,
    failedEntries: 0,
  });

  expect(removed).toEqual([
    { name: "input", options: { recursive: true } },
    { name: "output", options: { recursive: true } },
    { name: ".rom-weaver-opfs-scratch", options: { recursive: true } },
  ]);
});

test("clearOpfsOnPageLoad reports skipped and failed cleanup states", async () => {
  await expect(clearOpfsOnPageLoad({ enabled: false })).resolves.toEqual({
    deletedEntries: 0,
    failedEntries: 0,
    skippedReason: "cleanup-disabled",
  });

  const { storage } = createOpfsStorage(["input", "output"], { failingNames: ["output"] });

  await expect(clearOpfsOnPageLoad({ storage })).resolves.toEqual({
    deletedEntries: 1,
    failedEntries: 1,
  });
});
