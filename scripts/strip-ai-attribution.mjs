#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CREDIT = /^(Co-[Aa]uthored-[Bb]y|Co-committed-by):\s*(Claude|Codex|Copilot|Cursor|Devin|Gemini|ChatGPT|GPT-)/;
const GENERATED = /^(?:🤖 )?Generated with \[?(Claude Code|Codex|Cursor)/;

export function stripAiAttribution(text) {
  const output = [];
  let blanks = "";
  for (const line of text.split(/\r?\n/)) {
    if (CREDIT.test(line) || GENERATED.test(line)) continue;
    if (!line.trim()) {
      blanks += "\n";
      continue;
    }
    output.push(`${blanks}${line}`);
    blanks = "";
  }
  return output.length ? `${output.join("\n")}\n` : "";
}

export function main(argv = process.argv.slice(2)) {
  const file = argv[0];
  if (!file) {
    process.stderr.write("commit message file required\n");
    return 2;
  }
  try {
    const text = readFileSync(file, "utf8");
    const temp = `${file}.stripped`;
    writeFileSync(temp, stripAiAttribution(text));
    renameSync(temp, file);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
