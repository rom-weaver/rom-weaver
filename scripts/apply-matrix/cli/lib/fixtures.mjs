// Fixture registry: lazily (re)generates every fixture the matrix uses and keeps manifest.json honest.
//
// Locations
//   repo   tests/fixtures/apply-matrix/        small, byte-deterministic, produced by independent encoders
//   cache  ~/.cache/agents/apply-matrix-fixtures/   tool-generated (system zip/xz/..., or the rom-weaver binary)
//   ext    existing repo fixtures reused in place (never copied)
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class Fixtures {
  constructor({ root, repoDir, cacheDir, manifestPath, run, quiet }) {
    this.root = root;
    this.repoDir = repoDir;
    this.cacheDir = cacheDir;
    this.manifestPath = manifestPath;
    this.run = run; // (args) => {code, all}  -- runs the rom-weaver binary
    this.quiet = quiet;
    this.specs = new Map();
    this.built = new Map();
    this.manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { fixtures: [] };
    this.drift = [];
  }

  define(name, spec) {
    this.specs.set(name, spec);
  }
  names() {
    return [...this.specs.keys()];
  }
  has(name) {
    return this.specs.has(name) || name.startsWith("ext:");
  }

  location(name) {
    if (name.startsWith("ext:")) return path.join(this.root, name.slice(4));
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`unknown fixture ${name}`);
    return path.join(spec.where === "cache" ? this.cacheDir : this.repoDir, name);
  }

  /** Absolute path of the fixture, generating it first when missing. */
  path(name) {
    const target = this.location(name);
    if (name.startsWith("ext:")) {
      if (!fs.existsSync(target)) throw new Error(`existing fixture missing: ${target}`);
      return target;
    }
    if (this.built.has(name)) return target;
    const spec = this.specs.get(name);
    const selfHeal = spec.where !== "cache" && spec.deterministic !== false; // cheap, in-memory: always compare
    if (selfHeal || !fs.existsSync(target)) {
      const data = spec.build(this);
      const stale = selfHeal && fs.existsSync(target) && !Buffer.from(data).equals(fs.readFileSync(target));
      if (!this.quiet && (stale || !fs.existsSync(target))) console.error(`[fixtures] ${stale ? "regenerating stale" : "generating"} ${name}`);
      if (data !== undefined && (stale || !fs.existsSync(target))) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
      } else if (!fs.existsSync(target)) throw new Error(`fixture ${name} builder did not produce a file`);
    }
    this.built.set(name, true);
    const sha = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    const recorded = this.manifest.fixtures.find((entry) => entry.name === name && entry.location === (spec.where ?? "repo"));
    if (recorded && recorded.sha256 !== sha && spec.deterministic !== false) this.drift.push({ name, expected: recorded.sha256, actual: sha });
    return target;
  }

  bytes(name) {
    return fs.readFileSync(this.path(name));
  }

  /** Rewrite manifest.json from the currently built fixtures (plus any existing entries not rebuilt). */
  writeManifest({ builtOnly = false } = {}) {
    const entries = [];
    for (const [name, spec] of [...this.specs].sort(([a], [b]) => a.localeCompare(b))) {
      const target = this.location(name);
      if (!fs.existsSync(target)) {
        const old = this.manifest.fixtures.find((entry) => entry.name === name);
        if (old && !builtOnly) entries.push(old);
        continue;
      }
      const data = fs.readFileSync(target);
      entries.push({
        name,
        location: spec.where ?? "repo",
        purpose: spec.purpose,
        how: spec.how,
        deterministic: spec.deterministic !== false,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
    }
    const manifest = {
      note: "Regenerate with: node scripts/apply-matrix/cli/run.mjs --gen-fixtures --update-manifest. location=repo files live under tests/fixtures/apply-matrix/, location=cache files under ~/.cache/agents/apply-matrix-fixtures/ (override with APPLY_MATRIX_CACHE). deterministic=false entries come from external tools or the rom-weaver binary, so their sha256 is informational and is not enforced.",
      fixtures: entries,
    };
    fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    fs.writeFileSync(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return entries.length;
  }
}
