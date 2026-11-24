# Webapp masthead metadata

The webapp masthead shows the build version tag and an offline-status icon button, alongside theme, accent, and settings controls. Workflow panel headers show the active worker thread count separately.

<!-- START doctoc -->
## Table of contents

- [Build and thread values](#build-and-thread-values)
- [Runtime values](#runtime-values)
- [Theme](#theme)

<!-- END doctoc -->

## Build and thread values

| Value | Where | Meaning |
| --- | --- | --- |
| `vX.Y.Z` | Masthead build tag | A clean build on the version commit. Selecting it opens **What's new**. |
| `vX.Y.Zb`, `vX.Y.Zd`, `vX.Y.Zn` | Masthead build tag | A beta (`b`), dev (`d`), or nightly (`n`) channel build. |
| `vX.Y.Z+N` | Masthead build tag | A build made `N` commits after that version. `+N` is omitted on the version commit. |
| `vX.Y.Z*` (trailing `*`) | Masthead build tag | Uncommitted changes were present when the build was made. |
| `PR-#N / vX.Y.Z…` | Masthead build tag | A pull-request preview build; selecting it opens the pull request on GitHub. |
| `<N> thread` / `<N> threads` | Workflow panel header | The configured worker thread budget for the active workflow. Selecting it opens **Settings**. |

On stable builds, the build tag's tooltip shows the full build identifier (`vX.Y.Z`, or `vX.Y.Z+[branch.]<sha|dirty.<hash>>` for non-tagged or dirty builds). The **About** panel inside the status dialog lists **Version**, **Commit** (eight-character SHA, with `*` when dirty), **Branch**, **Channel** or **Pull request**, and **Environment** (**Browser tab** or **Installed app (PWA)**).

## Runtime values

The masthead shows an icon-only offline-status button (`StatusChip`) that opens the **Offline app** dialog. Its tooltip and accessible label reflect the current state:

| State (`data-sw`) | Dialog label | Navigation label | Meaning |
| --- | --- | --- | --- |
| `active` | **Offline active** | **Ready** | The service worker controls the page and the offline copy (app, emulator cores, and required or selected databases) is cached. |
| `ready` | **Offline ready** | **Ready** | The offline copy is cached in this browser; the controlling worker state is not yet verified over `MessageChannel`. |
| `update` | **Update available** | **Update** | A newer version finished downloading in the background. Reload to switch to it. |
| `installing` | **Installing app** / **Installing offline copy** | **Downloading** | Caching the app precache or background offline assets. When totals are known, the icon shows a progress ring and percentage. |
| `online` | **Offline copy disabled** | **Disabled** | **Keep an offline copy** is turned off, so automatic offline downloads are paused. |
| `disabled` | **Offline support off** | **Unsupported** | Service-worker offline support is disabled, unavailable in this browser context, or registration failed. |

Before React hydrates, the inline shell resolver in `index.html` resolves the initial icon and state synchronously from `data-service-worker-enabled`, `navigator.serviceWorker.controller`, and cached offline-readiness state so the masthead does not flash on load.

## Theme

The masthead includes separate **Theme** (light, dark, or system) and **Accent** (highlight color) controls. System appearance follows the device preference. Documentation screenshots follow the active theme.

Procedure: [Change browser preferences](../how-to/browser-settings.md#change-preferences).
