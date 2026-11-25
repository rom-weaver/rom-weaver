import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { brotliDecompressSync } from "node:zlib";

const [distArgument, archiveArgument] = process.argv.slice(2);
if (!distArgument || !archiveArgument) {
  process.stderr.write("Usage: node scripts/package-webapp-zip.mjs <dist-directory> <output.zip>\n");
  process.exit(2);
}

const dist = path.resolve(distArgument);
const archive = path.resolve(archiveArgument);
const stage = fs.mkdtempSync(path.join(path.dirname(archive), ".webapp-zip-"));
try {
  const files = path.join(stage, "webapp");
  fs.cpSync(dist, files, { recursive: true, filter: (source) => !source.endsWith(".br") });

  // Identify packs and cheat shards can exist only as Brotli sidecars.
  for (const entry of fs.readdirSync(dist, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".br")) continue;
    const source = path.join(entry.parentPath, entry.name);
    const raw = path.join(files, path.relative(dist, source.slice(0, -3)));
    if (fs.existsSync(raw)) continue;
    const compressed = fs.readFileSync(source);
    let decoded;
    try {
      decoded = brotliDecompressSync(compressed);
    } catch (cause) {
      throw new Error(`Cannot decompress ${path.relative(dist, source)}. Rebuild the webapp.`, { cause });
    }
    fs.writeFileSync(raw, decoded);
  }

  const stagedArchive = path.join(stage, "webapp.zip");
  execFileSync("zip", ["-9", "-q", "-r", stagedArchive, "."], { cwd: files, stdio: "inherit" });
  fs.renameSync(stagedArchive, archive);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
