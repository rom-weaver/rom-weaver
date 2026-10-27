import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readReleaseDate } from "./version.mjs";

const GENERATOR = "scripts/gen-third-party-licenses.mjs";
// The Notices page is one fixed template literal in the license generator, so the page changed
// exactly when that literal did. The closing backtick sits alone on its line.
const NOTICES_PAGE_REGEX = /^const WEBAPP_NOTICES_PAGE = `([\s\S]*?)^`;$/m;

export const readNoticesPage = (source) => NOTICES_PAGE_REGEX.exec(source)?.[1] ?? null;

/**
 * The release that last changed the Notices page, as `YYYY-MM-DD`: walk the release tags from
 * the newest while the page text equals the current one, and date the oldest tag it still equals
 * by its changelog entry. Null when the page differs from the newest release (unreleased), when
 * history is shallow or tags are missing, or when that release has no changelog date, so the
 * sitemap omits the date rather than guess.
 * @param {string} cwd repository root
 * @param {string} [changelog] CHANGELOG.md path; defaults to the repository's
 */
export const readNoticesLastmod = (cwd, changelog) => {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") return null;
    const current = readNoticesPage(fs.readFileSync(path.join(cwd, GENERATOR), "utf8"));
    if (current === null) return null;
    const tags = git(["tag", "--list", "v*", "--sort=-v:refname"]).split("\n").filter(Boolean);
    let oldest = null;
    for (const tag of tags) {
      // Tree objects are always present, even in a blobless clone, so an empty listing means the
      // generator did not exist at this tag. Any other failure (a blob that cannot be fetched) is
      // unknown history and throws to the outer catch, which omits the date.
      if (!git(["ls-tree", "--name-only", tag, "--", GENERATOR]).trim()) break;
      const page = readNoticesPage(git(["show", `${tag}:${GENERATOR}`]));
      if (page !== current) break;
      oldest = tag;
    }
    return oldest ? (readReleaseDate(oldest.slice(1), changelog) ?? null) : null;
  } catch {
    return null;
  }
};
