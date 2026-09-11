import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Marked } from "marked";
import { DOC_SOURCES, SITE_ORIGIN } from "../src/webapp/docs-routing.mjs";

const repositoryOrigin = "https://github.com/rom-weaver/rom-weaver/blob/main";

export function createDocsMarkdown(source, markdown) {
  const resolveHref = (href) => {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) return href;
    if (href.startsWith("/")) return `${SITE_ORIGIN}${href}`;
    const url = new URL(href, `https://repository.invalid/docs/${source.file}`);
    const route = DOC_SOURCES.find((entry) => `/docs/${entry.file}` === url.pathname);
    if (route) return `${SITE_ORIGIN}/${route.slug}.md${url.search}${url.hash}`;
    return `${repositoryOrigin}${url.pathname}${url.search}${url.hash}`;
  };
  const parser = new Marked();
  const tokens = parser.lexer(markdown);
  const replacements = new Map();
  void parser.walkTokens(tokens, (token) => {
    if (token.type === "link" || token.type === "image") {
      const title = token.title ? ` "${token.title.replaceAll('"', "&quot;")}"` : "";
      replacements.set(
        token.raw,
        `${token.type === "image" ? "!" : ""}[${token.text}](<${resolveHref(token.href)}>${title})`,
      );
    }
    if (["code", "codespan", "html"].includes(token.type)) replacements.set(token.raw, token.raw);
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

export function writeDocsMarkdown(outputPath, source, sourcePath) {
  fs.writeFileSync(outputPath, createDocsMarkdown(source, fs.readFileSync(sourcePath, "utf8")));
}
