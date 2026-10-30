// Case catalogue. Each case: { id, group, tags[], title, run(h) } or { skip: "reason" } and throws on failure.
// Oracle order: (1) known target bytes from the independent encoders, (2) native-CLI differential when
// the CLI is built, (3) invariants (no page error, no silent success on a corrupt patch).
import fs from "node:fs";
import path from "node:path";
import { BLOBS, CACHE } from "../fixtures/apply-matrix/generate.mjs";
import { cliApply } from "./lib/cli.mjs";
import { assert, expectDownload, fail, scenario } from "./lib/scenario.mjs";
import { chainCases } from "./cases-chain.mjs";
import { containerCases } from "./cases-containers.mjs";
import { discCases } from "./cases-discs.mjs";
import { featureCases } from "./cases-features.mjs";
import { miscCases } from "./cases-misc.mjs";
import { optionCases } from "./cases-options.mjs";
import { outputCases } from "./cases-output.mjs";

const read = (file) => fs.readFileSync(file);
const stem = (name) => name.replace(/\.[^.]+$/, "");

/** Every patch fixture present in the manifest, with its source and expected target. */
function patchFixtures(manifest) {
  const ready = new Map(manifest.entries.filter((e) => !e.unavailable).map((e) => [e.name, e]));
  const dirOf = (entry) => (entry.dir === "blobs" ? BLOBS : CACHE);
  const out = [];
  for (const entry of ready.values()) {
    const patchRe = /^([a-z0-9]+)-(same|grow|shrink)\.([a-z0-9]+)$/.exec(entry.name);
    if (patchRe && !entry.name.startsWith("target-") && !entry.name.startsWith("hdiff-")) {
      const [, format, variant] = patchRe;
      if (format === "target") continue;
      out.push({
        format,
        name: entry.name,
        patch: path.join(dirOf(entry), entry.name),
        source: path.join(BLOBS, "base.bin"),
        target: path.join(BLOBS, `target-${variant}.bin`),
        variant,
      });
    } else if (entry.name.startsWith("hdiffpatch-")) {
      out.push({
        format: "hdiffpatch",
        name: entry.name,
        patch: path.join(BLOBS, entry.name),
        source: path.join(BLOBS, "hdiff-source.bin"),
        target: path.join(BLOBS, "hdiff-target.bin"),
        variant: entry.name.replace(/^hdiffpatch-|\.[^.]+$/g, ""),
      });
    } else if (entry.name === "ips-noop.ips") {
      out.push({
        format: "ips",
        name: entry.name,
        patch: path.join(BLOBS, entry.name),
        source: path.join(BLOBS, "base.bin"),
        target: path.join(BLOBS, "base.bin"),
        variant: "noop",
      });
    }
  }
  return out;
}

const mutate = {
  empty: () => new Uint8Array(),
  flip: (bytes) => Uint8Array.from(bytes, (b, i) => (i === Math.floor(bytes.length / 2) ? b ^ 0xff : b)),
  magic: (bytes) => Uint8Array.from(bytes, (b, i) => (i < 4 ? b ^ 0x5a : b)),
  trunc: (bytes) => bytes.slice(0, Math.max(1, Math.floor(bytes.length / 2))),
};

export function buildCases({ manifest }) {
  const cases = [];
  const fixtures = patchFixtures(manifest);
  const formats = [...new Set(fixtures.map((f) => f.format))];

  // 1. Every patch fixture applies and reproduces the target byte for byte.
  for (const fx of fixtures) {
    cases.push({
      group: "patch-format",
      id: `apply/${fx.format}/${fx.variant}`,
      tags: [fx.format, "apply", fx.name],
      title: `${fx.name} -> target`,
      async run(h) {
        const out = await scenario(h, { files: [fx.source, fx.patch], shot: "ok" });
        if (fx.format === "mod") {
          // PMSR is defined for Paper Mario USA 1.0 only (40 MiB, CRC32 a7f5cd7e): any other ROM must be
          // refused, as the native CLI does. The 40 MiB stand-in case in group "options" covers success.
          if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
          if (out.outcome === "download") fail(out, "PMSR patch applied to a ROM that is not Paper Mario USA 1.0");
          assert(out.staged.blockedReason || out.staged.notices.length, "refused without a visible reason");
          return `refused as designed (${out.outcome}): ${out.staged.blockedReason ?? out.staged.notices[0]?.text}`;
        }
        expectDownload(out, read(fx.target));
        assert(out.name.endsWith(".bin") || out.name.includes("."), `download name has no extension: ${out.name}`);
        return `${out.name} ${out.bytes.length} B`;
      },
    });
  }

  // 2. Wrong source: bps/ups (and any format with source checksums) must refuse; others have no check.
  const checksumFormats = new Set(["bps", "ups", "rup", "solid", "mod", "ppf", "aps", "apsgba", "pat", "dps", "bdf"]);
  for (const fx of fixtures.filter((f) => f.variant === "same")) {
    cases.push({
      group: "patch-wrongsource",
      id: `wrong-source/${fx.format}`,
      tags: [fx.format, "wrong-source"],
      title: `${fx.name} against other.bin`,
      async run(h) {
        const other = path.join(BLOBS, "other.bin");
        const out = await scenario(h, { files: [other, fx.patch], shot: "wrong" });
        const native = cliApply(other, [fx.patch]);
        if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
        if (native.ok === null) {
          if (checksumFormats.has(fx.format) && out.outcome === "download")
            fail(out, "expected a refusal for a checksum-bearing format");
          return `webapp=${out.outcome} (no native CLI to compare)`;
        }
        const webRefused = out.outcome !== "download";
        // The webapp may block earlier than the CLI (it verifies the staged ROM), never the other way round.
        if (native.ok === false && !webRefused)
          fail(out, `native refuses (${native.stderr}) but the webapp produced a file`);
        if (native.ok === true && out.outcome === "download") expectDownload(out, native.bytes, "output vs native");
        return `webapp=${out.outcome} native=${native.ok ? "ok" : "refused"}`;
      },
    });
    cases.push({
      group: "patch-wrongsource",
      id: `wrong-source-override/${fx.format}`,
      tags: [fx.format, "wrong-source", "override"],
      title: `${fx.name} against other.bin with Apply anyway`,
      async run(h) {
        const other = path.join(BLOBS, "other.bin");
        const out = await scenario(h, {
          files: [other, fx.patch],
          async configure(page) {
            const toggle = page.locator("#rom-weaver-checkbox-checksum-override");
            if (await toggle.count()) await toggle.evaluate((element) => element.click());
            await page.waitForTimeout(500);
          },
          shot: "override",
        });
        const native = cliApply(other, [fx.patch], ["--ignore-checksum-validation"]);
        if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
        if (out.outcome === "download" && native.ok === true)
          expectDownload(out, native.bytes, "override output vs native --ignore-checksum-validation");
        else if (out.outcome !== "download" && native.ok === true)
          fail(out, "override did not let the apply through, native does");
        return `webapp=${out.outcome} native=${native.ok}`;
      },
    });
  }

  // 3. Corrupt patch bytes: never a silent success; webapp and native must agree on accept/reject.
  for (const fx of fixtures.filter((f) => f.variant === "same" || f.format === "hdiffpatch")) {
    if (fx.variant !== "same" && fx.name !== "hdiffpatch-hdiff13-zstd.hdiff") continue;
    for (const kind of Object.keys(mutate)) {
      cases.push({
        group: "patch-corrupt",
        id: `corrupt/${fx.format}/${kind}`,
        tags: [fx.format, "corrupt", kind],
        title: `${fx.name} mutated: ${kind}`,
        async run(h) {
          const ext = path.extname(fx.patch);
          const mutated = Buffer.from(mutate[kind](read(fx.patch)));
          const patchName = `${kind}-${fx.name}`;
          const tmp = path.join(h.caseDir, patchName);
          fs.writeFileSync(tmp, mutated);
          const out = await scenario(h, {
            files: [fx.source, { buffer: mutated, name: `${stem(fx.name)}-${kind}${ext}` }],
            shot: kind,
            applyTimeout: 60_000,
          });
          const native = cliApply(fx.source, [tmp]);
          if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
          if (out.outcome === "timeout") fail(out, "UI never reported an outcome (hang)");
          if (native.ok === null) {
            if (kind === "empty" && out.outcome === "download") fail(out, "empty patch produced a file");
            return `webapp=${out.outcome} (no native CLI)`;
          }
          const webOk = out.outcome === "download";
          if (webOk !== native.ok)
            fail(
              out,
              `webapp ${webOk ? "accepted" : "rejected"} but native ${native.ok ? "accepted" : `rejected (${native.stderr})`}`,
            );
          if (webOk) expectDownload(out, native.bytes, "accepted-corrupt output vs native");
          return `webapp=${out.outcome} native=${native.ok ? "accepted" : "rejected"}`;
        },
      });
    }
  }
  void formats;
  cases.push(
    ...chainCases({ manifest }),
    ...containerCases({ manifest }),
    ...outputCases({ manifest }),
    ...optionCases({ manifest }),
    ...discCases({ manifest }),
    ...miscCases(),
    ...featureCases({ manifest }),
  );
  return cases;
}
