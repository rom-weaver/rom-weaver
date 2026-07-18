#!/usr/bin/env bash
set -euo pipefail

MSG_FILE="${1:?commit message file required}"

if [ ! -f "$MSG_FILE" ]; then
  echo "commit message file not found: $MSG_FILE" >&2
  exit 1
fi

awk '
  /^(Co-[Aa]uthored-[Bb]y|Co-committed-by):[[:space:]]*(Claude|Codex|Copilot|Cursor|Devin|Gemini|ChatGPT|GPT-)/ { next }
  /^(🤖 )?Generated with \[?(Claude Code|Codex|Cursor)/ { next }
  /^[[:space:]]*$/ { blanks = blanks "\n"; next }
  { printf "%s%s\n", blanks, $0; blanks = "" }
' "$MSG_FILE" > "$MSG_FILE.stripped"

mv "$MSG_FILE.stripped" "$MSG_FILE"
