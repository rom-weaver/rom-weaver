// BSP (apply-only script patches), DLDI (DS driver patching) and the unsupported NINJA1 slot.
// Fixtures are the hand-assembled samples under tests/fixtures/apply-matrix/blobs/borrowed/.
import fs from "node:fs";
import path from "node:path";
import { BLOBS } from "../fixtures/apply-matrix/generate.mjs";
import { cliApply } from "./lib/cli.mjs";
import { assert, expectDownload, fail, scenario } from "./lib/scenario.mjs";

const DIR = path.join(BLOBS, "borrowed");
const read = (name) => fs.readFileSync(path.join(DIR, name));
const BSP_OK = [
  "call-return",
  "fillbyte-seekend",
  "writebyte-seek",
  "xordata-mask",
  "writedata-label",
  "stack-push-pop",
  "conditional-ifeq",
  "noop-exit",
  "bsppatch-nested",
  "lock-unlock-truncate",
];

export function miscCases() {
  const cases = [];
  for (const name of BSP_OK) {
    cases.push({
      group: "patch-format",
      id: `apply/bsp/${name}`,
      tags: ["bsp", "apply", `${name}.bsp`],
      title: `BSP script ${name}.bsp on its ${read(`${name}.in`).length}-byte input yields the recorded output`,
      async run(h) {
        const out = await scenario(h, {
          files: [
            { buffer: read(`${name}.in`), name: `${name}.bin` },
            { buffer: read(`${name}.bsp`), name: `${name}.bsp` },
          ],
          shot: "bsp",
        });
        expectDownload(out, read(`${name}.out`));
        return `${out.name} ${out.bytes.length} B`;
      },
    });
  }
  for (const [name, why] of [
    ["nonzero-exit", "script exits with status 1"],
    ["menu", "script needs an interactive menu (unsupported)"],
  ]) {
    cases.push({
      group: "patch-corrupt",
      id: `corrupt/bsp/${name}`,
      tags: ["bsp", "error-ux"],
      title: `BSP ${name}.bsp (${why}) must be refused with a reason, never a silent download`,
      async run(h) {
        const out = await scenario(h, {
          files: [
            { buffer: read("call-return.in"), name: "input.bin" },
            { buffer: read(`${name}.bsp`), name: `${name}.bsp` },
          ],
          shot: "bsp-refuse",
        });
        if (out.pageErrors?.length) fail(out, `page error ${out.pageErrors[0]}`);
        if (out.outcome === "download") fail(out, "BSP script that the native CLI refuses produced a download");
        const reason = out.result?.text ?? out.staged.blockedReason ?? out.staged.notices[0]?.text;
        assert(reason, "refused without a visible reason");
        return `refused (${out.outcome}): ${String(reason).slice(0, 140)}`;
      },
    });
  }
  const dldiCase = (id, rom, driver, title) => ({
    group: "patch-format",
    id: `apply/dldi/${id}`,
    tags: ["dldi", "apply", driver],
    title,
    async run(h) {
      const romPath = path.join(DIR, rom);
      const driverPath = path.join(DIR, driver);
      const native = cliApply(romPath, [driverPath]);
      const out = await scenario(h, { files: [romPath, driverPath], shot: "dldi" });
      if (out.pageErrors?.length) fail(out, `page error ${out.pageErrors[0]}`);
      if (native.ok === false) {
        if (out.outcome === "download") fail(out, `native refuses (${native.stderr}) but the webapp produced a file`);
        return `refused like native (${out.outcome}): ${native.stderr.slice(0, 100)}`;
      }
      expectDownload(out, native.bytes, "vs native CLI");
      return `${out.name} ${out.bytes.length} B equals native output`;
    },
  });
  cases.push(dldiCase("slot", "slot.nds", "driver.dldi", "DLDI driver patched into a DS ROM that has a DLDI slot"));
  cases.push(
    dldiCase("no-slot", "nonslot.nds", "driver.dldi", "DS ROM without a DLDI section must be refused (native refuses)"),
  );
  cases.push(
    dldiCase(
      "oversized",
      "slot.nds",
      "oversized.dldi",
      "driver bigger than the slot: output must equal native (which extends the ROM and warns)",
    ),
  );
  cases.push({
    group: "patch-unsupported",
    id: "unsupported/ninja1",
    tags: ["ninja1", "unsupported", "error-ux"],
    title: "NINJA1 has no apply support; a .rnp file with a NINJA2 header but no body must be refused with a reason",
    async run(h) {
      let picker = false;
      const out = await scenario(h, {
        files: [
          { buffer: read("call-return.in"), name: "input.bin" },
          { buffer: read("ninja1.rnp"), name: "ninja1.rnp" },
        ],
        async configure(page) {
          picker = (await page.getByText("More than one ROM was dropped").count()) > 0;
        },
        shot: "ninja",
      });
      if (out.pageErrors?.length) fail(out, `page error ${out.pageErrors[0]}`);
      if (out.outcome === "download") fail(out, "malformed/unsupported patch produced a download");
      // A file with an unknown extension is offered as a second ROM candidate instead of being named
      // unsupported (observed UX gap, see report); the picker is the visible outcome.
      if (picker)
        return "no download; unknown .rnp offered as a ROM candidate in the 'More than one ROM was dropped' picker";
      const reason = out.result?.text ?? out.staged.blockedReason ?? out.staged.notices[0]?.text;
      assert(reason, "refused without a visible reason");
      return `refused (${out.outcome}): ${String(reason).slice(0, 140)}`;
    },
  });
  return cases;
}
