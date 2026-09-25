import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveIdentifyPackGroups } from "../../../../scripts/identify-pack-groups.mjs";
import { repoRoot } from "./paths.mjs";

const identifyDataDir = path.join(repoRoot, "crates", "rom-weaver-cli", "data", "identify", "v1");
const identifyDataIndex = JSON.parse(fs.readFileSync(path.join(identifyDataDir, "index.json"), "utf8"));
// Packs and cheat shards ship only as `.br` sidecars; the license text is
// inlined into the attribution bundle instead of served as an asset.
// The two manifests carry the content hash every pack, shard, router, and title
// index is fetched with, so a stale manifest would hide a newer data set. They are
// content-addressed like every emitted bundle: the hash goes in the file name, the
// bundle imports that name through `__IDENTIFY_MANIFEST_FILES__`, and a build with
// new data changes both. That keeps the whole of /assets/* immutable.
const identifyManifestFile = (name) => {
  const [stem, extension] = name.split(".");
  const hash = createHash("sha256")
    .update(fs.readFileSync(path.join(identifyDataDir, name)))
    .digest("hex");
  return `identify-${stem}-${hash.slice(0, 16)}.${extension}`;
};
export const identifyManifestFiles = {
  catalog: fs.existsSync(path.join(identifyDataDir, "catalog.json")) ? identifyManifestFile("catalog.json") : null,
  index: identifyManifestFile("index.json"),
};
export const identifyDataSources = Object.fromEntries(
  fs
    .readdirSync(identifyDataDir)
    .filter((name) => {
      if (name.endsWith(".pack")) return false;
      if (name.startsWith("cheats-") && name.endsWith(".json")) return false;
      return name !== identifyDataIndex.sources?.libretro?.licenseFile;
    })
    .map((name) => {
      const assetName = { "catalog.json": identifyManifestFiles.catalog, "index.json": identifyManifestFiles.index }[
        name
      ];
      return [`/assets/${assetName ?? `identify-${name}`}`, path.join(identifyDataDir, name)];
    }),
);
const identifyPackGroups = resolveIdentifyPackGroups(identifyDataIndex);
const identifyPackEntry = (system) => ({
  sha256: system.sha256,
  sizeBytes: system.rawBytes || 0,
  url: `assets/identify-${system.file}?sha256=${system.sha256}`,
});
// A cheat shard installs with the group that owns its platform's pack, so the
// Settings toggle, the warm-up and `install-group` all carry cheats along.
const identifyCheatEntriesForSlugs = (slugs) =>
  (identifyDataIndex.cheats ?? []).filter((entry) => slugs.includes(entry.slug)).map(identifyPackEntry);
// Default packs are downloaded by the background warm-up rather than precached:
// they are three quarters of what a first visit would otherwise pull down, and
// an identify run fetches whatever it needs on demand long before the warm-up
// reaches it. `required` marks the group as never opt-out.
// The checksum router rides with the default packs: cached by the same warm-up,
// fetched on demand before that, and never part of the install-time precache.
const identifyChecksumRouterEntries = identifyDataIndex.checksumRoutes
  ? [identifyPackEntry(identifyDataIndex.checksumRoutes)]
  : [];
// The title index rides with the default packs for the same reason as the
// router: the cross-platform name search needs it before any pack is loaded.
const identifyTitleIndexEntries = identifyDataIndex.titleIndex ? [identifyPackEntry(identifyDataIndex.titleIndex)] : [];
const identifyDefaultPackGroup = {
  id: "default",
  label: "Built-in systems",
  packs: [
    ...identifyPackGroups.defaultSystems.map(identifyPackEntry),
    ...identifyCheatEntriesForSlugs(identifyPackGroups.defaultSystems.map((system) => system.slug)),
    ...identifyChecksumRouterEntries,
    ...identifyTitleIndexEntries,
  ],
  required: true,
};
export const identifyOptionalPackGroups = [
  identifyDefaultPackGroup,
  ...identifyPackGroups.groups
    .filter((group) => !group.default)
    .map((group) => ({
      id: group.id,
      label: group.label,
      packs: [
        ...group.systems.map((slug) => {
          const system = identifyDataIndex.systems.find((candidate) => candidate.slug === slug);
          if (!system) throw new Error(`identify group ${group.id} names unknown system ${slug}`);
          return identifyPackEntry(system);
        }),
        ...identifyCheatEntriesForSlugs(group.systems),
      ],
    })),
];
