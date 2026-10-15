# Documentation rules

Read this reference before changing `docs/`. See [AGENTS.md](../../AGENTS.md#documentation) for the entry point.

`docs/` follows [Diátaxis](https://diataxis.fr/): every page serves exactly one mode, and the folder names the mode.

- **`tutorials/`** - learning. Guided practice runs against supplied sample files, numbered start to finish, ending in verification. Background prose belongs in explanation, linked.
- **`how-to/`** - tasks. Start at the task; each recipe uses only the flags that task needs. No practice-run openers (link the tutorial in one line), no flag-by-flag catalogs (link the reference), no "why" essays (link the explanation).
- **`reference/`** - facts. No advice, no steps, no advocacy. Flag catalogs, tables, exit codes, formats. A troubleshooting or install procedure found here moves to a how-to.
- **`explanation/`** - understanding. No procedures and no UI instructions; pages should be able to say "nothing here is a procedure" truthfully.
- When a section drifts into another mode, move it to the owning page and leave a one-line link both ways - do not duplicate content across pages. The FAQ is a router: answers live on owning pages, the FAQ only links.
- `hosting/` and `development/` are audience folders, with the same mode-per-page discipline applied loosely: a subject-organized page (`vendor-code.md`, `performance.md`) stays whole when splitting by mode would scatter one subject's story.
- Browser guides never contain terminal commands and CLI guides never describe cards or drag handles (`explanation/browser-and-cli.md` promises this).
- **Published slugs never break.** Slugs live in `DOC_SOURCES` (`packages/rom-weaver-webapp/src/webapp/docs-routing.mjs`); a new page is added there (its folder decides its nav shelf), to the `docs/README.md` map, and to `llms.txt` when reader-relevant. Moving a page keeps its slug; retiring a GitHub-served path needs a stub (see `docs/hosting/cli.md`) or a `_redirects` rule.
