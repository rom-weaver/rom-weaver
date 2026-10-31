// Real drag-and-drop through Chromium's input pipeline (CDP Input.dispatchDragEvent), so the page sees
// trusted `drop` events with real FileSystemEntry objects (files and whole directories). Playwright's
// setInputFiles bypasses the drop handlers entirely and synthetic DataTransfer objects hide bugs that
// depend on entries (File identity differs per read).
import fs from "node:fs";
import path from "node:path";
import { EXH_CACHE } from "./gen.mjs";

/** Drop absolute `paths` (files and/or directories) at a point relative to the first `.drop` zone. */
export async function dropPaths(session, paths, { at = [0.5, 0.5], selector = ".drop" } = {}) {
  const { context, page } = session;
  if (!session.cdp) session.cdp = await context.newCDPSession(page);
  const cdp = session.cdp;
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`drop zone ${selector} has no box`);
  const x = box.x + box.width * at[0];
  const y = box.y + box.height * at[1];
  const target = await page.evaluate(
    ([px, py]) => {
      const element = document.elementFromPoint(px, py);
      return element ? `${element.tagName}.${String(element.className).slice(0, 40)}` : "none";
    },
    [x, y],
  );
  const data = { dragOperationsMask: 1 | 2 | 16, files: paths, items: [] };
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdp.send("Input.dispatchDragEvent", { data, type, x, y });
    await page.waitForTimeout(120);
  }
  return { target };
}

/** Deterministic directory trees used by the folder-drop cases (built once under the exh cache). */
export function dropFixtures({ rom, patch, extra }) {
  const root = path.join(EXH_CACHE, "drop");
  const made = (name, files) => {
    const dir = path.join(root, name);
    if (fs.existsSync(dir)) return dir;
    for (const [rel, bytes] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, bytes);
    }
    return dir;
  };
  return {
    flat: made("flat", { "game.bin": rom, "fix.bps": patch, ".DS_Store": Buffer.from("junk") }),
    nested: made("nested", { "a/b/c/game.bin": rom, "a/patch/fix.bps": patch, "a/.hidden/skip.bin": extra }),
    patchOnly: made("patch-only", { "fix.bps": patch }),
    unicode: made("unicode", { "ゲーム é/game.bin": rom, "ゲーム é/パッチ.bps": patch }),
  };
}
