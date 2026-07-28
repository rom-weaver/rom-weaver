# Notices

rom-weaver is free and open-source software built with other open-source
projects. This page explains where to find the project license and the complete
attribution inventory for the webapp and command-line releases.

<!-- START doctoc -->
## Table of contents

- [Project license](#project-license)
- [Third-party software](#third-party-software)
- [Generated attribution inventories](#generated-attribution-inventories)
- [Source and corrections](#source-and-corrections)

<!-- END doctoc -->

## Project license

rom-weaver is licensed under the
[GNU Affero General Public License version 3 or later](https://github.com/rom-weaver/rom-weaver/blob/main/LICENSE).
The source code, contribution history, build configuration, and release
artifacts are available in the
[rom-weaver repository](https://github.com/rom-weaver/rom-weaver).

The license text governs your rights and obligations. This page is a convenient
guide to the project’s notices; it does not replace or modify any license.

## Third-party software

The browser app and CLI use open-source components including React, marked,
nod, libarchive, chd-rs, compression libraries, and their transitive
dependencies. Those components remain covered by their own licenses and
copyright notices.

rom-weaver generates its attribution inventories from the dependencies that
actually enter a build. This keeps the published notices aligned with the
release instead of relying on a manually maintained list that can drift.

## Generated attribution inventories

The [webapp attribution inventory](/WEBAPP_NOTICE) lists the packages shipped
with this browser build. The [combined attribution inventory](/NOTICE) also
includes components used by the CLI and shared engine.

Each inventory names the component, version, license identifier, project
source, and the corresponding license or notice files where available. The raw
text format is retained so release tooling, package consumers, and automated
license checks can read the same data shown to people through this page.

## Source and corrections

The attribution generator and dependency policy are maintained in the public
repository. If a component, copyright notice, source URL, or license appears
incorrect, please
[open an issue](https://github.com/rom-weaver/rom-weaver/issues) with the
affected release version and inventory entry.
