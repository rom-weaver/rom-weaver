import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Marked } from "marked";
import { DOCS_SCREENSHOT_NAMES } from "./docs-screenshot-manifest.mjs";
import { DOC_SOURCES, SAMPLE_URL_PATTERN, SITE_ORIGIN, siteSamplePath } from "../src/webapp/docs-routing.mjs";

const repositoryOrigin = "https://github.com/rom-weaver/rom-weaver/blob/main";

// Links point at `siteOrigin`, the deployment that serves the file. The
// Canonical line stays on production: it names the page, not where this copy lives.
export function createDocsMarkdown(source, markdown, siteOrigin = SITE_ORIGIN) {
  const resolveHref = (href, type) => {
    const absolute = /^https?:\/\//i.test(href) && URL.canParse(href) ? new URL(href) : null;
    if (absolute?.origin === SITE_ORIGIN) return `${siteOrigin}${absolute.pathname}${absolute.search}${absolute.hash}`;
    if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) return href;
    if (href.startsWith("/")) return `${siteOrigin}${href}`;
    const url = new URL(href, `https://repository.invalid/docs/${source.file}`);
    const route = DOC_SOURCES.find((entry) => `/docs/${entry.file}` === url.pathname);
    if (route) return `${siteOrigin}/${route.slug}.md${url.search}${url.hash}`;
    const samplePath = siteSamplePath(url.pathname.slice(1));
    if (samplePath) return `${siteOrigin}${samplePath}${url.search}${url.hash}`;
    const origin = type === "image" ? "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main" : repositoryOrigin;
    return `${origin}${url.pathname}${url.search}${url.hash}`;
  };
  // Raw HTML (screenshot <picture> blocks) ships verbatim, so its relative media URLs
  // would resolve against the .md URL. Screenshots the site serves point at the serving
  // deployment, so previews and releases show their own captures; other files follow
  // the Markdown image rule.
  const resolveHtmlUrl = (url) => {
    if (/^(?:[a-z]+:|\/\/|\/|#)/i.test(url)) return resolveHref(url, "image");
    const { pathname } = new URL(url, `https://repository.invalid/docs/${source.file}`);
    const name = pathname.startsWith("/docs/screenshots/") ? pathname.slice("/docs/screenshots/".length) : null;
    return DOCS_SCREENSHOT_NAMES.includes(name) ? `${siteOrigin}${pathname}` : resolveHref(url, "image");
  };
  const resolveHtmlMedia = (html) =>
    html.replace(/(\s(?:src|srcset|poster)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (match, prefix, double, single) => {
      const quote = double === undefined ? "'" : '"';
      const value = double ?? single;
      const name = prefix.trim().toLowerCase();
      const resolve = (candidate) => (candidate ? resolveHtmlUrl(candidate) : candidate);
      const resolved = name.startsWith("srcset")
        ? value
            .split(",")
            .map((candidate) => {
              const [url = "", ...descriptor] = candidate.trim().split(/\s+/);
              return [resolve(url), ...descriptor].join(" ");
            })
            .join(", ")
        : resolve(value.trim());
      return `${prefix}${quote}${resolved}${quote}`;
    });
  const parser = new Marked();
  const tokens = parser.lexer(markdown);
  const replacements = new Map();
  void parser.walkTokens(tokens, (token) => {
    if (token.type === "link" || token.type === "image") {
      const title = token.title ? ` "${token.title.replaceAll('"', "&quot;")}"` : "";
      replacements.set(
        token.raw,
        `${token.type === "image" ? "!" : ""}[${token.text}](<${resolveHref(token.href, token.type)}>${title})`,
      );
    }
    // Sample commands in code blocks follow the serving origin, like the rendered page.
    // Inline code and prose keep naming the project.
    if (token.type === "code") {
      replacements.set(
        token.raw,
        token.raw.replace(SAMPLE_URL_PATTERN, (_match, name) => `${siteOrigin}/${name}`),
      );
    }
    if (token.type === "html") replacements.set(token.raw, resolveHtmlMedia(token.raw));
    if (token.type === "codespan") replacements.set(token.raw, token.raw);
  });
  // Longest matches MUST consume code samples before any links inside them.
  const patterns = [...replacements.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  const pattern = patterns.map((raw) => raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const body = pattern ? markdown.replace(new RegExp(pattern, "g"), (raw) => replacements.get(raw)) : markdown;
  return `Canonical: ${SITE_ORIGIN}/${source.slug}\n\n${body}`;
}

export function readDocLastmod(file, cwd) {
  try {
    const gitFile = path.isAbsolute(file) ? path.relative(cwd, file) : file;
    const git = (args) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (git(["status", "--porcelain", "--", gitFile])) return null;
    const [commit, timestamp = ""] = git(["log", "-1", "--format=%H%n%ct", "--", gitFile]).split("\n");
    if (!commit) return null;
    if (!/^-?\d+$/.test(timestamp)) return null;
    const shallowPath = path.resolve(cwd, git(["rev-parse", "--git-path", "shallow"]));
    if (fs.existsSync(shallowPath) && fs.readFileSync(shallowPath, "utf8").split("\n").includes(commit)) return null;
    const date = new Date(Number(timestamp) * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

export function writeDocsMarkdown(outputPath, source, sourcePath, siteOrigin) {
  fs.writeFileSync(outputPath, createDocsMarkdown(source, fs.readFileSync(sourcePath, "utf8"), siteOrigin));
}
