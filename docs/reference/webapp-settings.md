# Webapp settings

Every setting in the browser app's Settings panel, with its values and its
default. Settings are stored in your browser's local storage under
`rom-weaver-settings` and are never sent anywhere.

<!-- START doctoc -->
## Table of contents

- [Output](#output)
- [Apply behaviour](#apply-behaviour)
- [Beta tools and onboarding](#beta-tools-and-onboarding)
- [Appearance and language](#appearance-and-language)
- [Logging](#logging)
- [Compression](#compression)

<!-- END doctoc -->

## Output

| Setting | Values | Default |
| --- | --- | --- |
| Type | `.7z or ROM specific`, `.zip or ROM specific`, `ROM specific only`, `.7z only`, `.zip only`, `None` | `.zip or ROM specific` |
| Bundle | `Hide bundle creation`, `Bundle + patches (.zip)`, `Bundle + ROM + patches (.zip)`, `Bundle + patches (.7z)`, `Bundle + ROM + patches (.7z)` | `Hide bundle creation` |

**Type** is the compression offered by default for a workflow's output.
`ROM specific` means a format made for the platform, such as Z3DS, CHD, or RVZ,
when one applies.

**Bundle** chooses which bundle download is shown by default when applying a
ROM hack.

## Apply behaviour

| Setting | Values | Default |
| --- | --- | --- |
| After applying | `auto-download`, `auto-test`, `auto-test-download`, `none` | `auto-download` |
| Show the test button after applying | on, off | on |
| Fix ROM header | on, off | off |
| Require input checksum match | on, off | on |

**Fix ROM header** repairs supported internal checksums and compatibility
header fields after patching.

**Require input checksum match** stops a run when the input ROM's checksum does
not match what the patch or bundle expects. Turning it off allows the run.

## Beta tools and onboarding

| Setting | Values | Default |
| --- | --- | --- |
| Enable beta tools (Trim and Tools) | on, off | off |
| Show the "New here?" quick-start tips | on, off | on |

With beta tools off, the **Trim** and **Tools** tabs are hidden, and their URLs
(`/trim` and `/tools`) fall back to Apply.

## Appearance and language

| Setting | Values | Default |
| --- | --- | --- |
| Accent | the accent names listed in the picker | set by the build channel |
| Language | `English`, `Deutsch`, `Español` | the closest match to your browser's language, otherwise English |

The build channel picks the starting accent, so nightly and beta look distinct
from production. Choosing an accent overrides that permanently.

The language list holds one entry per shipped message catalog. A translation
that does not ship has no entry. Adding one is covered in
[Translate rom-weaver](../../CONTRIBUTING.md#translate-rom-weaver).

Light and dark themes are chosen from the masthead control, not from this
panel.

## Logging

| Setting | Values | Default |
| --- | --- | --- |
| Log level | `off`, `error`, `warn`, `info`, `debug`, `trace` | `trace` in development, `warn` otherwise |

`debug` and `trace` include detailed workflow progress.

## Compression

| Setting | Values | Default |
| --- | --- | --- |
| Level | a slider over `Min`, `Very Low`, `Low`, `Medium`, `High`, `Very High`, `Max` | `Max` |
| CD Codecs | the CHD CD codec names, each with an optional `:level` | the generated CHD CD default |
| DVD Codecs | the CHD DVD codec names, each with an optional `:level` | the generated CHD DVD default |
| RVZ codec | one codec name, with an optional `:level` | the generated RVZ default |
| RVZ block size | 1 to 2147483647 | the generated RVZ default |
| 7z codec | one codec name, with an optional `:level` | the generated 7z default |
| ZIP codec | `store`, `deflate`, or `zstd`, with an optional `:level` on the last two | the generated ZIP default |
| Threads | `auto`, or 0 to 64 | `auto` |

The panel prints each field's accepted codec names and level ranges beneath it,
generated from the same tables as the CLI. The authoritative list is
[create-time codecs](formats.md#create-time-codecs).

Fields are disabled when the **Type** setting cannot reach them: the CHD and
RVZ fields need a `ROM specific` type, the 7z field needs a `.7z` type, and the
ZIP field needs a `.zip` type.

**Threads** is `auto` or `1` when the browser cannot run threaded WebAssembly.
Where it can, `0` disables threaded bundles.
