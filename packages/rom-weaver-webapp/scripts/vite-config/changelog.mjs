import fs from "node:fs";
import path from "node:path";
import { getChangelog } from "../version.mjs";

// The "What's new" changelog, emitted at the dist root so it stays OUT of the SW
// precache globs (assets/** + named files only). The client fetches it with
// cache: "no-store", so a pending update surfaces the NEW deploy's log rather
// than the stale precached copy the running (old) bundle shipped with.
const CHANGELOG_ASSET_URL = "/changelog.json";

export const serveChangelogAsset = (releaseVersion) => {
  const middleware = (req, res, next) => {
    if ((req.url ? req.url.split("?")[0] : "") !== CHANGELOG_ASSET_URL) {
      next();
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(getChangelog(50, releaseVersion)));
  };
  return {
    apply: "serve",
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    name: "rom-weaver-changelog-serve",
  };
};

export const writeChangelog = (distDir, releaseVersion) => {
  fs.writeFileSync(path.join(distDir, "changelog.json"), JSON.stringify(getChangelog(50, releaseVersion)));
};
