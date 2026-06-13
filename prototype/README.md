# loom workbench prototype

Static, dependency-free prototype of the rom-weaver webapp UI ("loom
workbench"). Serve this directory (`python3 -m http.server`) and open
`index.html`; the dock pins scenario/locale/theme switches to the top of the
page and `a11y.js` runs an axe-core sweep across every mode × scenario ×
theme combination.

**Status: ported.** The design system, shell, workflow layouts, dialogs, and
the en/es/de string catalogs were ported into
`packages/rom-weaver-react` (see "Webapp UI — the loom workbench" in
`docs/ARCHITECTURE.md`). The prototype stays as the design reference and a11y
harness; it shares no code with the app, so changes here do not flow into the
webapp.
