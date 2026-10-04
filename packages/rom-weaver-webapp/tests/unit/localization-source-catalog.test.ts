import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatter } from "@lingui/format-po";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

/**
 * Source messages as `messages.ts` writes them. The file is oxfmt-formatted, so
 * every call is `msg({ id: "...", message: "..." })`, on one line or split
 * across lines, with a single-quoted message where the text holds double
 * quotes. Calls this pattern misses are counted, not skipped, so a new shape
 * fails the test instead of quietly escaping it.
 */
const STRING = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const MESSAGE_CALL = new RegExp(String.raw`\bmsg\(\{\s*id: (${STRING}),\s*message:\s*(${STRING}),?\s*\}\)`, "gu");

/** A JS string literal's value; a single-quoted one is rewritten as JSON first. */
const literalValue = (literal: string) =>
  JSON.parse(
    literal.startsWith("'") ? `"${literal.slice(1, -1).replaceAll("\\'", "'").replaceAll('"', '\\"')}"` : literal,
  ) as string;

const readSourceMessages = () => {
  const source = read("../../src/presentation/localization/messages.ts");
  const calls = source.match(/\bmsg\(\{/gu)?.length ?? 0;
  const messages = new Map<string, string>();
  for (const match of source.matchAll(MESSAGE_CALL)) {
    messages.set(literalValue(match[1] as string), literalValue(match[2] as string));
  }
  return { calls, messages };
};

const readEnglishCatalog = async () => {
  const catalog = await formatter({ lineNumbers: false }).parse(
    read("../../src/presentation/localization/locales/en.po"),
    {
      filename: "en.po",
      locale: "en",
      sourceLocale: "en",
    },
  );
  return catalog ?? {};
};

describe("English source catalog", () => {
  it("reads every message call in messages.ts", () => {
    const { calls, messages } = readSourceMessages();
    expect(calls).toBeGreaterThan(0);
    expect(messages.size).toBe(calls);
  });

  // `en.po` is what ships: the app renders compiled catalogs, never messages.ts.
  // `lingui extract` keeps an existing English translation unless it runs with
  // --overwrite, so rewording a message without that flag leaves the old copy
  // live while the source reads as fixed.
  it("ships each English message as messages.ts writes it", async () => {
    const { messages } = readSourceMessages();
    const catalog = await readEnglishCatalog();
    const stale = [...messages]
      .filter(([id, message]) => catalog[id]?.translation !== message)
      .map(([id, message]) => ({ catalog: catalog[id]?.translation, id, source: message }));
    expect(stale).toEqual([]);
  });
});
