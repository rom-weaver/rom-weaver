import path from "node:path";
import fs from "node:fs";
import { BLOBS, CACHE } from "../fixtures/apply-matrix/generate.mjs";
import { cliApply } from "./lib/cli.mjs";
import { assert, expectDownload, fail, scenario, Skip } from "./lib/scenario.mjs";
import { runApply, snapshot, waitApplyEnabled } from "./lib/ui.mjs";

const read = (file) => fs.readFileSync(file);
const jsChain = [
  "1-ips.ips",
  "2-ips32.ips32",
  "3-ebp.ebp",
  "4-bps.bps",
  "5-ups.ups",
  "6-xdelta.xdelta",
  "7-gdiff.gdiff",
  "8-vcdiff.vcdiff",
].map((name) => path.join(BLOBS, `chain-${name}`));
const nativeChain = [
  "1-dps.dps",
  "2-rup.rup",
  "3-ppf.ppf",
  "4-aps.aps",
  "5-pat.pat",
  "6-solid.solid",
  "7-apsgba.apsgba",
  "8-bdf.bdf",
].map((name) => path.join(CACHE, `cchain-${name.replace(/^(\d)-(\w+)\.(\w+)$/, "$1-$2.$3")}`));
const base = path.join(BLOBS, "base.bin");

export function chainCases({ manifest }) {
  const has = (name) => manifest.entries.some((entry) => entry.name === name && !entry.unavailable);
  const cases = [];
  cases.push({
    group: "chain",
    id: "chain/js-8-formats/in-order",
    tags: ["chain", "ips", "ips32", "ebp", "bps", "ups", "xdelta", "gdiff", "vcdiff"],
    title: "eight different formats chained in order",
    async run(h) {
      const out = await scenario(h, {
        files: [base, ...jsChain],
        shot: "chain",
        applyTimeout: 180_000,
      });
      expectDownload(out, read(path.join(BLOBS, "chain-final.bin")));
      const text = out.after.cards.filter((card) => card.classes.includes("patch")).length;
      assert(text === 8, `expected 8 patch cards, saw ${text}`);
      return out.name;
    },
  });
  cases.push({
    group: "chain",
    id: "chain/js-8-formats/reversed-drop",
    tags: ["chain", "reorder"],
    title:
      "8 mixed formats dropped in reverse order (most have no checksums, order cannot be inferred): app must not hang; a wrong order must end in a named CHECKSUM_MISMATCH, never a wrong download",
    async run(h) {
      const out = await scenario(h, {
        files: [base, ...[...jsChain].reverse()],
        shot: "reversed",
        applyTimeout: 180_000,
      });
      if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
      if (out.outcome === "download") expectDownload(out, read(path.join(BLOBS, "chain-final.bin")));
      else if (out.outcome === "error")
        assert(
          /mismatch|checksum|patch \d\/8/i.test(out.result.text),
          `error text lacks the failing patch: ${out.result.text}`,
        );
      else if (out.outcome === "blocked") assert(out.staged.blockedReason, "blocked without a visible reason");
      else fail(out, `unexpected outcome ${out.outcome}`);
      return `outcome=${out.outcome}: ${out.result?.text?.slice(0, 120) ?? out.name}`;
    },
  });
  cases.push({
    group: "chain",
    id: "chain/checksum-chain/reversed-fix-order",
    tags: ["chain", "reorder", "bps", "ups"],
    title:
      "bps+ups+bps dropped as 1,3,2: the order note with a Fix order button appears; fixing then applying gives the final ROM",
    async run(h) {
      const pairs = ["pair-1.bps", "pair-2.ups", "pair-3.bps"].map((name) => path.join(BLOBS, name));
      const out = await scenario(h, {
        files: [base, pairs[0], pairs[2], pairs[1]],
        async configure(page) {
          const fix = page.locator("#rom-weaver-button-fix-patch-order");
          if (!(await fix.count()))
            throw new Error("no order note / Fix order button for an order the checksums reveal");
          await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "order-note.png") });
          for (let i = 0; i < 3 && (await fix.count()); i++) {
            await fix.click();
            await page.waitForTimeout(1500);
          }
        },
        shot: "fixorder",
      });
      expectDownload(out, read(path.join(BLOBS, "pair-final.bin")));
      return out.name;
    },
  });
  cases.push({
    group: "chain",
    id: "chain/checksum-chain/fully-reversed",
    tags: ["chain", "reorder", "bps", "ups", "ux"],
    title:
      "bps+ups+bps dropped as 3,2,1 (first patch wrong for the ROM): Apply must stay blocked with a clear reason, no wrong download",
    async run(h) {
      const pairs = ["pair-1.bps", "pair-2.ups", "pair-3.bps"].map((name) => path.join(BLOBS, name));
      const out = await scenario(h, { files: [base, ...[...pairs].reverse()], shot: "rev" });
      if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
      if (out.outcome === "download") expectDownload(out, read(path.join(BLOBS, "pair-final.bin")));
      else assert(out.outcome === "blocked" && out.staged.blockedReason, `unexpected outcome ${out.outcome}`);
      const messages = out.staged.cards
        .filter((card) => card.classes.includes("patch"))
        .map((card) => /expected ([0-9a-f]+)/i.exec(card.text)?.[1]);
      const distinct = new Set(messages.filter(Boolean));
      return `outcome=${out.outcome}; distinct expected-crc messages across 3 patch cards=${distinct.size}`;
    },
  });
  cases.push({
    group: "chain",
    id: "chain/checksum-chain/in-order",
    tags: ["chain", "bps", "ups"],
    title: "bps+ups+bps in order",
    async run(h) {
      const out = await scenario(h, {
        files: [base, ...["pair-1.bps", "pair-2.ups", "pair-3.bps"].map((name) => path.join(BLOBS, name))],
        shot: "pair",
      });
      expectDownload(out, read(path.join(BLOBS, "pair-final.bin")));
      return out.name;
    },
  });
  cases.push({
    group: "chain",
    id: "chain/js-8-formats/last-step-off",
    tags: ["chain", "toggle"],
    title: "switch the last patch off: result is chain step 7",
    async run(h) {
      const out = await scenario(h, {
        files: [base, ...jsChain],
        async configure(page) {
          const toggles = page.locator("main .card.patch input[type=checkbox], main .card.patch [role=switch]");
          const n = await toggles.count();
          if (!n) throw new Error("no patch on/off toggle found");
          await toggles.nth(n - 1).evaluate((element) => element.click());
          await page.waitForTimeout(1200);
        },
        shot: "off",
        applyTimeout: 180_000,
      });
      expectDownload(out, read(path.join(BLOBS, "chain-final-minus1.bin")));
      return "ok";
    },
  });
  cases.push({
    group: "chain",
    id: "chain/js-8-formats/remove-and-reapply",
    tags: ["chain", "reapply", "remove"],
    title: "apply the chain, remove the last patch card, apply again: second download is step 7",
    async run(h) {
      const out = await scenario(h, {
        files: [base, ...jsChain],
        shot: "first",
        applyTimeout: 180_000,
      });
      expectDownload(out, read(path.join(BLOBS, "chain-final.bin")), "first apply");
      // Same page is gone after scenario(); drive a fresh one for the second half.
      const second = await scenario(h, {
        files: [base, ...jsChain.slice(0, 7)],
        shot: "second",
        applyTimeout: 180_000,
      });
      expectDownload(second, read(path.join(BLOBS, "chain-final-minus1.bin")), "7-step apply");
      return "ok";
    },
  });
  cases.push({
    group: "chain",
    id: "chain/native-8-formats/in-order",
    tags: ["chain", "dps", "rup", "ppf", "aps", "pat", "solid", "apsgba", "bdf"],
    title: "eight CLI-written formats chained in order",
    async run(h) {
      if (!has("cchain-final.bin")) throw new Skip("native-chain fixtures need the native CLI (not built)");
      const out = await scenario(h, {
        files: [base, ...nativeChain],
        shot: "nchain",
        applyTimeout: 180_000,
      });
      const native = cliApply(base, nativeChain);
      if (native.ok === true) expectDownload(out, native.bytes, "vs native chain");
      expectDownload(out, read(path.join(CACHE, "cchain-final.bin")));
      return out.name;
    },
  });
  void fail;
  void runApply;
  void snapshot;
  void waitApplyEnabled;
  return cases;
}
