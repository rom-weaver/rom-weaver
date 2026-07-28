# Webapp masthead metadata

The webapp masthead shows build identity, the configured thread count, and two
independent runtime facts in one text row.

<!-- START doctoc -->
## Table of contents

- [Build and thread values](#build-and-thread-values)
- [Runtime values](#runtime-values)

<!-- END doctoc -->

## Build and thread values

| Value | Meaning |
| --- | --- |
| `v0.9.0` | The application version. |
| `cfa57e6` (`sha`) | The seven-character commit identifier for a clean build. |
| `cfa57e6*` (`sha*`) | A seven-character dirty-build fingerprint; `*` means uncommitted changes were present when the build was made. |
| `10 threads` | The full thread-count label shown on desktop. |
| `10T` | The compact mobile thread-count label; `T` means threads. |

The version text normally looks like `v0.9.0 · cfa57e6`. The full build
identifier, including a branch or dirty-build suffix when applicable, is
available from the version tooltip.

## Runtime values

| Value | Meaning |
| --- | --- |
| `web` | The page is running in a normal browser tab or window. |
| `pwa` | The page was launched as an installed/standalone PWA. A PWA can also use a service worker. |
| `sw` | The service worker controls the page and its offline-cache handshake succeeded. |
| `sw ok` | A service worker is registered and available, but control or offline-cache readiness is not fully confirmed yet. |
| `sw off` | Service-worker offline support is disabled, unavailable, or registration failed. |

The first value describes how the page was launched; the second describes
service-worker state. The combinations are therefore independent, such as
`web · sw`, `pwa · sw ok`, or `pwa · sw off`. The prerendered shell resolves
known runtime state before first paint, then React hydrates that shell in place
instead of replacing the masthead nodes. The text stays empty only while
service-worker state is unknown.

The thread count is shown as `· 10 threads` on desktop and `· 10T` on mobile
to preserve masthead space. The full wording remains available to assistive
technology and in the tooltip.
