import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "../../src/webapp/design-system/index.css";
import "../../src/webapp/design-system/deferred.css";

/* Drives the EXTENDED identify result states through the real DOM: the quality
   badge, the source/pack-format evidence, platform candidates, component
   evidence, and the actionable database_required condition (distinct from a
   plain "no match"). The identify pipeline itself is mocked. */
const { identifyRom } = vi.hoisted(() => ({ identifyRom: vi.fn() }));
vi.mock("../../src/platform/browser/browser-api.ts", () => ({ identifyRom }));

const { createIdentifyDatabaseManager } = await import("../../src/lib/identify/identify-database-manager.ts");
const { setSharedIdentifyDatabaseManagerForTests } =
  await import("../../src/webapp/components/identify-database-manager.tsx");
const { IdentifyForm } = await import("../../src/webapp/components/identify-form.tsx");

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

const mountIdentifyForm = async () => {
  // Keep the embedded manager off the network: its catalog loader is a stub.
  setSharedIdentifyDatabaseManagerForTests(
    createIdentifyDatabaseManager({ loadCatalogIndex: async () => ({ systems: [] }) }),
  );
  host = document.createElement("div");
  host.className = "rw-app";
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(IdentifyForm, {}));
  await waitFor(() => host.querySelector("#identify-input-picker"));
};

const runIdentify = async (result) => {
  identifyRom.mockResolvedValue(result);
  const file = new File([new Uint8Array([1, 2, 3])], "game.bin");
  const input = host.querySelector("#identify-input-picker");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => [...host.querySelectorAll("button")].some((button) => /Identify ROM/u.test(button.textContent)));
  [...host.querySelectorAll("button")].find((button) => /Identify ROM/u.test(button.textContent)).click();
};

beforeEach(() => {
  identifyRom.mockReset();
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  setSharedIdentifyDatabaseManagerForTests(undefined);
});

test("database_required renders as an actionable state with the manager action", async () => {
  await mountIdentifyForm();
  await runIdentify({
    candidates: [
      {
        checksums: { crc32: "abcd1234" },
        checksumVariants: [],
        condition: "database_required",
        detectedPlatform: "Sony PlayStation",
        hint: "Identifying Sony PlayStation ROMs needs the Sony PlayStation database.",
        matches: [],
        path: "game.bin",
        status: "unknown",
      },
    ],
    condition: "database_required",
    hint: "Identifying Sony PlayStation ROMs needs the Sony PlayStation database.",
    input: "game.bin",
    status: "unknown",
  });
  await waitForText("Database required");
  await waitForText("needs the Sony PlayStation database");
  const openManager = host.querySelector('button[aria-label="Open the identification database manager"]');
  expect(openManager).toBeTruthy();
  // The plain no-match copy must NOT show for the structured condition.
  expect(host.textContent.includes("No exact title match found")).toBe(false);
});

test("quality, source, platform candidates, and component evidence render on a match", async () => {
  await mountIdentifyForm();
  await runIdentify({
    candidates: [
      {
        checksums: { crc32: "abcd1234" },
        checksumVariants: [],
        database: { packFormat: "RWFP2", source: "hasheous" },
        evidence: { layoutMatched: true, requiredComponentsMatched: 3, requiredComponentsTotal: 4 },
        matches: [
          {
            algorithm: "crc32",
            database: "sony-playstation.pack",
            name: "Example Game (USA)",
            platform: "Sony PlayStation",
            variant: "raw",
          },
        ],
        path: "game.bin",
        platformCandidates: [{ confidence: "certain", evidence: "system_area_magic", platform: "Sony PlayStation" }],
        quality: "partial",
        status: "matched",
      },
    ],
    input: "game.bin",
    status: "matched",
  });
  await waitForText("Partial match");
  // The identify drawer carries the extended evidence.
  const summary = [...host.querySelectorAll("summary, button")].find((el) => /Identify/u.test(el.textContent || ""));
  summary?.click();
  await waitForText("Hasheous");
  await waitForText("RWFP2");
  await waitForText("3 of 4 required components matched");
  await waitForText("system_area_magic");
});
