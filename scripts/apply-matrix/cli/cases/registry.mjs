// Cases derived from `rom-weaver formats --json` (the product's own registry): every alias / extension of every
// creatable patch format, every writable container alias, and per-codec level bounds.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { add, check, fail } from "../lib/harness.mjs";
import { filesUnder, needTool, toolIn, toolMust } from "../lib/reference-tools.mjs";

const NAME_EMBEDDING = ["solid", "dps"];

export const register = (env) => {
  if (!env.bin) return;
  const run = spawnSync(env.bin, ["formats", "--json"], { encoding: "utf8" });
  if (run.status !== 0) {
    add("registry.formats-json-available", ["registry"], () => fail(`formats --json failed: ${run.stderr}`));
    return;
  }
  const registry = JSON.parse(run.stdout);
  const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const creatable = registry.patches.filter((p) => p.create);
  const levelBounds = new Map(registry.codecs.map((c) => [c.name, c]));

  add("registry.every-creatable-patch-format-has-roundtrip-cases", ["registry"], (ctx) => {
    const covered = new Set(["ips", "ips32", "solid", "bps", "ups", "vcdiff", "xdelta", "gdiff", "aps", "apsgba", "rup", "ppf", "pat", "ebp", "bdf", "dps", "mod", "dldi"]);
    const missing = creatable.map((p) => slug(p.name).split("-")[0]).filter((n) => !covered.has(n));
    check(missing.length === 0, () => `registry lists creatable patch formats without create.* cases: ${missing.join(", ")}`);
    check(ctx.exists(env.bin), "binary");
  });

  const rom = (ctx) => ({ o: ctx.fx("rom/base.bin"), m: ctx.fx("rom/same.bin") });
  for (const patch of creatable) {
    const canonical = patch.extensions[0];
    const base = slug(patch.name);
    const names = base.split("-")[0];
    if (names === "dldi") continue; // needs a DLDI slot; covered by create.dldi.*
    const applyFlags = names === "mod" ? ["--ignore-checksum-validation"] : [];
    const roundTrip = (ctx, patchFile, createExtra, label) => {
      const { o, m } = rom(ctx);
      ctx.ok(ctx.run(["patch", "create", "--original", o, "--modified", m, "--output", patchFile, ...createExtra]), `create ${label}`);
      const out = ctx.tmp("out.bin");
      ctx.ok(ctx.apply(o, patchFile, out, applyFlags), `apply ${label}`);
      ctx.same(out, m, label);
    };
    for (const ext of patch.extensions) {
      add(`registry.patch.${base}.extension${ext}`, ["registry", "create", base], (ctx) => {
        roundTrip(ctx, ctx.tmp(`p${ext}`), [], `${patch.name} via ${ext}`);
      });
    }
    for (const alias of patch.aliases) {
      add(`registry.patch.${base}.alias-${alias}`, ["registry", "create", base], (ctx) => {
        const { o, m } = rom(ctx);
        const viaAlias = ctx.tmp(`a/p${canonical}`);
        const viaExt = ctx.tmp(`b/p${canonical}`);
        ctx.ok(ctx.run(["patch", "create", "--original", o, "--modified", m, "--output", viaAlias, "-f", alias]), `-f ${alias}`);
        ctx.ok(ctx.run(["patch", "create", "--original", o, "--modified", m, "--output", viaExt]), "by extension");
        if (NAME_EMBEDDING.includes(names)) return;
        check(fs.readFileSync(viaAlias).equals(fs.readFileSync(viaExt)), `-f ${alias} differs from the ${canonical} output`);
      });
      add(`registry.patch.${base}.alias-${alias}.uppercase`, ["registry", "create", base], (ctx) => {
        const { o, m } = rom(ctx);
        const out = ctx.tmp(`u/p${canonical}`);
        ctx.ok(ctx.run(["patch", "create", "--original", o, "--modified", m, "--output", out, "-f", alias.toUpperCase()]), `-f ${alias.toUpperCase()}`);
      });
    }
    add(`registry.patch.${base}.uppercase-extension`, ["registry", "create", base], (ctx) => {
      roundTrip(ctx, ctx.tmp(`p${canonical.toUpperCase()}`), [], `${patch.name} via ${canonical.toUpperCase()}`);
    });
    add(`registry.patch.${base}.dotted-name-with-extra-dots`, ["registry", "create", base], (ctx) => {
      roundTrip(ctx, ctx.tmp(`my.hack.v1.2.final${canonical}`), [], `${patch.name} via multi-dot name`);
    });
  }

  // apply-only registry formats must refuse `patch create`
  for (const patch of registry.patches.filter((p) => !p.create)) {
    const base = slug(patch.name);
    add(`registry.patch.${base}.create-is-rejected`, ["registry", "create", "negative"], (ctx) => {
      const { o, m } = rom(ctx);
      const flag = patch.aliases[0] ?? slug(patch.name).split("-")[0];
      const out = ctx.tmp(`p${patch.extensions[0] ?? ".x"}`);
      const result = ctx.run(["patch", "create", "--original", o, "--modified", m, "--output", out, "-f", flag]);
      ctx.failed(result, { what: `create -f ${flag}` });
      check(!ctx.exists(out), "left a patch");
    });
  }

  // ---- container formats: writable ones accept their aliases, the rest are rejected as outputs
  for (const container of registry.containers) {
    const base = slug(container.name);
    if (!container.create) {
      for (const label of [container.name, ...container.aliases]) {
        add(`registry.container.${base}.not-writable.${slug(label)}`, ["registry", "compress", "negative"], (ctx) => {
          const input = ctx.fx("rom/base.bin");
          const out = ctx.tmp("o.out");
          const result = ctx.run(["compress", "--input", input, "--output", out, "-f", label]);
          if (result.code === 0) {
            // A registered but read-only format that silently produces output would be a registry/CLI mismatch.
            fail(`compress -f ${label} (create:false in the registry) exited 0 and wrote ${ctx.exists(out) ? fs.statSync(out).size : 0} bytes`);
          }
          ctx.failed(result, { what: `compress -f ${label}` });
          check(!ctx.exists(out), "left an output");
        });
      }
      continue;
    }
    for (const alias of [container.name, ...container.aliases]) {
      add(`registry.container.${base}.alias-${slug(alias)}`, ["registry", "compress", base], (ctx) => {
        const inputs = {
          zip: ctx.fx("rom/base.bin"),
          "7z": ctx.fx("rom/base.bin"),
          chd: ctx.fx("exh/cd/data.cue"),
          rvz: ctx.fx("reference/gc/disc.iso"),
          z3ds: ctx.fx("exh/ctr/game.3ds"),
        };
        ctx.fx("exh/cd/data.bin");
        const input = inputs[container.name];
        const out = ctx.tmp("o.out");
        const result = ctx.run(["compress", "--input", input, "--output", out, "-f", alias, "--level", "min"]);
        if (result.code !== 0) {
          ctx.failed(result, { what: `compress -f ${alias}` });
          check(!ctx.exists(out), "failed run left output");
          ctx.note(`compress -f ${alias} (${container.name} alias) rejected: ${ctx.describe(result)}`);
          if (alias === container.name || ["7zip", "3ds"].includes(alias)) fail(`compress -f ${alias} failed: ${ctx.describe(result)}`);
          return;
        }
        const ex = ctx.tmp("ex");
        ctx.ok(ctx.run(["extract", "--input", out, "--output", ex, "--no-ignore"]), `extract the ${alias} result`);
        check(filesUnder(ex).length >= 1, "nothing extracted");
      });
    }
    // ---- codec level bounds (valid at min/max, rejected one beyond)
    for (const codec of container.codecs) {
      const bounds = levelBounds.get(codec);
      if (!bounds || bounds.minLevel === null) continue;
      const input = (ctx) => {
        if (container.name === "zip" || container.name === "7z") return ctx.fx("rom/base.bin");
        if (container.name === "rvz") return ctx.fx("reference/gc/disc.iso");
        if (container.name === "z3ds") return ctx.fx("exh/ctr/game.3ds");
        ctx.fx("exh/cd/data.bin");
        return codec.startsWith("cd") ? ctx.fx("exh/cd/data.cue") : ctx.fx("exh/dvd/dvd.iso");
      };
      for (const [which, level, valid] of [["min", bounds.minLevel, true], ["max", bounds.maxLevel, true], ["below-min", bounds.minLevel - 1, false], ["above-max", bounds.maxLevel + 1, false]]) {
        add(`registry.codec-level.${base}.${codec}.${which}`, ["registry", "compress", "levels", base, codec], (ctx) => {
          if (container.name === "chd" && ["avhuff"].includes(codec)) return;
          const out = ctx.tmp(`o.${container.extensions[0].slice(1)}`);
          const result = ctx.run(["compress", "--input", input(ctx), "--output", out, "--codec", `${codec}:${level}`]);
          if (valid) {
            ctx.ok(result, `${codec}:${level}`);
            const ex = ctx.tmp("ex");
            ctx.ok(ctx.run(["extract", "--input", out, "--output", ex, "--no-ignore"]), `extract ${codec}:${level}`);
            check(filesUnder(ex).length >= 1, "nothing extracted");
            if (container.name === "chd") {
              needTool("chdman");
              if (codec !== "store") toolMust(toolIn(ctx)("chdman", ["verify", "-i", out]), `chdman verify ${codec}:${level}`);
            }
          } else {
            ctx.failed(result, { what: `${codec}:${level} (outside the registry's ${bounds.minLevel}..${bounds.maxLevel})` });
            check(!ctx.exists(out), "failed run left output");
          }
        });
      }
    }
  }

};
