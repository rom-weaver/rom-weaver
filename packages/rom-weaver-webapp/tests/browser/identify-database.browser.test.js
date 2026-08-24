import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "../../src/webapp/design-system/index.css";
import "../../src/webapp/design-system/deferred.css";

/* Drives the identify database manager UI against the REAL manager state
   machine with a mocked network: consent gating, checksum rejection that
   preserves the cached pack, retry, remove, and offline reuse. No test here
   may contact a real origin - every fetch is the injected mock. */
const { createIdentifyDatabaseManager } = await import("../../src/lib/identify/identify-database-manager.ts");
const { createMemoryIdentifyPackStore } = await import("../../src/lib/identify/identify-pack-store.ts");
const { sha256Hex } = await import("../../src/lib/identify/sha256-hex.ts");
const { IdentifyDatabaseManagerPanel, setSharedIdentifyDatabaseManagerForTests } =
  await import("../../src/webapp/components/identify-database-manager.tsx");

const PACK_BYTES = new TextEncoder().encode("pack-body").buffer;

const catalogFor = (packSha) => ({
  format: "rom-weaver-identify-catalog-v1",
  generated: { opengoodRevision: "deadbeefcafe0000" },
  platforms: [
    {
      aliases: ["psx"],
      canonicalPlatform: "Sony PlayStation",
      mediaProfiles: ["redump-cd-track-v1"],
      packFormat: "RWFP2",
      packSha256: packSha,
      packSlug: "sony-playstation",
      source: "hasheous",
    },
  ],
});

let root;
let host;

const waitFor = (predicate) => vi.waitUntil(predicate, { interval: 25, timeout: 5000 });
const waitForText = async (text) => {
  try {
    await waitFor(() => host.textContent.includes(text));
  } catch (error) {
    throw new Error(`waiting for "${text}" timed out; DOM read: ${host.textContent}`, { cause: error });
  }
};
const buttonByLabel = (label) => host.querySelector(`button[aria-label="${label}"]`);

const mountPanel = async ({ fetchImpl, store }) => {
  const packSha = await sha256Hex(PACK_BYTES.slice(0));
  const manager = createIdentifyDatabaseManager({
    fetchImpl,
    loadCatalogIndex: async () => ({ catalog: catalogFor(packSha), systems: [] }),
    resolvePackUrl: (entry) => `https://mock.invalid/${entry.fileName}`,
    store,
  });
  setSharedIdentifyDatabaseManagerForTests(manager);
  host = document.createElement("div");
  host.className = "rw-app";
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(IdentifyDatabaseManagerPanel, {}));
  await waitForText("Sony PlayStation");
  return { manager, packSha };
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  setSharedIdentifyDatabaseManagerForTests(undefined);
  localStorage.clear();
});

test("a Hasheous download without consent shows the consent prompt and fetches nothing", async () => {
  const fetchImpl = vi.fn(async () => new Response(PACK_BYTES.slice(0)));
  const store = createMemoryIdentifyPackStore();
  await mountPanel({ fetchImpl, store });
  await waitForText("Not downloaded");

  buttonByLabel("Download the Sony PlayStation identification database").click();
  await waitForText("only database files are downloaded");
  expect(fetchImpl).not.toHaveBeenCalled();

  // Dismissing keeps the gate closed.
  buttonByLabel("Do not allow database downloads").click();
  await waitFor(() => !host.textContent.includes("Allow downloads"));
  expect(fetchImpl).not.toHaveBeenCalled();

  // Granting consent runs the download and stores the verified pack.
  buttonByLabel("Download the Sony PlayStation identification database").click();
  await waitForText("Allow downloads");
  buttonByLabel("Allow database downloads").click();
  await waitForText("Downloaded");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(await store.keys()).toHaveLength(1);
});

test("a checksum failure is rejected, keeps the good cached pack, and retry recovers", async () => {
  let corrupt = true;
  const fetchImpl = vi.fn(async () =>
    corrupt ? new Response(new TextEncoder().encode("evil")) : new Response(PACK_BYTES.slice(0)),
  );
  const store = createMemoryIdentifyPackStore();
  const { packSha } = await mountPanel({ fetchImpl, store });
  // A previously good pack is already cached under the current hash.
  await store.put("sony-playstation.pack", packSha, PACK_BYTES.slice(0));
  localStorage.setItem(
    "rom-weaver-identify-database-v1",
    JSON.stringify({ hasheousConsent: true, identifyDatabaseOrigin: "" }),
  );

  buttonByLabel("Update the Sony PlayStation identification database")?.click();
  // The row shows cached first; force a re-download through the manager path.
  const manager = (
    await import("../../src/webapp/components/identify-database-manager.tsx")
  ).getSharedIdentifyDatabaseManager();
  await manager.refresh();
  await expect(manager.download("sony-playstation")).rejects.toThrow(/checksum/u);
  await waitForText("Failed");
  await waitForText("checksum");
  // The good copy is untouched.
  expect((await store.get("sony-playstation.pack"))?.sha256).toBe(packSha);

  corrupt = false;
  buttonByLabel("Retry the Sony PlayStation identification database").click();
  await waitForText("Downloaded");
});

test("a cached pack lists as downloaded with no fetch, and remove clears it", async () => {
  const fetchImpl = vi.fn(async () => new Response(PACK_BYTES.slice(0)));
  const store = createMemoryIdentifyPackStore();
  const packSha = await sha256Hex(PACK_BYTES.slice(0));
  await store.put("sony-playstation.pack", packSha, PACK_BYTES.slice(0));
  await mountPanel({ fetchImpl, store });
  await waitForText("Downloaded");
  expect(fetchImpl).not.toHaveBeenCalled();

  buttonByLabel("Remove the Sony PlayStation identification database").click();
  await waitForText("Not downloaded");
  expect(await store.keys()).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});
