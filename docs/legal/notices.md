# Notices

rom-weaver is free and open-source, and it is built from other people's
open-source work. This page says where to find the license for both.

<!-- START doctoc -->
## Table of contents

- [The project license](#the-project-license)
- [Other people's code](#other-peoples-code)
- [The full lists](#the-full-lists)
- [Something looks wrong](#something-looks-wrong)

<!-- END doctoc -->

## The project license

rom-weaver is licensed under the
[GNU Affero General Public License version 3 or later](https://github.com/rom-weaver/rom-weaver/blob/main/LICENSE).
The source code, the full history, the build setup, and the released files all
live in the
[rom-weaver repository](https://github.com/rom-weaver/rom-weaver).

The license text is what actually governs your rights and obligations. This
page is a signpost to it and changes nothing about it.

## Other people's code

The browser app and the command-line tool are built on open-source components:
React, marked, nod, libarchive, chd-rs, several compression libraries, and
everything those depend on in turn. Each of those keeps its own license and
copyright notice.

Those notices are generated from the dependencies that actually go into a
build, rather than typed up by hand. A hand-kept list drifts out of date the
first time somebody adds a dependency and forgets. A generated one cannot.

## The full lists

The [webapp notice file](/WEBAPP_NOTICE) lists everything shipped in this
browser build. The [combined notice file](/NOTICE) adds the components used by
the command-line tool and the shared engine underneath both.

Each entry names the component, its version, its license, where the project
lives, and the license or notice files that came with it. They are plain text,
so release tooling, package managers, and automated license checks read
exactly what you are reading.

## Something looks wrong

The generator and the dependency policy are both in the public repository. If
a component, a copyright line, a source link, or a license looks wrong, please
[open an issue](https://github.com/rom-weaver/rom-weaver/issues) and say which
release version and which entry.

Back to the [guide index](../usage/README.md).
