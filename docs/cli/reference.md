<!-- START doctoc -->
<!-- END doctoc -->

# The CLI reference has moved

It now lives at [docs/reference/cli.md](../reference/cli.md), alongside the
[supported formats](../reference/formats.md) tables.

This stub stays because binaries released before v0.12 print the old path in
their help text, and their crates.io READMEs link to it. Both are immutable,
and GitHub serves repo files with no redirect mechanism, so the file itself has
to keep answering for anyone still running those versions.

Newer builds print `https://rom-weaver.com/docs/cli` instead, which a line in
the webapp's `_redirects` can move.

Remove this stub once no supported release still prints the old path: that is
when the oldest release we support is v0.12 or newer. Deleting it earlier
breaks `--help` output that cannot be changed.

| Looking for | Now at |
| --- | --- |
| Commands, flags, JSON output, exit codes, permissions, completions, man pages | [CLI reference](../reference/cli.md) |
| Installing, verifying a download, Docker | [Install the CLI](../how-to/install-cli.md) |
| A first run with the sample files | [Your first apply in the terminal](../tutorials/cli-first-weave.md) |
| Every documentation page | [Documentation index](../README.md) |
