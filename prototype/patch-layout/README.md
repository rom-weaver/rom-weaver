# patch layout prototype

Static, dependency-free rethink of the apply workflow's ROM + patch cards.
Serve the parent `prototype/` directory (`python3 -m http.server`) and open
`patch-layout/index.html` — fonts and the logo are shared from
`../assets`. It shares no code with the app; nothing here flows into
`packages/rom-weaver-react`.

## The ideas on trial

- **No drawers — every value on the table.** The collapsible Extract/Checks
  drawers are gone; each card carries one always-visible in/out "ledger":
  label column shared, *expects (input)* and *produces (output)* aligned per
  algorithm (crc32 / md5 / sha-1 / bytes). A `—` cell is honest — the patch
  doesn't declare that check — and clicking it adds a user-expected value.
- **Provenance per value:** `°` built into the patch file (read-only),
  `✎` added by the user (removable).
- **Verified ROM identity band** (future field): database match — proper
  title, region, revision, serial, release — as a stitched sage band on the
  ROM card. ROM checksums render one ledger column per variant
  (as dropped / header stripped) with the match mark on the variant that hit
  the database.
- **Version + author** are first-class patch metadata on the byline under
  the display name.
- **One edit control:** a single pencil opens one form for
  name · version · author · description; Done commits all four
  (replaces the current two-pencil name/description editors).
- **Endpoint chips** carry the chain semantics (`chain input · verifies the
  ROM`, `chain output · sets the expected result`, `mid-chain · recorded
  only`), and an "expected result" stub card fed by the chain-output checks
  closes the patch list. (An earlier draft drew a decorative chain rail down
  the left; dropped — the chips do the work without the width.)

## In the page

- Main flow: verified ROM, three patches (rich / sparse / chain-output),
  expected-result stub.
- `0x0F` gallery: failed validation, skipped, and staging states in the same
  layout.
- Working toggles: theme, Notes (numbered design annotations), the single
  edit form, include/skip switches, click-to-copy, add/remove user checks.
- Accessibility: axe-core clean (0 violations) across all 4 variants × both
  themes at 390px and 1440px, plus notes mode and the open edit form. Run it
  yourself from the console: load `../assets/axe.min.js`, `await axe.run()`.
  Light theme steps grey small-text down to `--ink-2` on tinted surfaces;
  the narrow masthead keeps the h1 and button names in the accessibility
  tree; the table variant's scroll region is focusable and labeled.
- **Four desktop layout candidates** behind the masthead switcher
  (persisted; default Stack):
  - **Stack** — compact single column: the filename joins the name line and
    the plan line (target · header · endpoint chip · verdict) docks onto the
    ledger as its header bar; page narrows to 1000px.
  - **Hug** — same compact identity, but the ledger only takes the width its
    values need; a sparse patch's checks are a sliver, not a full-width
    table of dashes.
  - **Split** — identity column left, ledger right (kept for comparison).
  - **Table** — the whole patch list as ONE ledger: two rows (in/out) per
    patch, identity in the leading cell, the failed/skipped/staging states
    as extra rows, the expected result as the footer. Layout study only —
    switches/editing omitted there.
- Phones are aggressively height-first (Stack is the lead candidate and got
  the deep pass):
  - The controls (grip · switch · pencil · remove) take a slim leading row
    of their own instead of reserving a full-height right column — the name
    and everything after it get the card's full width below.
  - Name, filename, and byline read as one wrapped run; the source line
    drops its leaf (it IS the filename) everywhere.
  - Ledger: short pairs (crc32, bytes) keep the one-line
    `label | in | out` shape; only long values (md5, sha-1) stack
    in-over-out; rows with NO declared values fold into one
    `not declared: +md5 +sha-1` chip row — tapping a chip reveals that row
    for adding. A JS classifier re-keys all of this on add/remove.
  - The provenance legend hides on phones (the marks carry titles).
  - Hash sizing uses the app's cqi clamp trick, keyed to a 40-char sha-1
    plus the worst-case mark cluster so values never clip.
